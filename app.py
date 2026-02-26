"""
OpenClaw Orchestra
Universal control plane for OpenClaw agents.
Works with any OpenClaw instance — no Proxmox required.
"""

import asyncio
import json
import logging
import queue
import shlex
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Logging + App
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orchestra")

app = FastAPI(title="OpenClaw Orchestra", description="Universal OpenClaw fleet management", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ConnectionType(str, Enum):
    http_only   = "http_only"    # Status only — no SSH controls
    direct_ssh  = "direct_ssh"   # SSH directly to the agent's host
    proxmox_lxc = "proxmox_lxc" # SSH to Proxmox host, then pct exec
    docker      = "docker"       # SSH to Docker host, then docker exec

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class AgentRecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    # Identity
    name: str
    emoji: str = "🤖"
    description: str = ""
    group: str = "default"
    # Gateway
    host: str
    port: int = 18789
    gateway_token: Optional[str] = None
    # Connection
    connection_type: ConnectionType = ConnectionType.http_only
    ssh_host: Optional[str] = None       # defaults to host
    ssh_port: int = 22
    ssh_username: str = "root"
    ssh_password: Optional[str] = None
    # Proxmox-specific
    proxmox_vmid: Optional[int] = None
    # Docker-specific
    docker_container: Optional[str] = None
    # Meta
    added_at: float = Field(default_factory=time.time)
    notes: str = ""


class AgentStatusData(BaseModel):
    id: str
    online: bool = False
    service_ok: bool = False
    headline: str = "Checking…"
    activity: str = "Waiting…"
    uptime_human: Optional[str] = None
    last_checked: float = 0.0
    response_ms: Optional[float] = None
    recent_logs: List[str] = []
    openclaw_version: Optional[str] = None
    error: Optional[str] = None


class ControlRequest(BaseModel):
    action: str    # start | stop | restart | repair | update
    ssh_password: Optional[str] = None


class BulkRequest(BaseModel):
    action: str    # restart_all | stop_all | start_all
    group: Optional[str] = None    # limit to group (None = all)


# ---------------------------------------------------------------------------
# Persistent storage
# ---------------------------------------------------------------------------
DATA_DIR  = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
AGENTS_FILE = DATA_DIR / "agents.json"
DB_FILE     = DATA_DIR / "history.db"


def _load_agents() -> Dict[str, AgentRecord]:
    if not AGENTS_FILE.exists():
        return {}
    try:
        raw = json.loads(AGENTS_FILE.read_text())
        return {k: AgentRecord(**v) for k, v in raw.items()}
    except Exception as exc:
        log.error("Failed to load agents: %s", exc)
        return {}


def _save_agents(agents: Dict[str, AgentRecord]):
    AGENTS_FILE.write_text(json.dumps({k: v.model_dump() for k, v in agents.items()}, indent=2))


# ---------------------------------------------------------------------------
# History (SQLite — built into Python, no extra dependency)
# ---------------------------------------------------------------------------

def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE))
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id   TEXT    NOT NULL,
                checked_at REAL    NOT NULL,
                online     INTEGER NOT NULL,
                response_ms REAL
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_agent ON history(agent_id, checked_at)")
    log.info("History DB ready")


def _store_history(agent_id: str, online: bool, response_ms: Optional[float]):
    with _db() as conn:
        conn.execute(
            "INSERT INTO history (agent_id, checked_at, online, response_ms) VALUES (?,?,?,?)",
            (agent_id, time.time(), int(online), response_ms),
        )
        # Keep last 48 per agent
        conn.execute("""
            DELETE FROM history WHERE id IN (
                SELECT id FROM history WHERE agent_id=?
                ORDER BY checked_at DESC LIMIT -1 OFFSET 48)""",
            (agent_id,),
        )


def get_history(agent_id: str, n: int = 24) -> List[dict]:
    with _db() as conn:
        rows = conn.execute(
            "SELECT checked_at, online, response_ms FROM history "
            "WHERE agent_id=? ORDER BY checked_at DESC LIMIT ?",
            (agent_id, n),
        ).fetchall()
    return [{"t": r["checked_at"], "online": bool(r["online"]), "ms": r["response_ms"]}
            for r in reversed(rows)]


