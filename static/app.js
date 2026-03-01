/* ================================================================
   OpenClaw Orchestra v2 — Frontend
   3-panel layout: sidebar | main | activity feed
   ================================================================ */

// ── State ──────────────────────────────────────────────────────
let agents    = {};          // id → agent record
let statuses  = {};          // id → AgentStatusData
let sparklines = {};         // id → [{online}]
let costs     = {};          // id → cost_today float
let events    = [];          // recent activity events
let ws        = null;
let currentView   = "overview";
let currentAgent  = null;    // id of agent in detail view
let wizardStep    = 1;
let activityPaused = false;
let sbFilter      = "";
let groupFilter   = "all";

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadAll().then(() => connectWS());
});

async function loadAll() {
  try {
    const data = await api("/api/agents");
    agents = {}; statuses = {}; sparklines = {}; costs = {};
    for (const a of data) {
      agents[a.id]     = a;
      statuses[a.id]   = a.status || null;
      sparklines[a.id] = a.sparkline || [];
      costs[a.id]      = a.cost_today || 0;
    }
    renderSidebar();
    renderOverview();
    updateMetricBar();
    updateGroupFilter();
    _postLoad();
  } catch (e) {
    console.error("loadAll:", e);
  }
}

// ── WebSocket ─────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/live`);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "snapshot") {
      for (const [id, s] of Object.entries(msg.statuses || {})) statuses[id] = s;
      if (msg.events) pushEvents(msg.events);
      if (msg.agents) {
        for (const a of msg.agents) {
          agents[a.id]   = { ...agents[a.id], ...a };
          costs[a.id]    = a.cost_today || 0;
        }
      }
    } else if (msg.type === "agent_update") {
      statuses[msg.id] = msg.status;
      if (agents[msg.id]) agents[msg.id].status = msg.status;
      updateAgentCard(msg.id);
      updateSidebarAgent(msg.id);
      if (currentAgent === msg.id) refreshDetailHeader();
    } else if (msg.type === "events") {
      if (msg.events) pushEvents(msg.events);
    }
    updateMetricBar();
  };

  ws.onclose = () => {
    document.getElementById("sb-last-check").textContent = "Reconnecting…";
    setTimeout(connectWS, 5000);
  };
  ws.onopen = () => {
    document.getElementById("sb-last-check").textContent = "Live";
  };
}

// ── Views ─────────────────────────────────────────────────────
function showView(name, navEl) {
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".sb-nav-item").forEach(n => n.classList.remove("active"));
  const el = document.getElementById("view-" + name);
  if (el) el.classList.add("active");
  if (navEl) navEl.classList.add("active");
  else {
    const nav = document.querySelector(`.sb-nav-item[data-view="${name}"]`);
    if (nav) nav.classList.add("active");
  }
  if (name === "overview") { renderOverview(); }
}

function showAgentDetail(id) {
  currentAgent = id;
  currentView  = "detail";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".sb-agent").forEach(a => a.classList.remove("active"));
  document.querySelectorAll(".sb-nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById("view-detail").classList.add("active");
  const sbItem = document.getElementById("sb-a-" + id);
  if (sbItem) sbItem.classList.add("active");
  buildDetailView(id);
}

// ── Metric bar ────────────────────────────────────────────────
function updateMetricBar() {
  let online = 0, offline = 0, totalMs = 0, msCount = 0;
  for (const s of Object.values(statuses)) {
    if (!s) continue;
    if (s.online) { online++; if (s.response_ms) { totalMs += s.response_ms; msCount++; } }
    else if (s.last_checked) offline++;
  }
  const totalCost = Object.values(costs).reduce((a, b) => a + (b || 0), 0);

  setEl("mt-online",  `.mt-val`, online);
  setEl("mt-offline", `.mt-val`, offline);
  setEl("mt-cost",    `.mt-val`, "$" + totalCost.toFixed(4));
  setEl("mt-resp",    `.mt-val`, msCount ? Math.round(totalMs / msCount) + "ms" : "—ms");
  setEl("mt-events",  `.mt-val`, events.length);

  const now = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  document.getElementById("sb-last-check").textContent = "Updated " + now;
}

// ── Sidebar ───────────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById("sb-agents");
  const list = Object.values(agents).filter(a =>
    !sbFilter || a.name.toLowerCase().includes(sbFilter) ||
    (a.description||"").toLowerCase().includes(sbFilter)
  ).sort((a,b) => a.name.localeCompare(b.name));

  if (list.length === 0) {
    el.innerHTML = `<div class="sb-loading">${sbFilter ? "No match" : "No agents yet"}</div>`;
    return;
  }
  el.innerHTML = list.map(a => buildSidebarItem(a)).join("");
}

function buildSidebarItem(a) {
  const s    = statuses[a.id] || {};
  const led  = s.online ? "led-on" : (s.last_checked ? "led-off" : "led-unk");
  const act  = s.activity || (s.online ? "Active" : "Offline");
  const ms   = s.response_ms ? s.response_ms + "ms" : "";
  return `
  <div class="sb-agent ${currentAgent===a.id?'active':''}" id="sb-a-${a.id}"
       onclick="showAgentDetail('${a.id}')">
    <div class="sb-led ${led}"></div>
    <div class="sb-agent-emoji">${esc(a.emoji||"🤖")}</div>
    <div class="sb-agent-info">
      <div class="sb-agent-name">${esc(a.name)}</div>
      <div class="sb-agent-act">${esc(act)}</div>
    </div>
    ${ms ? `<div class="sb-agent-ms">${ms}</div>` : ""}
  </div>`;
}

