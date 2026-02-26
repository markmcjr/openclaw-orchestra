/* =========================================================
   OpenClaw Orchestra — Frontend JS
   ========================================================= */

const API = "";            // same origin
let agents = {};           // id → agent record
let statuses = {};         // id → status data
let activeGroup = "all";
let searchTerm  = "";
let detailId    = null;    // currently open detail modal
let ws          = null;    // WebSocket
let addStep     = 1;
let editingId   = null;    // null = new, str = editing existing

// ─── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  loadTheme();
  await loadAgents();
  connectWS();
});

// ─── Theme ─────────────────────────────────────────────────────────────────
function loadTheme() {
  const dark = localStorage.getItem("orchestra-dark") === "1";
  document.getElementById("html-root").classList.toggle("dark", dark);
  document.getElementById("dark-btn").textContent = dark ? "☀️" : "🌙";
}
function toggleDark() {
  const h = document.getElementById("html-root");
  const on = h.classList.toggle("dark");
  localStorage.setItem("orchestra-dark", on ? "1" : "0");
  document.getElementById("dark-btn").textContent = on ? "☀️" : "🌙";
}

// ─── Data ──────────────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const data = await apiFetch("/api/agents");
    agents   = {};
    statuses = {};
    for (const a of data) {
      agents[a.id]   = a;
      statuses[a.id] = a.status || null;
    }
    renderAll();
  } catch (e) {
    console.error("loadAgents:", e);
  }
}

// ─── WebSocket ─────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/status`);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "snapshot") {
      for (const [id, s] of Object.entries(msg.statuses || {})) {
        statuses[id] = s;
      }
    } else if (msg.type === "update") {
      statuses[msg.id] = msg.status;
      if (agents[msg.id]) {
        agents[msg.id].status = msg.status;
      }
    }
    renderAll();
    updateSummaryBar();
  };

  ws.onclose = () => setTimeout(connectWS, 5000);
}

// ─── Render ─────────────────────────────────────────────────────────────────
function renderAll() {
  buildGroupTabs();
  renderGrid();
  updateSummaryBar();
  updateEmptyState();
}

function buildGroupTabs() {
  const groups = new Set(["all"]);
  for (const a of Object.values(agents)) groups.add(a.group || "default");

  const bar  = document.getElementById("group-tabs");
  const prev = bar.querySelector(".group-tab.active")?.dataset.group || "all";
  bar.innerHTML = "";

  for (const g of groups) {
    const btn = document.createElement("button");
    btn.className = "group-tab" + (g === prev ? " active" : "");
    btn.dataset.group = g;
    btn.textContent   = g === "all" ? "All Agents" : g;
    btn.onclick = () => filterGroup(g, btn);
    bar.appendChild(btn);
  }
  activeGroup = prev;
}