_init_db()

# ---------------------------------------------------------------------------
# HTTP ping
# ---------------------------------------------------------------------------

def _http_ping(host: str, port: int, token: Optional[str] = None) -> tuple:
    """Returns (online: bool, response_ms: float | None)."""
    import urllib.request
    t0 = time.time()
    try:
        req = urllib.request.Request(f"http://{host}:{port}/", method="GET")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as exc:
            # Any HTTP error (401/403/404) means gateway is up
            if hasattr(exc, "code") and exc.code < 500:
                return True, round((time.time() - t0) * 1000, 1)
            raise
        return True, round((time.time() - t0) * 1000, 1)
    except Exception:
        return False, None

# ---------------------------------------------------------------------------
# SSH execution
# ---------------------------------------------------------------------------

def _ssh_run(agent: AgentRecord, command: str,
             password: Optional[str] = None, timeout: int = 30) -> str:
    """
    Run a command on the agent's host via SSH.
    Handles direct SSH, Proxmox pct exec, and Docker exec transparently.
    """
    import paramiko
    pw = password or agent.ssh_password
    if not pw:
        raise RuntimeError("SSH password not set for this agent")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh_host = agent.ssh_host or agent.host

    try:
        ssh.connect(ssh_host, port=agent.ssh_port, username=agent.ssh_username,
                    password=pw, timeout=15, banner_timeout=30)

        # Wrap command for container connection types
        if agent.connection_type == ConnectionType.proxmox_lxc and agent.proxmox_vmid:
            command = f"pct exec {agent.proxmox_vmid} -- bash -c {shlex.quote(command)}"
        elif agent.connection_type == ConnectionType.docker and agent.docker_container:
            command = f"docker exec {shlex.quote(agent.docker_container)} bash -c {shlex.quote(command)}"

        _, stdout, _ = ssh.exec_command(command, timeout=timeout)
        out = stdout.read().decode(errors="replace")
        return out
    finally:
        try:
            ssh.close()
        except Exception:
            pass


def _ssh_stream(agent: AgentRecord, command: str,
                log_fn, password: Optional[str] = None, timeout: int = 400):
    """Run a command via SSH and stream output line by line to log_fn."""
    import paramiko
    pw = password or agent.ssh_password

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh_host = agent.ssh_host or agent.host

    try:
        ssh.connect(ssh_host, port=agent.ssh_port, username=agent.ssh_username,
                    password=pw, timeout=15, banner_timeout=30)

        if agent.connection_type == ConnectionType.proxmox_lxc and agent.proxmox_vmid:
            command = f"pct exec {agent.proxmox_vmid} -- bash -c {shlex.quote(command)}"
        elif agent.connection_type == ConnectionType.docker and agent.docker_container:
            command = f"docker exec {shlex.quote(agent.docker_container)} bash -c {shlex.quote(command)}"

        _, stdout, _ = ssh.exec_command(command, timeout=timeout, get_pty=True)
        for line in iter(stdout.readline, ""):
            if line.strip():
                log_fn(line.rstrip())
        return stdout.channel.recv_exit_status()
    finally:
        try:
            ssh.close()
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Status check
# ---------------------------------------------------------------------------