function updateSidebarAgent(id) {
  const el = document.getElementById("sb-a-" + id);
  if (!el) return;
  const a = agents[id]; if (!a) return;
  const s = statuses[id] || {};
  const led = s.online ? "led-on" : (s.last_checked ? "led-off" : "led-unk");
  el.querySelector(".sb-led").className = "sb-led " + led;
  el.querySelector(".sb-agent-act").textContent = s.activity || (s.online ? "Active" : "Offline");
  const msEl = el.querySelector(".sb-agent-ms");
  if (msEl) msEl.textContent = s.response_ms ? s.response_ms + "ms" : "";
}

function sidebarSearch(v) {
  sbFilter = v.toLowerCase();
  renderSidebar();
}

function updateGroupFilter() {
  const groups = new Set(["all"]);
  for (const a of Object.values(agents)) groups.add(a.group || "default");
  const sel = document.getElementById("group-filter");
  const cur = sel?.value || "all";
  if (!sel) return;
  sel.innerHTML = [...groups].map(g =>
    `<option value="${g}" ${g===cur?"selected":""}>${g==="all"?"All Groups":g}</option>`
  ).join("");
}

function filterByGroup(g) {
  groupFilter = g;
  renderOverview();
}

// ── Overview ──────────────────────────────────────────────────
function renderOverview() {
  const grid  = document.getElementById("fleet-grid");
  const empty = document.getElementById("empty-stage");
  const sort  = document.getElementById("sort-by")?.value || "name";

  let list = Object.values(agents).filter(a =>
    groupFilter === "all" || (a.group || "default") === groupFilter
  );

  list.sort((a, b) => {
    if (sort === "status") {
      const sa = statuses[a.id]?.online ? 0 : 1;
      const sb = statuses[b.id]?.online ? 0 : 1;
      return sa - sb || a.name.localeCompare(b.name);
    }
    if (sort === "cost") return (costs[b.id]||0) - (costs[a.id]||0);
    return a.name.localeCompare(b.name);
  });

  if (list.length === 0) {
    grid.style.display  = "none";
    empty.style.display = "block";
    return;
  }
  grid.style.display  = "grid";
  empty.style.display = "none";
  grid.innerHTML = list.map(a => buildFleetCard(a)).join("");
}

function buildFleetCard(a) {
  const s     = statuses[a.id] || {};
  const spark = (sparklines[a.id] || []).slice(-24);
  const online = s.online;
  const cls   = online ? "fc-online" : (s.last_checked ? "fc-offline" : "");
  const pillCls = online ? "pill-on" : (s.last_checked ? "pill-off" : "pill-unk");
  const pillTxt = online ? "● Online" : (s.last_checked ? "● Offline" : "● Unknown");
  const cost  = costs[a.id] || 0;

  const sparkHtml = spark.length
    ? spark.map(h => `<span class="sp ${h.online?'g':'r'}"></span>`).join("")
    : `<span style="color:var(--muted);font-size:.65rem">No history</span>`;

  const statsHtml = [
    s.response_ms  ? `<span class="fc-stat">📶 ${s.response_ms}ms</span>` : "",
    s.uptime_human ? `<span class="fc-stat">⏱ ${esc(s.uptime_human)}</span>` : "",
    cost > 0       ? `<span class="fc-stat">💰 $${cost.toFixed(4)}</span>` : "",
    s.model        ? `<span class="fc-stat" style="color:var(--muted2)">${esc(s.model.split("/").pop())}</span>` : "",
  ].filter(Boolean).join("");

  const hasSsh = a.has_ssh_password && a.connection_type !== "http_only";

  return `
  <div class="fleet-card ${cls}" onclick="showAgentDetail('${a.id}')">
    <div class="fc-accent"></div>
    <div class="fc-body">
      <div class="fc-top">
        <div class="fc-emoji">${esc(a.emoji||"🤖")}</div>
        <div class="fc-identity">
          <div class="fc-name">${esc(a.name)}</div>
          <div class="fc-desc">${esc(a.description||a.group||"")}</div>
          <div class="fc-pill ${pillCls}">${pillTxt}</div>
        </div>
      </div>
      <div class="fc-spark">${sparkHtml}</div>
      ${statsHtml ? `<div class="fc-stats">${statsHtml}</div>` : ""}
    </div>
    <div class="fc-actions" onclick="event.stopPropagation()">
      <button class="fca-btn fca-primary" onclick="showAgentDetail('${a.id}')">Open</button>
      ${hasSsh ? `
        <button class="fca-btn fca-restart" onclick="quickCtrl('${a.id}','restart')">↺ Restart</button>
        <button class="fca-btn fca-stop"    onclick="quickCtrl('${a.id}','stop')">⏹ Stop</button>
      ` : ""}
    </div>
  </div>`;
}

function updateAgentCard(id) {
  if (currentView !== "overview") return;
  const a = agents[id]; if (!a) return;
  const card = document.querySelector(`[onclick*="showAgentDetail('${id}')"]`);
  if (card) {
    const tmp = document.createElement("div");
    tmp.innerHTML = buildFleetCard(a);
    card.replaceWith(tmp.firstElementChild);
  }
}