function filterGroup(g, btn) {
  activeGroup = g;
  document.querySelectorAll(".group-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderGrid();
}

function filterCards() {
  searchTerm = document.getElementById("search-input").value.toLowerCase();
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById("agent-grid");
  grid.innerHTML = "";

  const visible = Object.values(agents).filter(a => {
    if (activeGroup !== "all" && (a.group || "default") !== activeGroup) return false;
    if (searchTerm && !a.name.toLowerCase().includes(searchTerm) &&
        !a.description.toLowerCase().includes(searchTerm)) return false;
    return true;
  });

  for (const a of visible) {
    grid.appendChild(buildCard(a));
  }

  updateEmptyState(visible.length === 0);
}

function buildCard(a) {
  const s      = statuses[a.id] || {};
  const online = s.online || false;
  const spark  = a.sparkline || [];

  const card = document.createElement("div");
  card.className = "agent-card" + (online ? "" : " offline");
  card.id = "card-" + a.id;

  // ── Top row
  const dotClass = online ? "dot dot-g" : (s.last_checked ? "dot dot-r" : "dot dot-x");
  const pillCls  = online ? "status-pill pill-online" : (s.last_checked ? "status-pill pill-offline" : "status-pill pill-check");
  const pillTxt  = online ? "Online" : (s.last_checked ? "Offline" : "Checking…");

  card.innerHTML = `
  <div class="card-top">
    <div class="card-emoji">${esc(a.emoji || "🤖")}</div>
    <div class="card-identity">
      <div class="card-name">${esc(a.name)}</div>
      <div class="card-desc">${esc(a.description || a.group || "")}</div>
      <div class="${pillCls}"><span class="${dotClass}"></span>${pillTxt}</div>
    </div>
  </div>

  <div class="card-spark">${buildSparkHTML(spark, 24)}</div>

  <div class="card-act">
    <span>${online ? "💬" : "💤"}</span>
    <span>${esc(s.activity || (online ? "Active" : "Not responding"))}</span>
  </div>

  <div class="card-meta">
    ${s.response_ms ? `📶 ${s.response_ms}ms` : ""}
    ${s.uptime_human ? `⏱ Up ${s.uptime_human}` : ""}
    🌐 ${esc(a.host)}:${a.port}
  </div>

  <div class="card-btns">
    <button class="cbtn cbtn-primary" onclick="openDetail('${a.id}')">Details</button>
    ${a.has_ssh_password ? `
      <button class="cbtn cbtn-start" onclick="quickAction('${a.id}','restart')" title="Restart agent">↺</button>
      <button class="cbtn cbtn-stop"  onclick="quickAction('${a.id}','stop')"    title="Stop agent">⏹</button>
    ` : ""}
  </div>`;

  return card;
}

function buildSparkHTML(hist, max) {
  if (!hist || hist.length === 0) {
    return '<span style="font-size:.7rem; color:var(--muted)">No history yet</span>';
  }
  const slice = hist.slice(-max);
  return slice.map(h => {
    if (h.online === undefined || h.online === null) return `<span class="sp u" title="Unknown"></span>`;
    return `<span class="sp ${h.online ? 'g' : 'r'}" title="${h.online ? 'Online' : 'Offline'}"></span>`;
  }).join("");
}

function buildSparkLgHTML(hist, max) {
  const slice = (hist || []).slice(-max);
  if (slice.length === 0) return '<span style="color:var(--muted);font-size:.78rem">No history yet</span>';
  return slice.map(h => {
    if (h.online === undefined || h.online === null) return `<span class="sp-lg u" title="Unknown"></span>`;
    return `<span class="sp-lg ${h.online ? 'g' : 'r'}" title="${h.online ? 'Online' : 'Offline'}"></span>`;
  }).join("");
}

function updateSummaryBar() {
  let online = 0, offline = 0;
  for (const s of Object.values(statuses)) {
    if (!s) continue;
    if (s.online) online++; else if (s.last_checked) offline++;
  }
  document.getElementById("cnt-online").textContent  = online;
  document.getElementById("cnt-offline").textContent = offline;

  const ts = document.getElementById("last-updated");
  const any = Object.values(statuses).find(s => s?.last_checked);
  ts.textContent = any ? "Last checked " + timeAgo(any.last_checked) : "Connecting…";

  const hasSsh = Object.values(agents).some(a => a.has_ssh_password);
  document.getElementById("bulk-actions").style.display = hasSsh ? "flex" : "none";
}

function updateEmptyState(force) {
  const empty = force !== undefined ? force : Object.keys(agents).length === 0;
  document.getElementById("empty-state").style.display  = empty ? "block" : "none";
  document.getElementById("agent-grid").style.display   = empty ? "none"  : "grid";
}

// ─── Detail modal ───────────────────────────────────────────────────────────
async function openDetail(id) {
  detailId = id;
  const a  = agents[id];
  const s  = statuses[id] || {};

  document.getElementById("d-emoji").textContent = a.emoji || "🤖";
  document.getElementById("d-name").textContent  = a.name;

  const chip    = document.getElementById("d-chip");
  chip.textContent = s.online ? "Online" : (s.last_checked ? "Offline" : "Unknown");
  chip.className   = s.online ? "status-chip chip-online" : (s.last_checked ? "status-chip chip-offline" : "status-chip chip-check");

  // Stat chips
  const statsEl = document.getElementById("d-stats");
  statsEl.innerHTML = `
    <div class="sch"><div class="sch-v">${s.online ? "🟢" : "🔴"}</div><div class="sch-l">Status</div></div>
    ${s.response_ms ? `<div class="sch"><div class="sch-v">${s.response_ms}ms</div><div class="sch-l">Response</div></div>` : ""}
    ${s.uptime_human ? `<div class="sch"><div class="sch-v">${esc(s.uptime_human)}</div><div class="sch-l">Uptime</div></div>` : ""}
    ${s.openclaw_version ? `<div class="sch"><div class="sch-v" style="font-size:.78rem">${esc(s.openclaw_version)}</div><div class="sch-l">Version</div></div>` : ""}
  `;

  // Full sparkline (fetch fresh)
  try {
    const hist = await apiFetch(`/api/agents/${id}/history?n=48`);
    document.getElementById("d-spark-full").innerHTML = buildSparkLgHTML(hist, 48);
  } catch { /* noop */ }

  // Activity
  document.getElementById("d-activity").textContent =
    s.activity || (s.online ? "Active" : "Not responding — check the logs");

  // Controls
  renderDetailControls(a, s);

  // Quick links
  const links = document.getElementById("d-links");
  links.innerHTML = `
    <a class="qlink" href="http://${a.host}:${a.port}/" target="_blank">🌐 Open Gateway</a>
  `;

  // Settings form (pre-populate)
  renderSettingsForm(a);

  // Reset to overview tab
  showDTab("overview", document.querySelector(".dtab"));

  // Reset log/config panels
  document.getElementById("d-log-box").innerHTML =
    '<div style="color:var(--muted); font-style:italic; padding:.5rem">Click Refresh to load</div>';
  document.getElementById("d-config-box").textContent =
    'Click "Load Config" to read the configuration file from this agent.';
  document.getElementById("d-action-log").style.display = "none";
  document.getElementById("d-action-out").innerHTML = "";

  document.getElementById("detail-overlay").classList.add("open");
}

function closeDetail(e) {
  if (e && e.target !== document.getElementById("detail-overlay")) return;
  document.getElementById("detail-overlay").classList.remove("open");
  detailId = null;
}

function showDTab(tab, btn) {
  document.querySelectorAll(".dtab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".dpanel").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");
  else document.querySelectorAll(".dtab")[["overview","logs","config","settings"].indexOf(tab)]?.classList.add("active");
  document.getElementById("dpanel-" + tab)?.classList.add("active");
}

function renderDetailControls(a, s) {
  const row = document.getElementById("d-ctrls");
  if (a.connection_type === "http_only" || !a.has_ssh_password) {
    row.innerHTML = `
      <div style="color:var(--muted); font-size:.82rem; padding:.5rem 0">
        Controls are not available — this agent is configured as Watch Only or has no SSH password.<br>
        <a onclick="showDTab('settings',null);document.querySelectorAll('.dtab')[3].click()" 
           style="color:var(--brand);cursor:pointer;text-decoration:underline">
          Add SSH credentials in Settings
        </a> to enable restart/stop controls.
      </div>`;
    return;
  }
  row.innerHTML = `
    <button class="ctrl-btn ctrl-restart" onclick="detailAction('restart')">
      <span class="ci">↺</span><span>Restart</span><span class="cs">Reload the agent</span>
    </button>
    <button class="ctrl-btn ctrl-stop" onclick="detailAction('stop')">
      <span class="ci">⏹</span><span>Stop</span><span class="cs">Pause the agent</span>
    </button>
    <button class="ctrl-btn ctrl-start" onclick="detailAction('start')">
      <span class="ci">▶</span><span>Start</span><span class="cs">Start if stopped</span>
    </button>
    <button class="ctrl-btn ctrl-repair" onclick="detailAction('repair')">
      <span class="ci">🔧</span><span>Fix Issues</span><span class="cs">Reinstall if broken</span>
    </button>
    <button class="ctrl-btn ctrl-update" onclick="detailAction('update')">
      <span class="ci">⬆️</span><span>Update</span><span class="cs">Install latest OpenClaw</span>
    </button>
  `;
}

async function detailAction(action) {
  if (!detailId) return;
  const a = agents[detailId];

  const confirmMap = {
    stop:   `Stop ${a.name}? The machine stays on — you can restart any time.`,
    repair: `Run a repair on ${a.name}? This will reinstall OpenClaw if needed.`,
    update: `Update ${a.name} to the latest OpenClaw? The service will restart.`,
  };
  if (confirmMap[action] && !confirm(confirmMap[action])) return;

  const logEl = document.getElementById("d-action-out");
  const logBox = document.getElementById("d-action-log");
  logEl.innerHTML = "";
  logBox.style.display = "block";
  logEl.innerHTML = `<div class="al al-info"><span class="al-ts">--:--:--</span><span class="al-m">Connecting…</span></div>`;

  try {
    const res = await apiFetch(`/api/agents/${detailId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });

    streamJobLogs(res.job_id, logEl, logBox, () => {
      setTimeout(() => loadAgents(), 2000);
    });
  } catch (err) {
    appendLog(logEl, { level: "error", message: String(err), timestamp: "--:--:--" });
  }
}

async function quickAction(agentId, action) {
  const a = agents[agentId];
  if (!a) return;
  if (action === "stop" && !confirm(`Stop ${a.name}? The machine stays on.`)) return;

  try {
    const res = await apiFetch(`/api/agents/${agentId}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    // If detail is open for this agent, show in log; otherwise just reload
    if (detailId === agentId) {
      const logEl  = document.getElementById("d-action-out");
      const logBox = document.getElementById("d-action-log");
      logEl.innerHTML = "";
      logBox.style.display = "block";
      streamJobLogs(res.job_id, logEl, logBox, () => loadAgents());
    } else {
      setTimeout(() => loadAgents(), 5000);
    }
  } catch(err) {
    alert("Error: " + err.message);
  }
}

async function loadLogs() {
  if (!detailId) return;
  const box = document.getElementById("d-log-box");
  box.textContent = "Loading…";
  try {
    const r = await apiFetch(`/api/agents/${detailId}/logs?lines=80`);
    if (r.error) {
      box.textContent = "Error: " + r.error;
    } else {
      box.textContent = r.logs.join("\n") || "(No logs found)";
      box.scrollTop   = box.scrollHeight;
    }
  } catch (err) {
    box.textContent = "Error: " + err.message;
  }
}

async function loadConfig() {
  if (!detailId) return;
  const box = document.getElementById("d-config-box");
  box.textContent = "Loading…";
  try {
    const r = await apiFetch(`/api/agents/${detailId}/config`);
    if (r.error && !r.config) {
      box.textContent = "Error: " + r.error;
    } else if (r.config) {
      box.textContent = JSON.stringify(r.config, null, 2);
    } else {
      box.textContent = r.raw || "(Config is empty)";
    }
  } catch (err) {
    box.textContent = "Error: " + err.message;
  }
}

async function refreshAgent() {
  if (!detailId) return;
  await apiFetch(`/api/agents/${detailId}/refresh`, { method: "POST" });
  await loadAgents();
  openDetail(detailId);
}

async function removeAgent() {
  if (!detailId) return;
  const a = agents[detailId];
  if (!confirm(`Remove ${a.name} from Orchestra? This won't affect the agent itself — just removes it from this dashboard.`)) return;
  await apiFetch(`/api/agents/${detailId}`, { method: "DELETE" });
  document.getElementById("detail-overlay").classList.remove("open");
  detailId = null;
  await loadAgents();
}

// Settings tab
function renderSettingsForm(a) {
  const el = document.getElementById("d-settings-form");
  const connLabel = { http_only:"👁️ Watch Only", direct_ssh:"🖥️ Linux/VPS", proxmox_lxc:"📦 Proxmox Container", docker:"🐳 Docker" };

  el.innerHTML = `
    <div class="field sm"><label>Icon</label>
      <input type="text" id="se-emoji" value="${esc(a.emoji||'🤖')}" maxlength="4" style="font-size:1.4rem;text-align:center"></div>
    <div class="field"><label>Name</label>
      <input type="text" id="se-name" value="${esc(a.name)}"></div>
    <div class="field full"><label>Description</label>
      <input type="text" id="se-desc" value="${esc(a.description||'')}"></div>
    <div class="field"><label>Group</label>
      <input type="text" id="se-group" value="${esc(a.group||'default')}"></div>
    <div class="field"><label>Gateway host</label>
      <input type="text" id="se-host" value="${esc(a.host)}"></div>
    <div class="field"><label>Gateway port</label>
      <input type="number" id="se-port" value="${a.port}"></div>
    <div class="field full"><label>Gateway token (optional)</label>
      <input type="password" id="se-token" placeholder="${a.has_gateway_token ? '(saved — leave blank to keep)' : 'Leave blank if not required'}"></div>
    <div class="field full"><label>Connection type</label>
      <select id="se-conn" onchange="toggleSettingsSSH()">
        ${['http_only','direct_ssh','proxmox_lxc','docker'].map(c =>
          `<option value="${c}" ${a.connection_type===c?'selected':''}>${connLabel[c]}</option>`).join('')}
      </select></div>
    <div id="se-ssh-block">
      <div class="fg" style="grid-column:1/-1">
        <div class="field"><label>SSH host</label>
          <input type="text" id="se-ssh-host" value="${esc(a.ssh_host||a.host)}" placeholder="same as gateway host"></div>
        <div class="field"><label>SSH port</label>
          <input type="number" id="se-ssh-port" value="${a.ssh_port||22}"></div>
        <div class="field"><label>SSH username</label>
          <input type="text" id="se-ssh-user" value="${esc(a.ssh_username||'root')}"></div>
        <div class="field"><label>SSH password</label>
          <input type="password" id="se-ssh-pass" placeholder="${a.has_ssh_password?'(saved — leave blank to keep)':'Enter password'}"></div>
        ${a.connection_type==='proxmox_lxc'?`
        <div class="field"><label>Container ID (VMID)</label>
          <input type="number" id="se-vmid" value="${a.proxmox_vmid||''}"></div>
        `:''}
        ${a.connection_type==='docker'?`
        <div class="field"><label>Container name</label>
          <input type="text" id="se-container" value="${esc(a.docker_container||'')}"></div>
        `:''}
      </div>
    </div>
    <div class="field full"><label>Notes</label>
      <input type="text" id="se-notes" value="${esc(a.notes||'')}"></div>
  `;
  toggleSettingsSSH();
}

function toggleSettingsSSH() {
  const conn  = document.getElementById("se-conn")?.value;
  const block = document.getElementById("se-ssh-block");
  if (block) block.style.display = conn === "http_only" ? "none" : "block";
}

async function saveSettings() {
  if (!detailId) return;
  const a = agents[detailId];
  const updated = {
    ...a,
    emoji:            document.getElementById("se-emoji")?.value    || a.emoji,
    name:             document.getElementById("se-name")?.value     || a.name,
    description:      document.getElementById("se-desc")?.value     || a.description,
    group:            document.getElementById("se-group")?.value    || a.group,
    host:             document.getElementById("se-host")?.value     || a.host,
    port:             parseInt(document.getElementById("se-port")?.value) || a.port,
    connection_type:  document.getElementById("se-conn")?.value     || a.connection_type,
    ssh_host:         document.getElementById("se-ssh-host")?.value || null,
    ssh_port:         parseInt(document.getElementById("se-ssh-port")?.value) || 22,
    ssh_username:     document.getElementById("se-ssh-user")?.value || "root",
    ssh_password:     document.getElementById("se-ssh-pass")?.value || null,
    gateway_token:    document.getElementById("se-token")?.value    || null,
    proxmox_vmid:     parseInt(document.getElementById("se-vmid")?.value)    || null,
    docker_container: document.getElementById("se-container")?.value || null,
    notes:            document.getElementById("se-notes")?.value    || "",
  };

  try {
    await apiFetch(`/api/agents/${detailId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    await loadAgents();
    openDetail(detailId);  // re-render
  } catch (err) {
    alert("Save failed: " + err.message);
  }
}

// ─── Add Agent Wizard ───────────────────────────────────────────────────────
function openAddWizard() {
  addStep   = 1;
  editingId = null;
  document.getElementById("wizard-title").textContent = "➕ Add an Agent";
  resetWizardFields();
  gotoStep(1);
  document.getElementById("add-overlay").classList.add("open");
}

function closeAddWizard(e) {
  if (e && e.target !== document.getElementById("add-overlay")) return;
  document.getElementById("add-overlay").classList.remove("open");
}

function resetWizardFields() {
  document.getElementById("w-emoji").value = "🤖";
  document.getElementById("w-name").value  = "";
  document.getElementById("w-desc").value  = "";
  document.getElementById("w-group").value = "default";
  document.querySelector('input[name="conn-type"][value="http_only"]').checked = true;
}

function gotoStep(n) {
  addStep = n;
  document.querySelectorAll(".wpage").forEach((p,i) => {
    p.classList.toggle("active", i + 1 === n);
  });
  document.querySelectorAll(".wstep").forEach((s,i) => {
    s.classList.toggle("active", i + 1 === n);
    s.classList.toggle("done",   i + 1 < n);
  });
  document.getElementById("w-back").style.display = n > 1 ? "block" : "none";
  const nextBtn = document.getElementById("w-next");
  nextBtn.textContent = n < 3 ? "Next →" : "Add Agent";
  nextBtn.style.background = n === 3 ? "var(--green)" : "";

  if (n === 3) buildStep3Fields();
}

function wizardBack() {
  if (addStep > 1) gotoStep(addStep - 1);
}

function wizardNext() {
  if (addStep === 1) {
    const name = document.getElementById("w-name").value.trim();
    const nameF = document.getElementById("w-name").closest(".field");
    if (!name) { nameF.classList.add("err"); return; }
    nameF.classList.remove("err");
    gotoStep(2);
  } else if (addStep === 2) {
    gotoStep(3);
  } else {
    submitAddAgent();
  }
}

function buildStep3Fields() {
  const conn  = document.querySelector('input[name="conn-type"]:checked')?.value || "http_only";
  const desc3 = document.getElementById("w3-desc");
  const fields = document.getElementById("w3-fields");

  const descs = {
    http_only:   "Enter the address where this agent is running.",
    direct_ssh:  "Enter the agent host address and SSH credentials for the server it runs on.",
    proxmox_lxc: "Enter the Proxmox host SSH details and the container ID of the agent.",
    docker:      "Enter the Docker host SSH details and the container name or ID.",
  };
  desc3.textContent = descs[conn];

  const sshBlock = (conn !== "http_only") ? `
    <div class="field sm"><label>SSH port</label>
      <input type="number" id="w-ssh-port" value="22"></div>
    <div class="field"><label>SSH username</label>
      <input type="text" id="w-ssh-user" value="root"></div>
    <div class="field full"><label>SSH password <span class="req">*</span></label>
      <input type="password" id="w-ssh-pass" placeholder="SSH password for the host"></div>
    ${conn === "proxmox_lxc" ? `
    <div class="field full"><label>Container ID (VMID) <span class="req">*</span></label>
      <input type="number" id="w-vmid" placeholder="e.g. 200"></div>
    ` : ""}
    ${conn === "docker" ? `
    <div class="field full"><label>Container name/ID <span class="req">*</span></label>
      <input type="text" id="w-container" placeholder="e.g. openclaw-agent"></div>
    ` : ""}
  ` : "";

  const sshHostLabel = conn === "http_only" ? "Agent host" :
    (conn === "proxmox_lxc" ? "Proxmox host address" :
     conn === "docker"       ? "Docker host address"  : "Server address");

  fields.innerHTML = `
    <div class="field full"><label>${sshHostLabel} <span class="req">*</span></label>
      <input type="text" id="w-host" placeholder="e.g. 192.168.1.50">
      <span class="hint">The IP address or hostname of the ${conn === "http_only" ? "server" : "SSH host"}</span></div>
    <div class="field"><label>Gateway port</label>
      <input type="number" id="w-port" value="18789">
      <span class="hint">Default: 18789</span></div>
    <div class="field"><label>Gateway token</label>
      <input type="password" id="w-gw-token" placeholder="Leave blank if not required"></div>
    ${sshBlock}
  `;
}

async function submitAddAgent() {
  const name = document.getElementById("w-name")?.value.trim();
  const host = document.getElementById("w-host")?.value.trim();
  if (!host) {
    alert("Please enter the host address.");
    return;
  }

  const conn = document.querySelector('input[name="conn-type"]:checked')?.value || "http_only";

  const agent = {
    name,
    emoji:       document.getElementById("w-emoji")?.value || "🤖",
    description: document.getElementById("w-desc")?.value  || "",
    group:       document.getElementById("w-group")?.value || "default",
    host,
    port:        parseInt(document.getElementById("w-port")?.value) || 18789,
    gateway_token:   document.getElementById("w-gw-token")?.value  || null,
    connection_type: conn,
    ssh_host:        host,
    ssh_port:        parseInt(document.getElementById("w-ssh-port")?.value) || 22,
    ssh_username:    document.getElementById("w-ssh-user")?.value    || "root",
    ssh_password:    document.getElementById("w-ssh-pass")?.value    || null,
    proxmox_vmid:    parseInt(document.getElementById("w-vmid")?.value) || null,
    docker_container: document.getElementById("w-container")?.value  || null,
    notes: "",
  };

  try {
    document.getElementById("w-next").disabled = true;
    document.getElementById("w-next").textContent = "Adding…";
    await apiFetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    closeAddWizard();
    await loadAgents();
  } catch (err) {
    alert("Failed to add agent: " + err.message);
    document.getElementById("w-next").disabled = false;
    document.getElementById("w-next").textContent = "Add Agent";
  }
}

// ─── Bulk actions ───────────────────────────────────────────────────────────
async function bulkAction(action) {
  const labels = { restart_all:"Restart All", stop_all:"Stop All", start_all:"Start All" };
  const label  = labels[action] || action;
  if (!confirm(`${label}? This will run on every agent with SSH configured.`)) return;

  const logEl  = document.getElementById("bulk-log-out");
  const titleEl = document.getElementById("bulk-title");
  logEl.innerHTML = "";
  titleEl.textContent = label;
  document.getElementById("bulk-overlay").classList.add("open");

  try {
    const res = await apiFetch("/api/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    streamJobLogs(res.job_id, logEl, null, () => loadAgents());
  } catch (err) {
    logEl.innerHTML += `<div class="al al-error"><span class="al-m">Error: ${esc(err.message)}</span></div>`;
  }
}

function closeBulkOverlay(e) {
  if (e && e.target !== document.getElementById("bulk-overlay")) return;
  document.getElementById("bulk-overlay").classList.remove("open");
  loadAgents();
}

// ─── Job log streaming ──────────────────────────────────────────────────────
function streamJobLogs(jobId, logEl, logBox, onDone) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const jws   = new WebSocket(`${proto}://${location.host}/ws/jobs/${jobId}`);
  jws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.level === "status") {
      jws.close();
      if (onDone) onDone();
    } else {
      appendLog(logEl, msg);
      if (logEl) logEl.parentElement?.scrollTo(0, logEl.parentElement.scrollHeight);
    }
  };
  jws.onerror = () => appendLog(logEl, { level: "error", message: "Connection lost", timestamp: "" });
}

function appendLog(el, msg) {
  if (!el) return;
  const d = document.createElement("div");
  d.className = `al al-${msg.level || "info"}`;
  d.innerHTML = `<span class="al-ts">${msg.timestamp || ""}</span><span class="al-m">${esc(msg.message || "")}</span>`;
  el.appendChild(d);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 10)  return "just now";
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