def _check_status(agent: AgentRecord) -> AgentStatusData:
    s = AgentStatusData(id=agent.id, last_checked=time.time())

    # 1. HTTP ping
    online, ms = _http_ping(agent.host, agent.port, agent.gateway_token)
    s.online = online
    s.response_ms = ms

    if not online:
        s.headline = "Offline — not responding"
        s.activity  = "Cannot reach this agent"
        _store_history(agent.id, False, None)
        return s

    _store_history(agent.id, True, ms)

    # 2. SSH for richer info (optional)
    has_ssh = agent.connection_type != ConnectionType.http_only and agent.ssh_password
    if has_ssh:
        try:
            svc = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null").strip()
            s.service_ok = svc == "active"

            ts_raw = _ssh_run(agent,
                "systemctl show openclaw --property=ActiveEnterTimestamp --value 2>/dev/null").strip()
            s.uptime_human = _human_uptime(ts_raw)

            log_raw = _ssh_run(agent,
                "journalctl -u openclaw -n 40 --no-pager --output=cat 2>/dev/null", timeout=15)
            s.recent_logs = [l for l in log_raw.splitlines() if l.strip()][-40:]
            s.activity    = _parse_activity(s.recent_logs)

            ver = _ssh_run(agent, "openclaw --version 2>/dev/null").strip()
            if ver:
                s.openclaw_version = ver

        except Exception as exc:
            log.debug("SSH check failed for %s: %s", agent.id, exc)

    up = f" · Up {s.uptime_human}" if s.uptime_human else ""
    s.headline = f"Online{up}" if s.service_ok or not has_ssh else "Online — service starting"
    return s


def _human_uptime(ts_raw: str) -> Optional[str]:
    if not ts_raw or ts_raw.strip() in ("", "n/a"):
        return None
    try:
        parts = ts_raw.strip().split()
        dt_str = " ".join(parts[-3:])
        dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
        secs = int((datetime.now(timezone.utc) - dt).total_seconds())
        if secs < 60:    return f"{secs}s"
        if secs < 3600:  return f"{secs // 60}m"
        if secs < 86400: return f"{secs // 3600}h {(secs % 3600) // 60}m"
        return f"{secs // 86400}d {(secs % 86400) // 3600}h"
    except Exception:
        return None


def _parse_activity(logs: List[str]) -> str:
    checks = [
        ("sending",   "Sent a reply"),
        ("response",  "Sent a reply"),
        ("tool",      "Used a tool"),
        ("heartbeat", "Running scheduled checks"),
        ("cron",      "Running a scheduled task"),
        ("connected", "Connected and ready"),
        ("session",   "Active conversation"),
        ("channel",   "Handling a channel event"),
        ("error",     "Encountered an issue — check logs"),
        ("warn",      "Something needs attention"),
    ]
    for line in reversed(logs):
        ll = line.lower()
        for kw, label in checks:
            if kw in ll:
                return label
    return "Idle — waiting for messages"

# ---------------------------------------------------------------------------
# Background status poller
# ---------------------------------------------------------------------------

_agent_statuses: Dict[str, AgentStatusData] = {}
_ws_listeners: List[queue.Queue] = []
_POLL_INTERVAL = 30


def _broadcast(msg: dict):
    for q in _ws_listeners:
        q.put(msg)


