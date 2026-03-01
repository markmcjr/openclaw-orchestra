"""
OpenClaw Orchestra v2 — Universal Command Centre
FastAPI backend: agent registry, status polling, cost tracking,
session proxy, reasoning extraction, live WebSocket feeds.
"""

import asyncio
import json
import logging
import queue
import re
import shlex
import sqlite3
import threading
import time
import urllib.request
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

app = FastAPI(title="OpenClaw Orchestra", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------
class ConnectionType(str, Enum):
    http_only   = "http_only"
    direct_ssh  = "direct_ssh"
    proxmox_lxc = "proxmox_lxc"
    docker      = "docker"

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class AgentRecord(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    emoji: str = "🤖"
    description: str = ""
    group: str = "default"
    host: str
    port: int = 18789
    gateway_token: Optional[str] = None
    connection_type: ConnectionType = ConnectionType.http_only
    ssh_host: Optional[str] = None
    ssh_port: int = 22
    ssh_username: str = "root"
    ssh_password: Optional[str] = None
    proxmox_vmid: Optional[int] = None
    docker_container: Optional[str] = None
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
    model: Optional[str] = None
    error: Optional[str] = None


class ControlRequest(BaseModel):
    action: str
    ssh_password: Optional[str] = None


class BulkRequest(BaseModel):
    action: str
    group: Optional[str] = None

# ---------------------------------------------------------------------------
# Model pricing  (USD per 1M tokens)
# ---------------------------------------------------------------------------
MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-opus-4":      {"in": 15.0, "out": 75.0},
    "claude-sonnet-4":    {"in": 3.0,  "out": 15.0},
    "claude-haiku-3-5":   {"in": 0.80, "out": 4.0},
    "claude-haiku":       {"in": 0.25, "out": 1.25},
    "gpt-4o":             {"in": 5.0,  "out": 15.0},
    "gpt-4.1":            {"in": 2.0,  "out": 8.0},
    "gpt-4.1-mini":       {"in": 0.40, "out": 1.60},
    "o4-mini":            {"in": 1.10, "out": 4.40},
    "gemini-2.5-pro":     {"in": 1.25, "out": 5.0},
    "gemini-2.5-flash":   {"in": 0.075,"out": 0.30},
    "deepseek":           {"in": 0.14, "out": 0.28},
}

def _model_cost(model: str, in_tok: int, out_tok: int) -> float:
    if not model:
        return 0.0
    ml = model.lower()
    for key, p in MODEL_PRICING.items():
        if key in ml:
            return (in_tok * p["in"] + out_tok * p["out"]) / 1_000_000
    return 0.0

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
DATA_DIR    = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
AGENTS_FILE = DATA_DIR / "agents.json"
DB_FILE     = DATA_DIR / "orchestra.db"


def _load_agents() -> Dict[str, AgentRecord]:
    if not AGENTS_FILE.exists():
        return {}
    try:
        raw = json.loads(AGENTS_FILE.read_text())
        return {k: AgentRecord(**v) for k, v in raw.items()}
    except Exception as exc:
        log.error("load agents: %s", exc)
        return {}


def _save_agents(agents: Dict[str, AgentRecord]):
    AGENTS_FILE.write_text(
        json.dumps({k: v.model_dump() for k, v in agents.items()}, indent=2)
    )

# ---------------------------------------------------------------------------
# Database — history, costs, events
# ---------------------------------------------------------------------------
def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS status_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT    NOT NULL,
                checked_at  REAL    NOT NULL,
                online      INTEGER NOT NULL,
                response_ms REAL
            );
            CREATE INDEX IF NOT EXISTS idx_sh ON status_history(agent_id, checked_at);

            CREATE TABLE IF NOT EXISTS cost_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                day         TEXT NOT NULL,
                model       TEXT,
                input_tok   INTEGER DEFAULT 0,
                output_tok  INTEGER DEFAULT 0,
                cost_usd    REAL    DEFAULT 0.0
            );
            CREATE INDEX IF NOT EXISTS idx_ce ON cost_events(agent_id, day);

            CREATE TABLE IF NOT EXISTS activity_log (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id    TEXT NOT NULL,
                ts          REAL NOT NULL,
                event_type  TEXT,
                message     TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_al ON activity_log(ts);
        """)
    log.info("DB ready: %s", DB_FILE)


def _store_history(agent_id, online, ms):
    with _db() as c:
        c.execute(
            "INSERT INTO status_history (agent_id, checked_at, online, response_ms) VALUES(?,?,?,?)",
            (agent_id, time.time(), int(online), ms),
        )
        c.execute("""DELETE FROM status_history WHERE id IN (
            SELECT id FROM status_history WHERE agent_id=?
            ORDER BY checked_at DESC LIMIT -1 OFFSET 60)""", (agent_id,))


def get_history(agent_id, n=48):
    with _db() as c:
        rows = c.execute(
            "SELECT checked_at, online, response_ms FROM status_history "
            "WHERE agent_id=? ORDER BY checked_at DESC LIMIT ?",
            (agent_id, n),
        ).fetchall()
    return [{"t": r["checked_at"], "online": bool(r["online"]), "ms": r["response_ms"]}
            for r in reversed(rows)]


def _store_cost(agent_id, model, in_tok, out_tok):
    if in_tok == 0 and out_tok == 0:
        return
    cost = _model_cost(model, in_tok, out_tok)
    day  = datetime.now().strftime("%Y-%m-%d")
    with _db() as c:
        c.execute(
            "INSERT INTO cost_events (agent_id, recorded_at, day, model, input_tok, output_tok, cost_usd)"
            " VALUES(?,?,?,?,?,?,?)",
            (agent_id, time.time(), day, model, in_tok, out_tok, cost),
        )


def _get_costs(agent_id, days=14):
    with _db() as c:
        rows = c.execute("""
            SELECT day, model,
                   SUM(input_tok) as in_tok, SUM(output_tok) as out_tok,
                   SUM(cost_usd)  as cost
            FROM cost_events WHERE agent_id=?
            GROUP BY day, model ORDER BY day DESC LIMIT ?""",
            (agent_id, days * 10)).fetchall()
    return [dict(r) for r in rows]


def _today_cost(agent_id):
    day = datetime.now().strftime("%Y-%m-%d")
    with _db() as c:
        row = c.execute(
            "SELECT SUM(cost_usd) as total FROM cost_events WHERE agent_id=? AND day=?",
            (agent_id, day)).fetchone()
    return round(row["total"] or 0.0, 6)


def _log_event(agent_id, event_type, message):
    with _db() as c:
        c.execute(
            "INSERT INTO activity_log (agent_id, ts, event_type, message) VALUES(?,?,?,?)",
            (agent_id, time.time(), event_type, message[:500]),
        )
        c.execute("DELETE FROM activity_log WHERE id IN "
                  "(SELECT id FROM activity_log ORDER BY ts DESC LIMIT -1 OFFSET 2000)")


def _recent_events(n=50):
    with _db() as c:
        rows = c.execute(
            "SELECT agent_id, ts, event_type, message FROM activity_log "
            "ORDER BY ts DESC LIMIT ?", (n,)).fetchall()
    return [dict(r) for r in reversed(rows)]


_init_db()

# ---------------------------------------------------------------------------
# HTTP ping
# ---------------------------------------------------------------------------
def _http_ping(host, port, token=None):
    t0 = time.time()
    try:
        req = urllib.request.Request(f"http://{host}:{port}/", method="GET")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception as exc:
            if hasattr(exc, "code") and exc.code < 500:
                return True, round((time.time() - t0) * 1000, 1)
            raise
        return True, round((time.time() - t0) * 1000, 1)
    except Exception:
        return False, None

# ---------------------------------------------------------------------------
# Gateway API proxy helper
# ---------------------------------------------------------------------------
def _gateway_fetch(agent: AgentRecord, path: str) -> Optional[dict]:
    try:
        url = f"http://{agent.host}:{agent.port}/{path.lstrip('/')}"
        req = urllib.request.Request(url)
        if agent.gateway_token:
            req.add_header("Authorization", f"Bearer {agent.gateway_token}")
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read()
            return json.loads(raw)
    except Exception:
        return None

# ---------------------------------------------------------------------------
# SSH execution
# ---------------------------------------------------------------------------
def _ssh_run(agent: AgentRecord, command: str,
             password: Optional[str] = None, timeout: int = 30) -> str:
    import paramiko
    pw = password or agent.ssh_password
    if not pw:
        raise RuntimeError("No SSH password")
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
        _, stdout, _ = ssh.exec_command(command, timeout=timeout)
        return stdout.read().decode(errors="replace")
    finally:
        try: ssh.close()
        except: pass

# ---------------------------------------------------------------------------
# Token usage parsing from logs
# ---------------------------------------------------------------------------
_TOK_PATTERNS = [
    # "prompt_tokens=1234, completion_tokens=567"
    re.compile(r"prompt_tokens[=:](\d+).*?completion_tokens[=:](\d+)", re.I),
    # "input=1234 output=567"
    re.compile(r"input[_\s]*tok[a-z]*[=:]\s*(\d+).*?output[_\s]*tok[a-z]*[=:]\s*(\d+)", re.I),
    # "tokens: 1234 in, 567 out"
    re.compile(r"(\d+)\s*in(?:put)?\s*(?:tok[a-z]*).*?(\d+)\s*out(?:put)?\s*(?:tok[a-z]*)", re.I),
    # "used N tokens (X input, Y output)"
    re.compile(r"(\d+)\s+input.*?(\d+)\s+output", re.I),
    # OpenClaw format: "usage: input_tokens=X output_tokens=Y"
    re.compile(r"input_tokens[=:](\d+).*?output_tokens[=:](\d+)", re.I),
]

_MODEL_PATTERN = re.compile(
    r"(?:model|using)[=:\s]+['\"]?(claude[-\w./]+|gpt[-\w.]+|o\d[-\w]+|gemini[-\w./]+)", re.I
)


def _parse_token_usage(logs: List[str]) -> List[Dict]:
    """Return list of {model, in_tok, out_tok} from log lines."""
    results = []
    current_model = None
    for line in logs:
        m = _MODEL_PATTERN.search(line)
        if m:
            current_model = m.group(1).lower()
        for pat in _TOK_PATTERNS:
            tm = pat.search(line)
            if tm:
                try:
                    in_t  = int(tm.group(1))
                    out_t = int(tm.group(2))
                    if in_t > 0 or out_t > 0:
                        results.append({"model": current_model or "unknown",
                                        "in_tok": in_t, "out_tok": out_t})
                except Exception:
                    pass
                break
    return results


def _extract_reasoning(logs: List[str]) -> List[Dict]:
    """Extract <thinking>…</thinking> blocks from log lines."""
    blocks = []
    current: List[str] = []
    in_block = False
    ts_line  = None

    for line in logs:
        if "<thinking>" in line.lower() or "```thinking" in line.lower():
            in_block = True
            current  = []
            ts_line  = line[:30]
            continue
        if in_block:
            if "</thinking>" in line.lower() or "```" in line:
                in_block = False
                if current:
                    blocks.append({"ts": ts_line, "content": "\n".join(current)})
                current = []
            else:
                current.append(line)
    return blocks[-10:]  # last 10 blocks


def _parse_sessions_from_logs(logs: List[str]) -> List[Dict]:
    """Best-effort session extraction from log lines."""
    sessions: Dict[str, Dict] = {}
    sess_pat  = re.compile(r"session[_\s]?(?:key)?[=:\s]+([a-zA-Z0-9_-]{6,})", re.I)
    chan_pat  = re.compile(r"channel[=:\s]+([a-zA-Z]+)", re.I)
    for line in logs:
        sm = sess_pat.search(line)
        if sm:
            key = sm.group(1)
            if key not in sessions:
                sessions[key] = {"key": key, "channel": "unknown", "messages": 0, "last_seen": ""}
            sessions[key]["messages"] += 1
            sessions[key]["last_seen"] = line[:40]
            cm = chan_pat.search(line)
            if cm:
                sessions[key]["channel"] = cm.group(1)
    return list(sessions.values())[-20:]

# ---------------------------------------------------------------------------
# Status check
# ---------------------------------------------------------------------------
def _human_uptime(ts_raw: str) -> Optional[str]:
    if not ts_raw or ts_raw.strip() in ("", "n/a"):
        return None
    try:
        parts  = ts_raw.strip().split()
        dt_str = " ".join(parts[-3:])
        dt     = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S %Z").replace(tzinfo=timezone.utc)
        secs   = int((datetime.now(timezone.utc) - dt).total_seconds())
        if secs < 60:    return f"{secs}s"
        if secs < 3600:  return f"{secs // 60}m"
        if secs < 86400: return f"{secs // 3600}h {(secs % 3600) // 60}m"
        return f"{secs // 86400}d {(secs % 86400) // 3600}h"
    except Exception:
        return None


def _parse_activity(logs: List[str]) -> str:
    checks = [
        ("sending",    "Sent a reply"),
        ("response",   "Sent a reply"),
        ("tool call",  "Used a tool"),
        ("heartbeat",  "Running scheduled checks"),
        ("cron",       "Running a scheduled task"),
        ("connected",  "Connected and ready"),
        ("session",    "Active conversation"),
        ("channel",    "Handling a channel event"),
        ("sub-agent",  "Spawned a sub-agent"),
        ("subagent",   "Spawned a sub-agent"),
        ("error",      "Encountered an issue"),
        ("warn",       "Something needs attention"),
    ]
    for line in reversed(logs):
        ll = line.lower()
        for kw, label in checks:
            if kw in ll:
                return label
    return "Idle — waiting for messages"


def _check_status(agent: AgentRecord) -> AgentStatusData:
    s = AgentStatusData(id=agent.id, last_checked=time.time())
    online, ms = _http_ping(agent.host, agent.port, agent.gateway_token)
    s.online     = online
    s.response_ms = ms
    _store_history(agent.id, online, ms)

    if not online:
        s.headline  = "Offline — not responding"
        s.activity  = "Cannot reach this agent"
        _log_event(agent.id, "offline", "Agent went offline")
        return s

    has_ssh = agent.connection_type != ConnectionType.http_only and agent.ssh_password
    if has_ssh:
        try:
            svc = _ssh_run(agent,
                "systemctl is-active openclaw 2>/dev/null && "
                "systemctl show openclaw --property=ActiveEnterTimestamp --value 2>/dev/null").strip()
            lines = svc.splitlines()
            s.service_ok   = lines[0].strip() == "active" if lines else False
            s.uptime_human = _human_uptime(lines[1]) if len(lines) > 1 else None

            raw_logs = _ssh_run(agent,
                "journalctl -u openclaw -n 120 --no-pager --output=cat 2>/dev/null", timeout=20)
            s.recent_logs = [l for l in raw_logs.splitlines() if l.strip()][-120:]
            s.activity    = _parse_activity(s.recent_logs)

            # Version + model
            ver = _ssh_run(agent, "openclaw --version 2>/dev/null").strip()
            s.openclaw_version = ver or None

            model_raw = _ssh_run(agent,
                "grep -o '\"model\"\\s*:\\s*\"[^\"]*\"' /home/openclaw/.openclaw/openclaw.json 2>/dev/null"
                " | head -1 | sed 's/.*: *\"//;s/\"//'").strip()
            s.model = model_raw or None

            # Token usage → cost
            usages = _parse_token_usage(s.recent_logs)
            for u in usages:
                _store_cost(agent.id, u["model"], u["in_tok"], u["out_tok"])

        except Exception as exc:
            log.debug("SSH check %s: %s", agent.id, exc)

    up = f" · Up {s.uptime_human}" if s.uptime_human else ""
    s.headline = f"Online{up}"
    _log_event(agent.id, "status", s.activity)
    return s

# ---------------------------------------------------------------------------
# Background poller
# ---------------------------------------------------------------------------
_agent_statuses: Dict[str, AgentStatusData] = {}
_ws_listeners:   List[queue.Queue] = []
_POLL_INTERVAL = 30


def _broadcast(msg: dict):
    dead = []
    for q in _ws_listeners:
        try: q.put_nowait(msg)
        except queue.Full: dead.append(q)
    for q in dead:
        if q in _ws_listeners: _ws_listeners.remove(q)


def _refresh_one(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        return
    s = _check_status(agents[agent_id])
    _agent_statuses[agent_id] = s
    _broadcast({"type": "agent_update", "id": agent_id, "status": s.model_dump()})


def _poll_loop():
    while True:
        for aid in list(_load_agents().keys()):
            try:
                _refresh_one(aid)
            except Exception as exc:
                log.error("poll %s: %s", aid, exc)
        _broadcast({"type": "events", "events": _recent_events(30)})
        time.sleep(_POLL_INTERVAL)


threading.Thread(target=_poll_loop, daemon=True).start()

# ---------------------------------------------------------------------------
# Job store
# ---------------------------------------------------------------------------
_jobs:       Dict[str, dict]  = {}
_job_queues: Dict[str, queue.Queue] = {}


def _job_create() -> str:
    jid = str(uuid.uuid4())
    _jobs[jid]       = {"status": "pending", "error": None}
    _job_queues[jid] = queue.Queue(maxsize=500)
    return jid


def _job_update(jid, status, error=None):
    if jid in _jobs:
        _jobs[jid].update({"status": status, "error": error})


def _job_log(jid, msg, level="info"):
    if jid in _job_queues:
        _job_queues[jid].put({
            "timestamp": datetime.now().strftime("%H:%M:%S"),
            "level": level, "message": msg,
        })

# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@app.get("/api/agents")
async def list_agents():
    agents = _load_agents()
    result = []
    for aid, agent in agents.items():
        s    = _agent_statuses.get(aid)
        hist = get_history(aid, 24)
        result.append({
            **agent.model_dump(exclude={"ssh_password", "gateway_token"}),
            "has_ssh_password":  bool(agent.ssh_password),
            "has_gateway_token": bool(agent.gateway_token),
            "status":    s.model_dump() if s else None,
            "sparkline": [{"online": h["online"]} for h in hist],
            "cost_today": _today_cost(aid),
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
    return {
        **agent.model_dump(exclude={"ssh_password", "gateway_token"}),
        "has_ssh_password":  bool(agent.ssh_password),
        "has_gateway_token": bool(agent.gateway_token),
        "status":     s.model_dump() if s else None,
        "sparkline":  get_history(agent_id, 48),
        "cost_today": _today_cost(agent_id),
    }


@app.put("/api/agents/{agent_id}")
async def update_agent(agent_id: str, agent: AgentRecord):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent.id = agent_id
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
        raise HTTPException(404)
    del agents[agent_id]
    _save_agents(agents)
    _agent_statuses.pop(agent_id, None)
    return {"ok": True}


@app.post("/api/agents/{agent_id}/refresh")
async def refresh_agent(agent_id: str, background_tasks: BackgroundTasks):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    background_tasks.add_task(_refresh_one, agent_id)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Rich data endpoints
# ---------------------------------------------------------------------------
@app.get("/api/agents/{agent_id}/history")
async def agent_history(agent_id: str, n: int = 48):
    return get_history(agent_id, n)


@app.get("/api/agents/{agent_id}/logs")
async def agent_logs(agent_id: str, lines: int = 100):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        return {"logs": [], "error": "SSH not configured"}
    try:
        raw = _ssh_run(agent,
            f"journalctl -u openclaw -n {lines} --no-pager --output=short-iso 2>/dev/null")
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
            "|| cat ~/.openclaw/openclaw.json 2>/dev/null || echo '{}'")
        try:
            return {"config": json.loads(raw)}
        except Exception:
            return {"config": None, "raw": raw, "error": "Could not parse as JSON"}
    except Exception as exc:
        return {"config": None, "error": str(exc)}


@app.get("/api/agents/{agent_id}/costs")
async def agent_costs(agent_id: str, days: int = 14):
    costs = _get_costs(agent_id, days)
    today = _today_cost(agent_id)

    # Aggregate by day
    by_day: Dict[str, float] = {}
    for row in costs:
        by_day[row["day"]] = by_day.get(row["day"], 0.0) + (row["cost"] or 0.0)

    # Total
    total = sum(by_day.values())

    return {
        "today": round(today, 6),
        "total": round(total, 6),
        "by_day": [{"day": k, "cost": round(v, 6)} for k, v in sorted(by_day.items())],
        "detail": costs,
    }


@app.get("/api/agents/{agent_id}/reasoning")
async def agent_reasoning(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        return {"blocks": [], "note": "SSH not configured"}
    try:
        raw = _ssh_run(agent,
            "journalctl -u openclaw -n 500 --no-pager --output=cat 2>/dev/null")
        lines  = [l for l in raw.splitlines() if l.strip()]
        blocks = _extract_reasoning(lines)
        return {"blocks": blocks}
    except Exception as exc:
        return {"blocks": [], "error": str(exc)}


@app.get("/api/agents/{agent_id}/sessions")
async def agent_sessions(agent_id: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    agent = agents[agent_id]

    # Try gateway API first
    data = _gateway_fetch(agent, "/api/sessions")
    if data:
        return {"sessions": data if isinstance(data, list) else data.get("sessions", []),
                "source": "gateway"}

    # Fall back to log parsing
    if agent.connection_type == ConnectionType.http_only or not agent.ssh_password:
        return {"sessions": [], "source": "none", "note": "Enable SSH for session data"}
    try:
        raw  = _ssh_run(agent, "journalctl -u openclaw -n 300 --no-pager --output=cat 2>/dev/null")
        logs = [l for l in raw.splitlines() if l.strip()]
        return {"sessions": _parse_sessions_from_logs(logs), "source": "logs"}
    except Exception as exc:
        return {"sessions": [], "error": str(exc)}


@app.get("/api/agents/{agent_id}/gateway/{path:path}")
async def gateway_proxy(agent_id: str, path: str):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    data = _gateway_fetch(agents[agent_id], path)
    if data is None:
        raise HTTPException(502, "Gateway did not respond")
    return data


@app.get("/api/overview")
async def overview():
    agents = _load_agents()
    total  = len(agents)
    online = sum(1 for s in _agent_statuses.values() if s.online)
    today  = datetime.now().strftime("%Y-%m-%d")

    with _db() as c:
        cost_row = c.execute(
            "SELECT SUM(cost_usd) as t FROM cost_events WHERE day=?", (today,)).fetchone()
        total_cost = round(cost_row["t"] or 0.0, 4)

    events = _recent_events(50)
    return {
        "total": total,
        "online": online,
        "offline": total - online,
        "cost_today": total_cost,
        "events": events,
    }


@app.get("/api/events")
async def events(n: int = 50):
    return _recent_events(n)

# ---------------------------------------------------------------------------
# Control actions
# ---------------------------------------------------------------------------
@app.post("/api/agents/{agent_id}/control")
async def control_agent(agent_id: str, req: ControlRequest, background_tasks: BackgroundTasks):
    agents = _load_agents()
    if agent_id not in agents:
        raise HTTPException(404)
    if req.action not in ("start", "stop", "restart", "repair", "update"):
        raise HTTPException(400, f"Unknown action: {req.action}")
    agent = agents[agent_id]
    if agent.connection_type == ConnectionType.http_only:
        raise HTTPException(400, "SSH controls not available for Watch Only agents")
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
        if a.connection_type != ConnectionType.http_only and a.ssh_password
        and (req.group is None or a.group == req.group)
    }
    if not targets:
        raise HTTPException(400, "No agents with SSH controls in scope")
    action_map = {"restart_all":"restart","stop_all":"stop","start_all":"start"}
    act = action_map.get(req.action)
    if not act:
        raise HTTPException(400, f"Unknown bulk action: {req.action}")
    jid = _job_create()
    background_tasks.add_task(_run_bulk, jid, list(targets.values()), act)
    return {"job_id": jid, "count": len(targets)}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    if job_id not in _jobs:
        raise HTTPException(404)
    return _jobs[job_id]

# ---------------------------------------------------------------------------
# WebSockets
# ---------------------------------------------------------------------------
@app.websocket("/ws/jobs/{job_id}")
async def ws_job(websocket: WebSocket, job_id: str):
    await websocket.accept()
    if job_id not in _job_queues:
        await websocket.send_json({"level":"error","message":"Job not found"})
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
                await websocket.send_json({"level":"status","status":job["status"],"error":job.get("error")})
                break
            await asyncio.sleep(0.35)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    """Main real-time feed: status updates + activity events."""
    await websocket.accept()
    # Send initial snapshot
    agents = _load_agents()
    await websocket.send_json({
        "type": "snapshot",
        "statuses": {k: v.model_dump() for k, v in _agent_statuses.items()},
        "events": _recent_events(40),
        "agents": [
            {**a.model_dump(exclude={"ssh_password","gateway_token"}),
             "has_ssh_password": bool(a.ssh_password),
             "cost_today": _today_cost(a.id)}
            for a in agents.values()
        ],
    })
    q: queue.Queue = queue.Queue(maxsize=200)
    _ws_listeners.append(q)
    try:
        while True:
            while not q.empty():
                await websocket.send_json(q.get_nowait())
            await asyncio.sleep(0.35)
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
        info(f"🎼  {action.title()}: {agent.emoji} {agent.name}…")
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
            svc = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null", password=password).strip()
            if action == "stop":
                ok(f"✅  {agent.name} stopped")
            elif svc == "active":
                ok(f"✅  {agent.name} is running")
            else:
                warn(f"⚠️  Service status: {svc}")
        _job_update(jid, "success")
        _log_event(agent.id, "control", f"{action} executed")
        time.sleep(2)
        _refresh_one(agent.id)
    except Exception as exc:
        err(f"❌  {exc}")
        _job_update(jid, "failed", str(exc))


def _do_repair(agent, password, info, ok, warn, err):
    info("🔍  Checking installation…")
    which = _ssh_run(agent, "which openclaw 2>/dev/null", password=password).strip()
    if not which:
        warn("   Not found — reinstalling…")
        _ssh_run(agent, "npm install -g openclaw@latest 2>&1", password=password, timeout=600)
        ok("   ✅  Reinstalled")
    else:
        ok(f"   ✅  Found: {which}")
    svc = _ssh_run(agent, "systemctl cat openclaw 2>/dev/null | head -1", password=password).strip()
    if not svc:
        warn("   Service file missing — writing…")
        svc_content = (
            "[Unit]\\nDescription=OpenClaw Gateway\\nAfter=network.target\\n\\n"
            "[Service]\\nType=simple\\nUser=openclaw\\n"
            "EnvironmentFile=/home/openclaw/.openclaw/.env\\n"
            "ExecStart=/usr/bin/openclaw gateway\\nRestart=always\\nRestartSec=10\\n\\n"
            "[Install]\\nWantedBy=multi-user.target"
        )
        _ssh_run(agent, f"printf '{svc_content}' > /etc/systemd/system/openclaw.service", password=password)
    info("   Reloading and starting…")
    _ssh_run(agent, "systemctl daemon-reload && systemctl enable openclaw && systemctl start openclaw",
             password=password, timeout=30)
    time.sleep(4)
    final = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null", password=password).strip()
    ok(f"\n✅  {agent.name} is healthy!") if final == "active" else warn(f"\n⚠️  Status: {final}")


def _do_update(agent, password, info, ok, warn, err):
    info("⬆️   Checking version…")
    before = _ssh_run(agent, "openclaw --version 2>/dev/null", password=password).strip()
    info(f"   Current: {before or 'unknown'}")
    info("   Installing latest…")
    _ssh_run(agent, "npm install -g openclaw@latest 2>&1", password=password, timeout=600)
    after = _ssh_run(agent, "openclaw --version 2>/dev/null", password=password).strip()
    ok(f"   ✅  {before} → {after}")
    info("   Restarting…")
    _ssh_run(agent, "systemctl restart openclaw", password=password, timeout=30)
    time.sleep(4)
    svc = _ssh_run(agent, "systemctl is-active openclaw 2>/dev/null", password=password).strip()
    ok(f"✅  Updated and running!") if svc == "active" else warn(f"⚠️  Status: {svc}")


def _run_bulk(jid: str, agents: List[AgentRecord], action: str):
    _job_update(jid, "running")
    for agent in agents:
        _job_log(jid, f"{action.title()}: {agent.emoji} {agent.name}…", "info")
        try:
            cmd = {"start":"systemctl start openclaw",
                   "stop": "systemctl stop openclaw",
                   "restart":"systemctl restart openclaw"}[action]
            _ssh_run(agent, cmd, timeout=30)
            _job_log(jid, "   ✅  Done", "success")
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
    idx = STATIC / "index.html"
    return FileResponse(str(idx)) if idx.exists() else HTMLResponse("<h1>OpenClaw Orchestra</h1>")

# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import os
    port = int(os.environ.get("ORCHESTRA_PORT", 9000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
