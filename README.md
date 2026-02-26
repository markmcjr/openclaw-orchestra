# 🎼 OpenClaw Orchestra

**Universal control plane for your OpenClaw agents.**

Monitor and manage any OpenClaw instance from one dashboard — whether it's running on a bare-metal Linux server, a VPS, a Proxmox LXC container, a Docker container, or anywhere else.

> No Proxmox required. Works with any OpenClaw deployment.

---

## What it does

- **See all your agents at a glance** — online/offline status, uptime, response time, what the agent is doing right now
- **48-hour sparkline history** — visual uptime record for each agent
- **Start, stop, restart, fix, update** — one-click controls (requires SSH access to the host)
- **View live logs** — tail the agent's journal from your browser
- **Read the config file** — inspect `openclaw.json` without SSHing in yourself
- **Group and filter** — organise agents by group (Production, Dev, etc.)
- **Bulk actions** — restart or stop your whole fleet with one click
- **Works without SSH** — add any agent in "Watch Only" mode to at least track its online status

---

## Quickstart

### Option A — Shell (local)

```bash
git clone https://github.com/markmcjr/openclaw-orchestra
cd openclaw-orchestra
./install.sh
./run.sh
```

Open **http://localhost:9000** in your browser.

### Option B — Docker

```bash
git clone https://github.com/markmcjr/openclaw-orchestra
cd openclaw-orchestra
docker compose up -d
```

Open **http://localhost:9000**.

---

## Configuration

No config file needed. Everything is set up through the web UI.

### Environment variables

| Variable         | Default | Description                       |
|------------------|---------|-----------------------------------|
| `ORCHESTRA_PORT` | `9000`  | Port to run the web UI on         |

---

## Adding an Agent

Click **+ Add Agent** and follow the 3-step wizard:

1. **Who** — Give the agent a name, icon, and description
2. **How** — Choose how Orchestra connects to it:
   - 👁️ **Watch Only** — HTTP ping only, no SSH controls
   - 🖥️ **Linux / VPS** — SSH directly into the machine
   - 📦 **Proxmox Container** — SSH into the Proxmox host, exec into the container
   - 🐳 **Docker** — SSH into the Docker host, exec into the container
3. **Details** — Host address, port, SSH credentials

SSH passwords are stored **only in memory and locally in `data/agents.json`** — never pushed to GitHub (that file is gitignored).

---

## Controls

| Button      | What it does                                           |
|-------------|--------------------------------------------------------|
| Restart     | `systemctl restart openclaw`                           |
| Stop        | `systemctl stop openclaw` (machine stays on)           |
| Start       | `systemctl start openclaw`                             |
| Fix Issues  | Checks installation, rewrites service file if missing, restarts |
| Update      | `npm install -g openclaw@latest` then restarts         |

---

## Deploying new agents

To spin up a **new** OpenClaw agent on Proxmox, use the companion tool:
**[OpenClaw Proxmox Deployer](https://github.com/markmcjr/openclaw-proxmox-deployer)**

Once deployed, add the new agent to Orchestra using **+ Add Agent**.

---

## Tech stack

- **Backend:** Python + FastAPI + paramiko (SSH)
- **Frontend:** Vanilla HTML/CSS/JS — no framework, no build step
- **Storage:** `data/agents.json` (agent registry) + SQLite (history)
- **Real-time:** WebSocket for live status updates and control action logs

---

## License

MIT