// ── Detail view ───────────────────────────────────────────────
function buildDetailView(id) {
  const a = agents[id]; if (!a) return;
  const s = statuses[id] || {};

  // Header
  document.getElementById("dh-emoji").textContent  = a.emoji || "🤖";
  document.getElementById("dh-name").textContent   = a.name;
  document.getElementById("dh-desc").textContent   = a.description || a.group || "";

  refreshDetailHeader();
  buildDetailChips(a, s);
  buildDetailControls(a, s);

  // Sparkline
  api(`/api/agents/${id}/history?n=48`).then(hist => {
    const el = document.getElementById("d-spark");
    if (!el) return;
    el.innerHTML = hist.length
      ? hist.map(h => `<span class="sp-lg ${h.online?'g':'r'}"></span>`).join("")
      : `<span style="color:var(--muted);font-size:.75rem">No history yet</span>`;
  });

  // Activity
  document.getElementById("d-activity").textContent = s.activity || "Waiting for data…";

  // Mini cost chart
  api(`/api/agents/${id}/costs?days=7`).then(c => {
    costs[id] = c.today || 0;
    updateMetricBar();
    renderMiniCostChart(c.by_day || []);
  });

  // Links + info
  buildDetailLinks(a);
  buildDetailInfo(a, s);

  // Reset tabs
  showDetailTab("overview", document.querySelector(".detail-tabs .dtab"));
  document.getElementById("d-job-log").style.display = "none";
  document.getElementById("d-job-out").innerHTML = "";
  document.getElementById("d-log-viewer").innerHTML = `<div class="log-placeholder">Click Refresh to load logs</div>`;
  document.getElementById("d-config-viewer").textContent = 'Click "Load Config" to read from this agent.';
  document.getElementById("sessions-content").innerHTML = `<div class="tab-placeholder">Click Refresh to load session data</div>`;
  document.getElementById("costs-content").innerHTML    = `<div class="tab-placeholder">Click Refresh to load cost data</div>`;
  document.getElementById("reasoning-content").innerHTML= `<div class="tab-placeholder">Click Refresh to extract reasoning blocks</div>`;

  buildSettingsForm(a);

  // Prime the reasoning agent selector
  const sel = document.getElementById("reasoning-agent-sel");
  if (sel && !sel.querySelector(`option[value="${id}"]`)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = `${a.emoji||"🤖"} ${a.name}`;
    sel.appendChild(opt);
  }
  if (sel) sel.value = id;
}

function refreshDetailHeader() {
  if (!currentAgent) return;
  const s = statuses[currentAgent] || {};
  const badge = document.getElementById("dh-status-badge");
  if (!badge) return;
  if (s.online) {
    badge.className = "status-badge badge-online";
    badge.innerHTML = `<span class="badge-dot g"></span> Online${s.uptime_human ? " · " + s.uptime_human : ""}`;
  } else if (s.last_checked) {
    badge.className = "status-badge badge-offline";
    badge.innerHTML = `<span class="badge-dot r"></span> Offline`;
  } else {
    badge.className = "status-badge badge-unknown";
    badge.innerHTML = `<span class="badge-dot"></span> Checking…`;
  }

  // Activity text
  const actEl = document.getElementById("d-activity");
  if (actEl && s.activity) actEl.textContent = s.activity;
}

function buildDetailChips(a, s) {
  const el = document.getElementById("detail-chips");
  el.innerHTML = [
    { v: s.online ? "🟢 Online" : "🔴 Offline", l: "Status" },
    { v: s.response_ms ? s.response_ms + "ms" : "—", l: "Response" },
    { v: s.uptime_human || "—", l: "Uptime" },
    { v: s.openclaw_version || "—", l: "Version" },
    { v: (costs[a.id] || 0) > 0 ? "$" + (costs[a.id]).toFixed(4) : "—", l: "Cost Today" },
    { v: s.model ? s.model.split("/").pop() : "—", l: "Model" },
  ].map(c => `
    <div class="dc">
      <div class="dc-v" style="font-size:${c.v.length>8?'.85rem':'1.05rem'}">${esc(c.v)}</div>
      <div class="dc-l">${c.l}</div>
    </div>`).join("");
}

function buildDetailControls(a, s) {
  const grid = document.getElementById("d-ctrl-grid");
  const hdr  = document.getElementById("dh-controls");
  const hasSsh = a.has_ssh_password && a.connection_type !== "http_only";

  if (!hasSsh) {
    grid.innerHTML = `
      <div style="color:var(--muted);font-size:.78rem;grid-column:1/-1;padding:.5rem 0;line-height:1.6">
        Controls need SSH access.<br>
        <a onclick="showDetailTab('settings',document.querySelectorAll('.dtab')[6])"
           style="color:var(--brand);cursor:pointer;text-decoration:underline">
          Add SSH credentials in Settings →
        </a>
      </div>`;
    hdr.innerHTML = "";
    return;
  }

  const btns = [
    { action:"restart", icon:"↺", label:"Restart", sub:"Reload the agent",  cls:"cb-restart" },
    { action:"stop",    icon:"⏹", label:"Stop",    sub:"Pause — no data lost", cls:"cb-stop" },
    { action:"start",   icon:"▶", label:"Start",   sub:"Start if stopped",  cls:"cb-start" },
    { action:"repair",  icon:"🔧", label:"Fix Issues", sub:"Reinstall if broken", cls:"cb-repair" },
    { action:"update",  icon:"⬆️", label:"Update",  sub:"Install latest OpenClaw", cls:"cb-update" },
  ];

  grid.innerHTML = btns.map(b => `
    <button class="ctrl-btn ${b.cls}" onclick="detailAction('${b.action}')">
      <span class="ci">${b.icon}</span>
      <span>${b.label}</span>
      <span class="cs">${b.sub}</span>
    </button>`).join("");

  hdr.innerHTML = btns.slice(0,3).map(b => `
    <button class="dh-ctrl-btn dhcb-${b.action}" onclick="detailAction('${b.action}')">
      <span>${b.icon}</span><span>${b.label}</span>
    </button>`).join("");
}