def _refresh_one(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        return
    s = _check_status(agents[agent_id])
    _agent_statuses[agent_id] = s
    _broadcast({"type": "update", "id": agent_id, "status": s.model_dump()})


def _poll_loop():
    while True:
        try:
            for aid in list(_load_agents().keys()):
                _refresh_one(aid)
        except Exception as exc:
            log.error("Poller: %s", exc)
        time.sleep(_POLL_INTERVAL)


threading.Thread(target=_poll_loop, daemon=True).start()

# ---------------------------------------------------------------------------
# Job store (for control action log streaming)
# ---------------------------------------------------------------------------

_jobs: Dict[str, dict] = {}
_job_queues: Dict[str, queue.Queue] = {}


def _job_create() -> str:
    jid = str(uuid.uuid4())
    _jobs[jid] = {"status": "pending", "error": None}
    _job_queues[jid] = queue.Queue()
    return jid


def _job_update(jid: str, status: str, error: Optional[str] = None):
    if jid in _jobs:
        _jobs[jid]["status"] = status
        _jobs[jid]["error"]  = error


def _job_log(jid: str, msg: str, level: str = "info"):
    if jid in _job_queues:
        _job_queues[jid].put({
            "timestamp": datetime.now().strftime("%H:%M:%S"),
            "level": level,
            "message": msg,
        })

# ---------------------------------------------------------------------------
# CRUD routes
# ---------------------------------------------------------------------------

@app.get("/api/agents")
async def list_agents():
    agents = _load_agents()
    result = []
    for aid, agent in agents.items():
        s = _agent_statuses.get(aid)
        hist = get_history(aid, 24)
        result.append({
            **agent.model_dump(exclude={"ssh_password", "gateway_token"}),
            "has_ssh_password": bool(agent.ssh_password),
            "has_gateway_token": bool(agent.gateway_token),
            "status": s.model_dump() if s else None,
            "sparkline": [{"online": h["online"]} for h in hist],
        })
    return result


@app.post("/api/agents")
async def add_agent(agent: AgentRecord):
    agents = _load_agents()
    if not agent.id:
        agent.id = str(uuid.uuid4())
    agents[agent.id] = agent
    _save_agents(agents)
    threading.Thread(target=_refresh_one, args=(agent.id,), daemon=True).start()
    return {"id": agent.id}


@app.get("/api/agents/{agent_id}")
async def get_agent(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404, "Agent not found")
    agent = agents[agent_id]
    s     = _agent_statuses.get(agent_id)
    hist  = get_history(agent_id, 48)
    return {
        **agent.model_dump(exclude={"ssh_password", "gateway_token"}),
        "has_ssh_password": bool(agent.ssh_password),
        "has_gateway_token": bool(agent.gateway_token),
        "status": s.model_dump() if s else None,
        "sparkline": [{"online": h["online"]} for h in hist],
    }


@app.put("/api/agents/{agent_id}")
async def update_agent(agent_id: str, agent: AgentRecord):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404, "Agent not found")
    agent.id = agent_id
    # Preserve stored secrets if not re-sent
    if not agent.ssh_password:
        agent.ssh_password = agents[agent_id].ssh_password
    if not agent.gateway_token:
        agent.gateway_token = agents[agent_id].gateway_token
    agents[agent_id] = agent
    _save_agents(agents)
    return {"ok": True}


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404, "Agent not found")
    del agents[agent_id]
    _save_agents(agents)
    _agent_statuses.pop(agent_id, None)
    return {"ok": True}


@app.post("/api/agents/{agent_id}/refresh")
async def refresh_agent(agent_id: str, background_tasks: BackgroundTasks):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404, "Agent not found")
    background_tasks.add_task(_refresh_one, agent_id)
    return {"ok": True}


@app.get("/api/agents/{agent_id}/history")
async def agent_history(agent_id: str, n: int = 48):
    return get_history(agent_id, n)


@app.get("/api/agents/{agent_id}/logs")
async def agent_logs(agent_id: str, lines: int = 80):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        return {"logs": [], "error": "SSH not configured for this agent"}
    try:
        raw   = _ssh_run(agent, f"journalctl -u openclaw -n {lines} --no-pager --output=short 2>/dev/null")
        return {"logs": [l for l in raw.splitlines() if l.strip()]}
    except Exception as exc:
        return {"logs": [], "error": str(exc)}


@app.get("/api/agents/{agent_id}/config")
async def agent_config(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        return {"config": None, "error": "SSH not configured"}
    try:
        raw = _ssh_run(agent,
            "cat /home/openclaw/.openclaw/openclaw.json 2>/dev/null "
            "|| cat ~/.openclaw/openclaw.json 2>/dev/null "
            "|| echo '{}'")
        try:
            return {"config": json.loads(raw)}
        except Exception:
            return {"config": None, "raw": raw, "error": "Could not parse config as JSON"}
    except Exception as exc:
        return {"config": None, "error": str(exc)}

# ---------------------------------------------------------------------------
# Control actions
# ---------------------------------------------------------------------------

@app.post("/api/agents/{agent_id}/control")
async def control_agent(agent_id: str, req: ControlRequest, background_tasks: BackgroundTasks):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404, "Agent not found")
    if req.action not in ("start", "stop", "restart", "repair", "update"):
        raise HTTPException(400, f"Unknown action: {req.action}")

    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        raise HTTPException(400, "SSH controls not available — connection type is HTTP-only")

    pw = agent.ssh_password or req.ssh_password
    if not pw:
        raise HTTPException(400, "SSH password required")

    jid = _job_create()
    background_tasks.add_task(_run_control, jid, agent, req.action, pw)
    return {"job_id": jid}


@app.post("/api/bulk")
async def bulk_action(req: BulkRequest, background_tasks: BackgroundTasks):
    agents  = _load_agents()
    targets = {
        aid: a for aid, a in agents.items()
        if a.connection_type != ConnectionType.http_only
        and a.ssh_password
        and (req.group is None or a.group == req.group)
    }
    if not targets:
        raise HTTPException(400, "No agents with SSH controls in scope")

    jid = _job_create()
    action_map = {
        "restart_all": "restart",
        "stop_all":    "stop",
        "start_all":   "start",
    }
    act = action_map.get(req.action)
    if not act:
        raise HTTPException(400, f"Unknown bulk action: {req.action}")

    background_tasks.add_task(_run_bulk, jid, list(targets.values()), act)
    return {"job_id": jid, "count": len(targets)}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    if job_id not in _jobs:
        raise HTTPException(404)
    return _jobs[job_id]


@app.websocket("/ws/jobs/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str):
    await websocket.accept()
    if job_id not in _job_queues:
        await websocket.send_json({"level": "error", "message": "Job not found"})
        await websocket.close()
        return
    q = _job_queues[job_id]
    try:
        while True:
            while not q.empty():
                await websocket.send_json(q.get_nowait())
            job = _jobs.get(job_id, {})
            if job.get("status") in ("success", "failed"):
                while not q.empty():
                    await websocket.send_json(q.get_nowait())
                await websocket.send_json({
                    "level": "status",
                    "status": job["status"],
                    "error": job.get("error"),
                })
                break
            await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        pass

# ---------------------------------------------------------------------------
# WebSocket: live status stream
# ---------------------------------------------------------------------------

@app.websocket("/ws/status")
async def ws_status(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({
        "type": "snapshot",
        "statuses": {k: v.model_dump() for k, v in _agent_statuses.items()},
    })
    q: queue.Queue = queue.Queue()
    _ws_listeners.append(q)
    try:
        while True:
            while not q.empty():
                await websocket.send_json(q.get_nowait())
            await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        pass
    finally:
        if q in _ws_listeners:
            _ws_listeners.remove(q)

# ---------------------------------------------------------------------------
# Control engine
# ---------------------------------------------------------------------------

def _run_control(jid: str, agent: AgentRecord, action: str, password: str):
    def info(m): _job_log(jid, m, "info")
    def ok(m):   _job_log(jid, m, "success")
    def warn(m): _job_log(jid, m, "warn")
    def err(m):  _job_log(jid, m, "error")

    try:
        _job_update(jid, "running")
        labels = {"start":"Starting","stop":"Stopping","restart":"Restarting",
                  "repair":"Repairing","update":"Updating"}
        info(f"🎼  {labels[action]} {agent.emoji} {agent.name}…")

        if action == "repair":
            _do_repair(agent, password, info, ok, warn, err)
        elif action == "update":
            _do_update(agent, password, info, ok, warn, err)
        else:
            cmds = {"start":"systemctl start openclaw",
                    "stop": "systemctl stop openclaw",
                    "restart":"systemctl restart openclaw"}
            _ssh_run(agent, cmds[action], password=password, timeout=30)
            time.sleep(3)
            svc = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null",
                           password=password).strip()
            if action == "stop":
                ok(f"✅  {agent.name} has been stopped")
            elif svc == "active":
                ok(f"✅  {agent.name} is running")
            else:
                warn(f"⚠️  Service status: {svc}")

        _job_update(jid, "success")
        time.sleep(2)
        _refresh_one(agent.id)
    except Exception as exc:
        err(f"❌  {exc}")
        _job_update(jid, "failed", str(exc))


def _do_repair(agent, password, info, ok, warn, err):
    info("🔍  Checking OpenClaw installation…")
    which = _ssh_run(agent, "which openclaw 2>/dev/null", password=password).strip()
    if not which:
        warn("   OpenClaw not found — reinstalling…")
        _ssh_run(agent, "npm install -g openclaw@latest 2>&1", password=password, timeout=600)
        ok("   ✅  OpenClaw reinstalled")
    else:
        ok(f"   ✅  OpenClaw found: {which}")

    svc = _ssh_run(agent, "systemctl cat openclaw 2>/dev/null | head -1", password=password).strip()
    if not svc:
        warn("   Service file missing — writing it now…")
        svc_content = (
            "[Unit]\\nDescription=OpenClaw Gateway\\nAfter=network.target\\n\\n"
            "[Service]\\nType=simple\\nUser=openclaw\\nWorkingDirectory=/home/openclaw\\n"
            "EnvironmentFile=/home/openclaw/.openclaw/.env\\n"
            "ExecStart=/usr/bin/openclaw gateway\\nRestart=always\\nRestartSec=10\\n\\n"
            "[Install]\\nWantedBy=multi-user.target"
        )
        _ssh_run(agent, f"printf '{svc_content}' > /etc/systemd/system/openclaw.service",
                 password=password)

    env = _ssh_run(agent, "test -f /home/openclaw/.openclaw/.env && echo yes 2>/dev/null",
                   password=password).strip()
    ok("   ✅  Environment file present") if env == "yes" else warn(
        "   ⚠️  No .env file — API key may be missing")

    info("   Reloading and starting service…")
    _ssh_run(agent, "systemctl daemon-reload && systemctl enable openclaw && systemctl start openclaw",
             password=password, timeout=30)
    time.sleep(4)
    final = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null", password=password).strip()
    ok(f"\n✅  {agent.name} is healthy!") if final == "active" else warn(
        f"\n⚠️  Status: {final} — check logs for clues")


def _do_update(agent, password, info, ok, warn, err):
    info("⬆️   Checking current version…")
    before = _ssh_run(agent, "openclaw --version 2>/dev/null", password=password).strip()
    info(f"   Current: {before or 'unknown'}")
    info("   Installing latest OpenClaw…")
    _ssh_run(agent, "npm install -g openclaw@latest 2>&1", password=password, timeout=600)
    after = _ssh_run(agent, "openclaw --version 2>/dev/null", password=password).strip()
    ok(f"   ✅  Updated: {before} → {after}")
    info("   Restarting service…")
    _ssh_run(agent, "systemctl restart openclaw", password=password, timeout=30)
    time.sleep(4)
    svc = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null", password=password).strip()
    ok(f"✅  {agent.name} updated and running!") if svc == "active" else warn(
        f"⚠️  Updated but service status: {svc}")


def _run_bulk(jid: str, agents: List[AgentRecord], action: str):
    _job_update(jid, "running")
    for agent in agents:
        _job_log(jid, f"🎼  {action.title()}: {agent.emoji} {agent.name}…", "info")
        try:
            cmd = {"start":"systemctl start openclaw",
                   "stop": "systemctl stop openclaw",
                   "restart":"systemctl restart openclaw"}[action]
            _ssh_run(agent, cmd, timeout=30)
            _job_log(jid, f"   ✅  Done", "success")
        except Exception as exc:
            _job_log(jid, f"   ❌  {exc}", "error")
    _job_update(jid, "success")
    _job_log(jid, f"\n✅  Bulk {action} complete", "success")
    time.sleep(3)
    for agent in agents:
        _refresh_one(agent.id)

# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

STATIC = Path(__file__).parent / "static"
if STATIC.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/")
async def root():
    index = STATIC / "index.html"
    return FileResponse(str(index)) if index.exists() else HTMLResponse(
        "<h1>OpenClaw Orchestra</h1><p>Static files missing.</p>"
    )

# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import os
    port = int(os.environ.get("ORCHESTRA_PORT", 9000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