function buildDetailLinks(a) {
  document.getElementById("d-links").innerHTML = `
    <div class="quick-links">
      <a class="ql-link" href="http://${esc(a.host)}:${a.port}/" target="_blank">🌐 Open Gateway</a>
    </div>`;
}

function buildDetailInfo(a, s) {
  const rows = [
    ["Host",       a.host],
    ["Port",       a.port],
    ["Connection", a.connection_type.replace("_"," ")],
    ["Group",      a.group || "default"],
    ["Added",      new Date(a.added_at * 1000).toLocaleDateString()],
  ];
  document.getElementById("d-info-list").innerHTML = rows.map(([l,v]) => `
    <div class="il-row">
      <span class="il-label">${l}</span>
      <span class="il-val">${esc(String(v))}</span>
    </div>`).join("");
}

function renderMiniCostChart(byDay) {
  const el = document.getElementById("d-mini-cost");
  if (!byDay || byDay.length === 0) {
    el.innerHTML = `<span class="mcc-empty">No cost data yet</span>`;
    return;
  }
  const max = Math.max(...byDay.map(d => d.cost), 0.0001);
  el.innerHTML = byDay.slice(-14).map(d => {
    const h   = Math.max(4, Math.round((d.cost / max) * 50));
    const tip = `${d.day}: $${d.cost.toFixed(6)}`;
    return `<div class="mcc-bar" style="height:${h}px" data-tip="${tip}"></div>`;
  }).join("");
}

function showDetailTab(name, btn) {
  document.querySelectorAll(".dtab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".dtab-panel").forEach(p => p.classList.remove("active"));
  if (btn) btn.classList.add("active");
  document.getElementById("dtp-" + name)?.classList.add("active");
}

// ── Detail tab loaders ────────────────────────────────────────
async function loadLogs() {
  if (!currentAgent) return;
  const el = document.getElementById("d-log-viewer");
  el.innerHTML = `<div class="log-placeholder">Loading…</div>`;
  try {
    const r = await api(`/api/agents/${currentAgent}/logs?lines=150`);
    if (r.error && !r.logs?.length) {
      el.innerHTML = `<div class="log-placeholder" style="color:var(--red)">${esc(r.error)}</div>`;
      return;
    }
    el.innerHTML = r.logs.map(line => colorLog(line)).join("\n");
    el.scrollTop = el.scrollHeight;
    window._rawLogs = r.logs;
  } catch (e) {
    el.innerHTML = `<div class="log-placeholder" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

function filterLogs() {
  const q   = document.getElementById("log-filter")?.value.toLowerCase();
  const el  = document.getElementById("d-log-viewer");
  const raw = window._rawLogs;
  if (!raw) return;
  const filtered = q ? raw.filter(l => l.toLowerCase().includes(q)) : raw;
  el.innerHTML   = filtered.map(line => colorLog(line)).join("\n");
}

function colorLog(line) {
  const l = line.toLowerCase();
  let cls = "ll-normal";
  if (l.includes("error") || l.includes("fatal"))  cls = "ll-error";
  else if (l.includes("warn"))                       cls = "ll-warn";
  else if (l.includes("info"))                       cls = "ll-info";
  return `<span class="${cls}">${esc(line)}</span>`;
}

async function loadConfig() {
  if (!currentAgent) return;
  const el = document.getElementById("d-config-viewer");
  el.textContent = "Loading…";
  try {
    const r = await api(`/api/agents/${currentAgent}/config`);
    if (r.config) {
      el.textContent = JSON.stringify(r.config, null, 2);
    } else if (r.raw) {
      el.textContent = r.raw;
    } else {
      el.textContent = "Error: " + (r.error || "No config found");
    }
  } catch (e) {
    el.textContent = "Error: " + e.message;
  }
}

async function loadSessions() {
  if (!currentAgent) return;
  const el = document.getElementById("sessions-content");
  el.innerHTML = `<div class="tab-placeholder">Loading sessions…</div>`;
  try {
    const r = await api(`/api/agents/${currentAgent}/sessions`);
    const sessions = r.sessions || [];
    if (sessions.length === 0) {
      el.innerHTML = `<div class="tab-placeholder">No sessions found${r.note ? " — " + r.note : ""}${r.source === "logs" ? " (parsed from logs)" : ""}</div>`;
      return;
    }
    el.innerHTML = `
      <p style="font-size:.72rem;color:var(--muted);margin-bottom:.75rem">
        Source: ${r.source === "gateway" ? "Gateway API" : "Log parsing (approximate)"}
      </p>
      <table class="sessions-table">
        <thead><tr><th>Session Key</th><th>Channel</th><th>Messages</th><th>Last Activity</th></tr></thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td class="sess-key">${esc(s.key || s.session_key || "—")}</td>
              <td class="sess-chan">${esc(s.channel || "—")}</td>
              <td>${s.messages || s.message_count || "—"}</td>
              <td style="color:var(--muted);font-size:.68rem">${esc((s.last_seen || "").substring(0,40))}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<div class="tab-placeholder" style="color:var(--red)">Error: ${esc(e.message)}</div>`;
  }
}

async function loadCosts() {
  if (!currentAgent) return;
  const el = document.getElementById("costs-content");
  el.innerHTML = `<div class="tab-placeholder">Loading cost data…</div>`;
  try {
    const r = await api(`/api/agents/${currentAgent}/costs?days=14`);
    const byDay = r.by_day || [];

    const summary = `
      <div class="cost-summary">
        <div class="cs-tile">
          <div class="cs-val">$${(r.today||0).toFixed(6)}</div>
          <div class="cs-lbl">Today</div>
        </div>
        <div class="cs-tile">
          <div class="cs-val">$${(r.total||0).toFixed(4)}</div>
          <div class="cs-lbl">Last 14 Days</div>
        </div>
      </div>`;

    if (byDay.length === 0) {
      el.innerHTML = summary + `<div class="tab-placeholder">No cost events recorded yet. Token usage is parsed from agent logs during status checks.</div>`;
      return;
    }

    const max = Math.max(...byDay.map(d => d.cost), 0.0001);
    const bars = byDay.map(d => {
      const h = Math.max(3, Math.round((d.cost / max) * 80));
      return `
        <div class="cc-bar-wrap" title="$${d.cost.toFixed(6)}">
          <div class="cc-bar" style="height:${h}px"></div>
          <div class="cc-day">${d.day.slice(5)}</div>
        </div>`;
    }).join("");

    const detail = r.detail?.length ? `
      <div style="margin-top:1rem">
        <div class="ps-label">By Model</div>
        <table class="sessions-table">
          <thead><tr><th>Date</th><th>Model</th><th>Input Tok</th><th>Output Tok</th><th>Cost</th></tr></thead>
          <tbody>
            ${r.detail.slice(0,20).map(d => `
              <tr>
                <td>${esc(d.day)}</td>
                <td style="color:var(--cyan)">${esc(d.model||"unknown")}</td>
                <td>${(d.in_tok||0).toLocaleString()}</td>
                <td>${(d.out_tok||0).toLocaleString()}</td>
                <td style="color:var(--amber)">$${(d.cost||0).toFixed(6)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>` : "";

    el.innerHTML = summary + `
      <div class="cost-chart-wrap">
        <div class="ps-label">Daily Spend (last 14 days)</div>
        <div class="cost-chart">${bars}</div>
        <div style="font-size:.65rem;color:var(--muted)">Estimated from token usage in logs · actual spend may vary</div>
      </div>` + detail;

  } catch (e) {
    el.innerHTML = `<div class="tab-placeholder" style="color:var(--red)">Error: ${esc(e.message)}</div>`;
  }
}

async function loadReasoning() {
  if (!currentAgent) return;
  const el = document.getElementById("reasoning-content");
  el.innerHTML = `<div class="tab-placeholder">Scanning logs for reasoning blocks…</div>`;
  try {
    const r = await api(`/api/agents/${currentAgent}/reasoning`);
    const blocks = r.blocks || [];
    if (blocks.length === 0) {
      el.innerHTML = `<div class="tab-placeholder">
        No reasoning blocks found.${r.note ? " " + r.note : ""}
        <br><br>
        <strong>Tip:</strong> Enable reasoning on the agent by setting <code>reasoning: "low"</code> (or "medium"/"high") in its config, then check back.
      </div>`;
      return;
    }
    el.innerHTML = blocks.map((b, i) => `
      <div class="reasoning-block">
        <div class="rb-header">Reasoning block ${i+1} of ${blocks.length} — ${esc(b.ts||"")}</div>
        <div class="rb-content">${esc(b.content)}</div>
      </div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="tab-placeholder" style="color:var(--red)">Error: ${esc(e.message)}</div>`;
  }
}

// ── Settings form ─────────────────────────────────────────────
function buildSettingsForm(a) {
  const el = document.getElementById("d-settings-form");
  const connLabel = { http_only:"👁️ Watch Only", direct_ssh:"🖥️ Linux/VPS",
                      proxmox_lxc:"📦 Proxmox LXC", docker:"🐳 Docker" };
  el.innerHTML = `
    <div class="field">
      <label>Icon</label>
      <input type="text" id="se-emoji" value="${esc(a.emoji||"🤖")}" class="emoji-input" style="max-width:70px">
    </div>
    <div class="field">
      <label>Name</label>
      <input type="text" id="se-name" value="${esc(a.name)}">
    </div>
    <div class="field full">
      <label>Description</label>
      <input type="text" id="se-desc" value="${esc(a.description||"")}">
    </div>
    <div class="field">
      <label>Group</label>
      <input type="text" id="se-group" value="${esc(a.group||"default")}">
    </div>
    <div class="field">
      <label>Connection type</label>
      <select id="se-conn" onchange="toggleSshFields()">
        ${Object.entries(connLabel).map(([v,l]) =>
          `<option value="${v}" ${a.connection_type===v?"selected":""}>${l}</option>`
        ).join("")}
      </select>
    </div>
    <div class="field">
      <label>Gateway host</label>
      <input type="text" id="se-host" value="${esc(a.host)}">
    </div>
    <div class="field">
      <label>Gateway port</label>
      <input type="number" id="se-port" value="${a.port}">
    </div>
    <div class="field full">
      <label>Gateway token</label>
      <input type="password" id="se-gw-token" placeholder="${a.has_gateway_token?"(saved — blank to keep)":"Not set"}">
    </div>
    <div id="se-ssh-fields" style="display:contents">
      <div class="field">
        <label>SSH host</label>
        <input type="text" id="se-ssh-host" value="${esc(a.ssh_host||a.host)}">
      </div>
      <div class="field">
        <label>SSH port</label>
        <input type="number" id="se-ssh-port" value="${a.ssh_port||22}">
      </div>
      <div class="field">
        <label>SSH username</label>
        <input type="text" id="se-ssh-user" value="${esc(a.ssh_username||"root")}">
      </div>
      <div class="field">
        <label>SSH password</label>
        <input type="password" id="se-ssh-pass" placeholder="${a.has_ssh_password?"(saved — blank to keep)":"Enter password"}">
      </div>
      ${a.connection_type==="proxmox_lxc"?`
      <div class="field">
        <label>Container ID (VMID)</label>
        <input type="number" id="se-vmid" value="${a.proxmox_vmid||""}">
      </div>`:""}
      ${a.connection_type==="docker"?`
      <div class="field">
        <label>Container name</label>
        <input type="text" id="se-container" value="${esc(a.docker_container||"")}">
      </div>`:""}
    </div>
    <div class="field full">
      <label>Notes</label>
      <input type="text" id="se-notes" value="${esc(a.notes||"")}">
    </div>`;

  toggleSshFields();
}

function toggleSshFields() {
  const conn  = document.getElementById("se-conn")?.value;
  const block = document.getElementById("se-ssh-fields");
  if (block) {
    const fields = block.querySelectorAll("input, select");
    fields.forEach(f => f.closest(".field") && (f.closest(".field").style.display = conn==="http_only" ? "none" : ""));
  }
}

async function saveSettings() {
  if (!currentAgent) return;
  const a = agents[currentAgent];
  const updated = {
    ...a,
    emoji:            v("se-emoji")   || a.emoji,
    name:             v("se-name")    || a.name,
    description:      v("se-desc")    ?? a.description,
    group:            v("se-group")   || a.group,
    host:             v("se-host")    || a.host,
    port:             parseInt(v("se-port")) || a.port,
    connection_type:  v("se-conn")    || a.connection_type,
    ssh_host:         v("se-ssh-host") || null,
    ssh_port:         parseInt(v("se-ssh-port")) || 22,
    ssh_username:     v("se-ssh-user") || "root",
    ssh_password:     v("se-ssh-pass") || null,
    gateway_token:    v("se-gw-token") || null,
    proxmox_vmid:     parseInt(v("se-vmid")) || null,
    docker_container: v("se-container") || null,
    notes:            v("se-notes")   || "",
  };
  try {
    await api(`/api/agents/${currentAgent}`, { method:"PUT", json: updated });
    await loadAll();
    buildDetailView(currentAgent);
  } catch (e) {
    alert("Save failed: " + e.message);
  }
}

async function refreshCurrentAgent() {
  if (!currentAgent) return;
  await api(`/api/agents/${currentAgent}/refresh`, { method:"POST" });
  setTimeout(() => loadAll().then(() => currentAgent && buildDetailView(currentAgent)), 3000);
}

async function removeCurrentAgent() {
  if (!currentAgent) return;
  const a = agents[currentAgent];
  if (!confirm(`Remove ${a.name} from Orchestra? This won't affect the agent itself.`)) return;
  await api(`/api/agents/${currentAgent}`, { method:"DELETE" });
  currentAgent = null;
  await loadAll();
  showView("overview");
}

// ── Control actions ───────────────────────────────────────────
async function detailAction(action) {
  if (!currentAgent) return;
  const a = agents[currentAgent];
  const confirms = {
    stop:   `Stop ${a.name}? The machine stays on — restart any time.`,
    repair: `Run Fix Issues on ${a.name}? Will reinstall OpenClaw if missing.`,
    update: `Update ${a.name} to latest OpenClaw? Service will restart.`,
  };
  if (confirms[action] && !confirm(confirms[action])) return;

  const logEl  = document.getElementById("d-job-out");
  const logBox = document.getElementById("d-job-log");
  logEl.innerHTML = "";
  logBox.style.display = "block";
  appendLog(logEl, { level:"info", timestamp:"", message:"Connecting…" });

  try {
    const r = await api(`/api/agents/${currentAgent}/control`, { method:"POST", json:{ action } });
    streamJob(r.job_id, logEl, () => {
      setTimeout(() => loadAll().then(() => currentAgent && refreshDetailHeader()), 2000);
    });
  } catch (e) {
    appendLog(logEl, { level:"error", timestamp:"", message: String(e.message) });
  }
}

async function quickCtrl(agentId, action) {
  const a = agents[agentId]; if (!a) return;
  if (action === "stop" && !confirm(`Stop ${a.name}? Machine stays on.`)) return;
  try {
    const r = await api(`/api/agents/${agentId}/control`, { method:"POST", json:{ action } });
    if (currentAgent === agentId) {
      const logEl  = document.getElementById("d-job-out");
      const logBox = document.getElementById("d-job-log");
      logEl.innerHTML = "";
      logBox.style.display = "block";
      streamJob(r.job_id, logEl, () => loadAll());
    } else {
      setTimeout(() => loadAll(), 5000);
    }
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function bulkAction(action) {
  const labels = { restart_all:"Restart All", stop_all:"Stop All", start_all:"Start All" };
  if (!confirm(`${labels[action]}? Runs on every agent with SSH configured.`)) return;
  document.getElementById("bulk-modal-title").textContent = labels[action];
  document.getElementById("bulk-log-out").innerHTML = "";
  document.getElementById("bulk-overlay").classList.add("open");
  try {
    const r = await api("/api/bulk", { method:"POST", json:{ action } });
    streamJob(r.job_id, document.getElementById("bulk-log-out"), () => loadAll());
  } catch (e) {
    appendLog(document.getElementById("bulk-log-out"), { level:"error", timestamp:"", message: e.message });
  }
}

function closeBulkModal(e) {
  if (e && e.target !== document.getElementById("bulk-overlay")) return;
  document.getElementById("bulk-overlay").classList.remove("open");
}

function refreshAll() {
  for (const id of Object.keys(agents)) {
    api(`/api/agents/${id}/refresh`, { method:"POST" }).catch(() => {});
  }
}

// ── Job streaming ─────────────────────────────────────────────
function streamJob(jobId, logEl, onDone) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const jws   = new WebSocket(`${proto}://${location.host}/ws/jobs/${jobId}`);
  jws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.level === "status") {
      jws.close();
      if (onDone) onDone();
    } else {
      appendLog(logEl, msg);
      logEl.parentElement?.scrollTo(0, 9999);
    }
  };
  jws.onerror = () => appendLog(logEl, { level:"error", message:"WebSocket error", timestamp:"" });
}

function appendLog(el, msg) {
  const d   = document.createElement("div");
  d.className = `jl-line jl-${msg.level||"info"}`;
  d.innerHTML = `<span class="jl-ts">${msg.timestamp||""}</span><span class="jl-m">${esc(msg.message||"")}</span>`;
  el.appendChild(d);
}

// ── Activity feed ─────────────────────────────────────────────
let _knownEventIds = new Set();

function pushEvents(newEvents) {
  for (const ev of newEvents) {
    const key = ev.agent_id + ev.ts;
    if (_knownEventIds.has(key)) continue;
    _knownEventIds.add(key);
    events.unshift(ev);
  }
  if (events.length > 200) events = events.slice(0, 200);
  if (!activityPaused) renderActivityFeed();
}

function renderActivityFeed() {
  const el = document.getElementById("activity-feed");
  if (events.length === 0) {
    el.innerHTML = `<div class="af-empty">Waiting for events…</div>`;
    return;
  }
  el.innerHTML = events.slice(0, 60).map(ev => {
    const a    = agents[ev.agent_id];
    const s    = statuses[ev.agent_id] || {};
    const led  = s.online ? "var(--green)" : "var(--red)";
    const name = a ? `${a.emoji||"🤖"} ${a.name}` : ev.agent_id.substring(0,8);
    const ts   = new Date(ev.ts * 1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    return `
      <div class="af-event">
        <div class="af-led" style="background:${led}"></div>
        <div class="af-body">
          <div class="af-name">${esc(name)}</div>
          <div class="af-msg">${esc(ev.message||ev.event_type||"")}</div>
        </div>
        <div class="af-ts">${ts}</div>
      </div>`;
  }).join("");
}

function toggleActivityPause() {
  activityPaused = !activityPaused;
  document.getElementById("ap-pause-btn").textContent = activityPaused ? "▶" : "⏸";
  document.getElementById("ap-pause-btn").title = activityPaused ? "Resume feed" : "Pause feed";
}

function clearActivity() {
  events = [];
  _knownEventIds.clear();
  renderActivityFeed();
}

// ── Reasoning panel (sidebar) ─────────────────────────────────
function toggleReasoning() {
  const panel = document.getElementById("reasoning-panel");
  const btn   = document.getElementById("reasoning-toggle");
  const hidden = panel.style.display === "none";
  panel.style.display = hidden ? "flex" : "none";
  btn.textContent = hidden ? "▾" : "▸";
}

async function loadReasoningPanel() {
  const sel = document.getElementById("reasoning-agent-sel");
  const id  = sel?.value; if (!id) return;
  const el  = document.getElementById("reasoning-scroll");
  el.innerHTML = `<div class="rp-empty">Loading…</div>`;
  try {
    const r = await api(`/api/agents/${id}/reasoning`);
    const blocks = r.blocks || [];
    if (blocks.length === 0) {
      el.innerHTML = `<div class="rp-empty">No reasoning blocks found</div>`;
      return;
    }
    el.innerHTML = blocks.slice(-5).reverse().map(b => `
      <div class="rp-block">
        <div class="rp-block-ts">${esc(b.ts||"")}</div>
        ${esc(b.content)}
      </div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="rp-empty" style="color:var(--red)">${esc(e.message)}</div>`;
  }
}

// Populate reasoning agent selector when agents load
function syncReasoningSelector() {
  const sel = document.getElementById("reasoning-agent-sel");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">— select an agent —</option>` +
    Object.values(agents).map(a =>
      `<option value="${a.id}" ${a.id===current?"selected":""}>${esc(a.emoji||"🤖")} ${esc(a.name)}</option>`
    ).join("");
}

// ── Add Agent Wizard ──────────────────────────────────────────
function openWizard() {
  wizardStep = 1;
  gotoStep(1);
  resetWizardFields();
  document.getElementById("wizard-title").textContent = "Add an Agent";
  document.getElementById("wizard-overlay").classList.add("open");
}

function closeWizard(e) {
  if (e && e.target !== document.getElementById("wizard-overlay")) return;
  document.getElementById("wizard-overlay").classList.remove("open");
}

function resetWizardFields() {
  document.getElementById("w-emoji").value = "🤖";
  document.getElementById("w-name").value  = "";
  document.getElementById("w-desc").value  = "";
  document.getElementById("w-group").value = "default";
  document.querySelector('input[name="conn"][value="http_only"]').checked = true;
}

function gotoStep(n) {
  wizardStep = n;
  document.querySelectorAll(".wizard-page").forEach((p,i) => p.classList.toggle("active", i+1===n));
  ["ws-1","ws-2","ws-3"].forEach((id,i) => {
    const el = document.getElementById(id);
    el.classList.toggle("active", i+1===n);
    el.classList.toggle("done",   i+1<n);
  });
  document.getElementById("w-back").style.display = n>1 ? "inline-flex" : "none";
  const next = document.getElementById("w-next");
  next.textContent = n<3 ? "Next →" : "Add Agent";
  if (n===3) buildWizardStep3();
}

function wBack() { if (wizardStep>1) gotoStep(wizardStep-1); }

function wNext() {
  if (wizardStep===1) {
    const name = document.getElementById("w-name").value.trim();
    if (!name) { document.getElementById("w-name").focus(); return; }
    gotoStep(2);
  } else if (wizardStep===2) {
    gotoStep(3);
  } else {
    submitWizard();
  }
}

function buildWizardStep3() {
  const conn  = document.querySelector('input[name="conn"]:checked')?.value || "http_only";
  const el    = document.getElementById("wp3-fields");
  const isSSH = conn !== "http_only";

  el.innerHTML = `
    <div class="fg-row">
      <div class="field" style="flex:1">
        <label>${conn==="proxmox_lxc"?"Proxmox host address":conn==="docker"?"Docker host address":"Host address"} <span class="req">*</span></label>
        <input type="text" id="w-host" placeholder="e.g. 192.168.1.50">
      </div>
      <div class="field" style="max-width:100px">
        <label>Gateway port</label>
        <input type="number" id="w-port" value="18789">
      </div>
    </div>
    <div class="field">
      <label>Gateway token <span style="color:var(--muted)">(optional)</span></label>
      <input type="password" id="w-gw-token" placeholder="Leave blank if not required">
    </div>
    ${isSSH ? `
    <div class="fg-row">
      <div class="field" style="flex:1">
        <label>SSH username</label>
        <input type="text" id="w-ssh-user" value="root">
      </div>
      <div class="field" style="max-width:80px">
        <label>SSH port</label>
        <input type="number" id="w-ssh-port" value="22">
      </div>
    </div>
    <div class="field">
      <label>SSH password <span class="req">*</span></label>
      <input type="password" id="w-ssh-pass" placeholder="Password for SSH access">
    </div>
    ${conn==="proxmox_lxc"?`
    <div class="field">
      <label>Container ID (VMID) <span class="req">*</span></label>
      <input type="number" id="w-vmid" placeholder="e.g. 200">
    </div>`:""}
    ${conn==="docker"?`
    <div class="field">
      <label>Container name / ID <span class="req">*</span></label>
      <input type="text" id="w-container" placeholder="e.g. openclaw-agent">
    </div>`:""}
    ` : ""}`;
}

async function submitWizard() {
  const host = v("w-host");
  if (!host) { document.getElementById("w-host")?.focus(); return; }
  const conn = document.querySelector('input[name="conn"]:checked')?.value || "http_only";
  const agent = {
    name:             v("w-name") || "Agent",
    emoji:            v("w-emoji") || "🤖",
    description:      v("w-desc") || "",
    group:            v("w-group") || "default",
    host,
    port:             parseInt(v("w-port")) || 18789,
    gateway_token:    v("w-gw-token") || null,
    connection_type:  conn,
    ssh_host:         host,
    ssh_port:         parseInt(v("w-ssh-port")) || 22,
    ssh_username:     v("w-ssh-user") || "root",
    ssh_password:     v("w-ssh-pass") || null,
    proxmox_vmid:     parseInt(v("w-vmid")) || null,
    docker_container: v("w-container") || null,
    notes: "",
  };
  const btn = document.getElementById("w-next");
  btn.disabled    = true;
  btn.textContent = "Adding…";
  try {
    await api("/api/agents", { method:"POST", json: agent });
    closeWizard();
    await loadAll();
    syncReasoningSelector();
  } catch (e) {
    alert("Failed: " + e.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Add Agent";
  }
}

// ── Helpers ───────────────────────────────────────────────────
async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method  = init.method || "POST";
    init.headers = { "Content-Type": "application/json", ...(init.headers||{}) };
    init.body    = JSON.stringify(opts.json);
    delete init.json;
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function v(id) {
  return document.getElementById(id)?.value?.trim() ?? null;
}

function setEl(parentId, sel, txt) {
  const el = document.querySelector(`#${parentId} ${sel}`);
  if (el) el.textContent = txt;
}

// Called after data is loaded to sync secondary UI
function _postLoad() {
  syncReasoningSelector();
  renderActivityFeed();
}
