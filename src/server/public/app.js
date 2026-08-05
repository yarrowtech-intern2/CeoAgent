// ---------- State ----------

const state = {
  view: { type: "overview" }, // {type:"overview"} | {type:"department", key} | {type:"accounts"}
  theme: "light", // "light" | "dark" — set for real in initTheme() before first render
  departments: [],
  accounts: [],
  runs: [],
  selectedRunId: null,
  selectedRun: null,
  documents: [],
  liveLinearTasks: [],
  sidebarOpen: false,
  analytics: null,
  logNearBottom: true, // whether the log feed should auto-follow new events
  toolOverrides: new Map(), // toolUseId -> explicit user expand/collapse choice
};

let eventSource = null;
const chartInstances = {};

const NAV_STATIC = {
  overview: { key: "overview", label: "Overview", icon: "crown" },
  accounts: { key: "accounts", label: "Accounts", icon: "plug-zap" },
};

// ---------- Helpers ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function statusLabel(status) {
  return { running: "Running", success: "Done", error: "Failed" }[status] ?? status;
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function formatClock(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Agent text is markdown (Claude formats its responses that way). marked
// renders it to HTML; DOMPurify sanitizes it before it ever touches
// innerHTML, since tool results can carry arbitrary web/file content that
// later gets quoted back in an agent's own reply.
function renderMarkdown(text) {
  if (!text) return "";
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(text, { breaks: true }));
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

function departmentMeta(key) {
  return state.departments.find((d) => d.key === key);
}

function deptColor(key) {
  const meta = departmentMeta(key);
  return meta ? meta.color[state.theme] : null;
}

function sourceLabel(source) {
  if (source === "ceo") return "CEO";
  return departmentMeta(source)?.label ?? capitalize(source);
}

function avatarInitial(source) {
  return (sourceLabel(source) || "?").slice(0, 1).toUpperCase();
}

// ---------- Theme ----------

function initTheme() {
  const saved = localStorage.getItem("theme");
  state.theme = saved === "light" || saved === "dark" ? saved : systemPrefersDark() ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", state.theme);
}

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", state.theme);
  document.documentElement.setAttribute("data-theme", state.theme);
  render(); // chart colors and department accents are theme-dependent — full re-render
}

function viewLabel() {
  if (state.view.type === "overview") return NAV_STATIC.overview.label;
  if (state.view.type === "accounts") return NAV_STATIC.accounts.label;
  return departmentMeta(state.view.key)?.label ?? state.view.key;
}

// ---------- Data loading ----------

async function loadDepartments() {
  state.departments = await fetchJSON("/api/departments");
}

async function loadAccounts() {
  state.accounts = await fetchJSON("/api/accounts");
}

async function loadAnalytics() {
  state.analytics = await fetchJSON("/api/analytics");
}

async function loadRunsForCurrentView() {
  if (state.view.type === "overview") {
    state.runs = await fetchJSON("/api/runs");
  } else if (state.view.type === "department") {
    state.runs = await fetchJSON(`/api/runs?agentKey=${encodeURIComponent(state.view.key)}`);
  } else {
    state.runs = [];
  }
}

async function loadDocumentsForCurrentView() {
  if (state.view.type === "department") {
    state.documents = await fetchJSON(`/api/documents?agentKey=${encodeURIComponent(state.view.key)}`);
  } else {
    state.documents = [];
  }
}

// ---------- View switching ----------

async function switchView(view) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  state.view = view;
  state.selectedRunId = null;
  state.selectedRun = null;
  state.liveLinearTasks = [];
  state.sidebarOpen = false;
  render();
  const loaders = [loadRunsForCurrentView(), loadDocumentsForCurrentView()];
  if (view.type === "overview") loaders.push(loadAnalytics());
  await Promise.all(loaders);
  render();
}

async function selectRun(id) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  state.selectedRunId = id;
  state.sidebarOpen = false;
  state.logNearBottom = true;
  state.toolOverrides = new Map();
  const run = await fetchJSON(`/api/runs/${id}`);
  state.selectedRun = run;
  state.liveLinearTasks = [...run.linearTasks];
  render();

  // The GET above already has every event recorded so far — replay=0 so the
  // stream only adds what happens *after* this point instead of re-sending
  // (and re-appending) the same history a second time.
  eventSource = new EventSource(`/api/runs/${id}/stream?replay=0`);
  eventSource.onmessage = (msg) => handleStreamEvent(JSON.parse(msg.data));
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
  };
}

function extractLinearTask(text) {
  const match = text.match(/^Created (\S+): (.+?)\n(https?:\/\/\S+)/);
  if (!match) return null;
  return { identifier: match[1], title: match[2], url: match[3] };
}

function handleStreamEvent(event) {
  if (!state.selectedRun) return;

  if (event.type === "tool_result" && !event.isError) {
    const task = extractLinearTask(event.text);
    if (task && !state.liveLinearTasks.some((t) => t.identifier === task.identifier)) {
      state.liveLinearTasks.push(task);
    }
  }

  if (event.type !== "run_finished") {
    state.selectedRun.events.push(event);
  } else {
    state.selectedRun.status = event.status;
    state.selectedRun.costUsd = event.costUsd;
    state.selectedRun.summary = event.summary;
    state.selectedRun.linearTasks = state.liveLinearTasks;
    state.selectedRun.sessionId = event.sessionId ?? state.selectedRun.sessionId;
    loadRunsForCurrentView().then(render);
    loadDocumentsForCurrentView().then(render);
  }

  render();
}

// ---------- Actions ----------

async function submitGoal(goal) {
  let id;
  if (state.view.type === "overview") {
    ({ id } = await fetchJSON("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    }));
  } else if (state.view.type === "department") {
    ({ id } = await fetchJSON(`/api/agents/${state.view.key}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    }));
  } else {
    return;
  }
  await loadRunsForCurrentView();
  render();
  await selectRun(id);
}

// Continues a finished run's same agent session (via the server's resume
// endpoint) instead of submitGoal's fresh-run path. Re-fetches the record
// (now flipped back to "running" with the same event history) and opens a
// new stream that skips replay — that history is already in hand, only new
// events from here are wanted.
async function sendReply(id, message) {
  await fetchJSON(`/api/runs/${id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const run = await fetchJSON(`/api/runs/${id}`);
  state.selectedRun = run;
  state.liveLinearTasks = [...run.linearTasks];
  state.logNearBottom = true;
  render();

  eventSource = new EventSource(`/api/runs/${id}/stream?replay=0`);
  eventSource.onmessage = (msg) => handleStreamEvent(JSON.parse(msg.data));
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
  };
}

async function disconnectAccount(key) {
  await fetchJSON(`/api/accounts/${key}/disconnect`, { method: "POST" });
  await loadAccounts();
  render();
}

// Toggle/close the mobile drawer by mutating the existing nodes rather than
// calling render() — a full re-render replaces the sidebar element outright,
// which would skip the CSS slide transition (a brand-new node has no prior
// state to animate from).
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  document.getElementById("sidebar")?.classList.toggle("open", state.sidebarOpen);
  document.getElementById("sidebar-backdrop")?.classList.toggle("open", state.sidebarOpen);
}

function closeSidebar() {
  state.sidebarOpen = false;
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-backdrop")?.classList.remove("open");
}

// ---------- Rendering ----------

function render() {
  const app = document.getElementById("app");

  // render() fully replaces #app's markup on every SSE event, which would
  // otherwise reset .log's scroll to the top each time. Capture whether the
  // reader was following the bottom (or had scrolled up to read history)
  // before the swap, then restore it after.
  const prevLog = app.querySelector(".log");
  const wasNearBottom = prevLog
    ? prevLog.scrollHeight - prevLog.scrollTop - prevLog.clientHeight < 48
    : true;
  const prevScrollTop = prevLog?.scrollTop ?? 0;

  const showSidebar = state.view.type !== "accounts";
  app.innerHTML = `
    ${renderNav()}
    <div class="layout">
      ${showSidebar ? `<div class="sidebar-backdrop${state.sidebarOpen ? " open" : ""}" id="sidebar-backdrop"></div>` : ""}
      ${showSidebar ? renderSidebar() : ""}
      <main class="main">${renderMain()}</main>
    </div>
    <div id="nav-tooltip"></div>
  `;
  attachHandlers();
  if (window.lucide) window.lucide.createIcons();
  initCharts();

  const newLog = app.querySelector(".log");
  if (newLog) {
    if (wasNearBottom) {
      newLog.scrollTop = newLog.scrollHeight;
      state.logNearBottom = true;
    } else {
      newLog.scrollTop = prevScrollTop;
      updateJumpButton(newLog);
    }
  }
}

// ---------- Charts ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function destroyCharts() {
  for (const key of Object.keys(chartInstances)) {
    chartInstances[key]?.destroy();
    delete chartInstances[key];
  }
}

function initCharts() {
  destroyCharts();
  if (!window.Chart || !state.analytics) return;

  const trendCanvas = document.getElementById("chart-trend");
  const deptCanvas = document.getElementById("chart-department");
  if (!trendCanvas && !deptCanvas) return;

  const gridColor = cssVar("--border");
  const mutedColor = cssVar("--text-muted");
  const textColor = cssVar("--text");
  // Sequential blue — the dataviz skill's default trend hue, kept distinct
  // from --accent (brand indigo) so "brand chrome" and "data" never share a
  // color role.
  const trendColor = state.theme === "dark" ? "#3987e5" : "#2a78d6";
  const trendFill = state.theme === "dark" ? "rgba(57,135,229,0.15)" : "rgba(42,120,214,0.12)";

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  if (trendCanvas) {
    const a = state.analytics.runsByDay;
    chartInstances.trend = new Chart(trendCanvas, {
      type: "line",
      data: {
        labels: a.map((d) => fmtDayLabel(d.date)),
        datasets: [
          {
            label: "Runs",
            data: a.map((d) => d.count),
            borderColor: trendColor,
            backgroundColor: trendFill,
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: trendColor,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: mutedColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
          y: {
            beginAtZero: true,
            ticks: { color: mutedColor, precision: 0 },
            grid: { color: gridColor },
          },
        },
      },
    });
  }

  if (deptCanvas) {
    const rows = [...state.analytics.runsByDepartment].sort((a, b) => b.count - a.count);
    chartInstances.department = new Chart(deptCanvas, {
      type: "bar",
      data: {
        labels: rows.map((d) => d.label),
        datasets: [
          {
            data: rows.map((d) => d.count),
            backgroundColor: rows.map((d) => deptColor(d.key)),
            borderRadius: 5,
            maxBarThickness: 28,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { color: mutedColor, precision: 0 }, grid: { color: gridColor } },
          y: { grid: { display: false }, ticks: { color: textColor } },
        },
      },
    });
  }
}

function navButton(key, label, icon, isActive, viewObj, accentColor) {
  const style = accentColor ? ` style="--icon-accent:${accentColor}"` : "";
  return `
    <button class="nav-icon${isActive ? " active" : ""}" data-nav='${escapeHtml(JSON.stringify(viewObj))}' data-label="${escapeHtml(label)}"${style}>
      <i data-lucide="${icon}"></i>
    </button>
  `;
}

function renderNav() {
  const isOverview = state.view.type === "overview";
  const isAccounts = state.view.type === "accounts";
  const showSidebar = state.view.type !== "accounts";

  const deptButtons = state.departments
    .map((d) =>
      navButton(
        d.key,
        d.label,
        d.icon,
        state.view.type === "department" && state.view.key === d.key,
        { type: "department", key: d.key },
        d.color[state.theme],
      ),
    )
    .join("");

  return `
    <nav class="topnav">
      ${
        showSidebar
          ? `<button class="nav-icon menu-toggle" id="sidebar-toggle" data-label="Menu">
               <i data-lucide="menu"></i>
             </button>`
          : ""
      }
      <div class="nav-scroll">
        ${navButton("overview", NAV_STATIC.overview.label, NAV_STATIC.overview.icon, isOverview, { type: "overview" })}
        ${deptButtons}
      </div>
      <div class="nav-divider"></div>
      ${navButton("accounts", NAV_STATIC.accounts.label, NAV_STATIC.accounts.icon, isAccounts, { type: "accounts" })}
      <button class="nav-icon" id="theme-toggle" data-label="${state.theme === "dark" ? "Light mode" : "Dark mode"}">
        <i data-lucide="${state.theme === "dark" ? "sun" : "moon"}"></i>
      </button>
    </nav>
  `;
}

function renderSidebar() {
  const placeholder =
    state.view.type === "overview"
      ? "Describe a goal for the CEO agent to act on…"
      : `Ask ${escapeHtml(viewLabel())} directly…`;
  const accent = state.view.type === "department" ? deptColor(state.view.key) : null;
  const style = accent ? ` style="--dept-accent:${accent}"` : "";

  return `
    <aside class="sidebar${state.sidebarOpen ? " open" : ""}" id="sidebar"${style}>
      <h1>${state.view.type === "overview" ? "CEO Agent OS" : escapeHtml(viewLabel())}</h1>
      ${
        state.view.type === "department"
          ? `<p class="dept-tagline">${escapeHtml(departmentMeta(state.view.key)?.tagline ?? "")}</p>`
          : ""
      }

      <form id="goal-form">
        <textarea id="goal-input" placeholder="${placeholder}" rows="4" required></textarea>
        <span class="ai-button-wrap">
          <button type="submit" id="submit-btn" class="ai-button">
            <i data-lucide="sparkles"></i> Run
          </button>
        </span>
      </form>

      <h2>History</h2>
      <ul class="run-list">
        ${state.runs
          .map(
            (run) => `
          <li class="run-item${run.id === state.selectedRunId ? " selected" : ""}" data-run-id="${run.id}">
            <span class="goal-excerpt">${escapeHtml(run.goal)}</span>
            <span class="item-meta">
              <span class="status-badge ${run.status}">${statusLabel(run.status)}</span>
              ${formatTime(run.createdAt)}
            </span>
          </li>
        `,
          )
          .join("") || '<li class="tasks-empty">No runs yet.</li>'}
      </ul>
    </aside>
  `;
}

function renderMain() {
  if (state.view.type === "accounts") return renderAccountsView();
  if (!state.selectedRun) {
    if (state.view.type === "overview") return renderOverviewDashboard();
    return `<div class="empty-state"><p>Submit a goal to start, or pick a past run from the history.</p></div>`;
  }
  return renderRunDetail();
}

function fmtDayLabel(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statTile(icon, label, value, colorVar) {
  return `
    <div class="stat-tile">
      <div class="stat-icon" style="color:${colorVar}"><i data-lucide="${icon}"></i></div>
      <div class="stat-value">${value}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
    </div>
  `;
}

function renderOverviewDashboard() {
  const a = state.analytics;
  if (!a) return `<div class="empty-state"><p>Loading analytics…</p></div>`;

  const successRate = a.totals.totalRuns
    ? Math.round((a.totals.successRuns / a.totals.totalRuns) * 100)
    : null;

  return `
    <div class="dashboard">
      <div class="dashboard-head">
        <h2>Overview</h2>
        <p class="dept-tagline">Real activity across every agent — submit a goal below, or pick a past run from the history to inspect it.</p>
      </div>

      <div class="stat-grid">
        ${statTile("activity", "Total runs", a.totals.totalRuns, "var(--accent)")}
        ${statTile("check-circle-2", "Success rate", successRate == null ? "—" : `${successRate}%`, "var(--success)")}
        ${statTile("alert-triangle", "Errors", a.totals.errorRuns, a.totals.errorRuns > 0 ? "var(--error)" : "var(--text-faint)")}
        ${statTile("file-text", "Documents", a.totals.totalDocuments, "var(--accent)")}
        ${statTile("list-checks", "Linear tasks", a.totals.totalLinearTasks, "var(--accent)")}
      </div>

      <div class="chart-grid">
        <section class="panel chart-panel">
          <h3>Runs — last 14 days</h3>
          <div class="chart-wrap"><canvas id="chart-trend"></canvas></div>
        </section>
        <section class="panel chart-panel">
          <h3>Runs by department</h3>
          <div class="chart-wrap"><canvas id="chart-department"></canvas></div>
        </section>
      </div>
    </div>
  `;
}

function renderRunDetail() {
  const run = state.selectedRun;
  const showDocuments = state.view.type === "department" && state.view.key !== "manager";

  return `
    <div class="run-detail">
      <header class="run-header">
        <span class="status-badge ${run.status}">${statusLabel(run.status)}</span>
        <h2>${escapeHtml(run.goal)}</h2>
        <span class="run-meta">${run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : ""}</span>
      </header>

      <div class="panels">
        <section class="panel log-panel">
          <h3>Log</h3>
          <div class="log">${renderLog(run.events, run.status)}</div>
          ${run.status !== "running" && run.sessionId ? renderReplyForm() : ""}
        </section>

        <section class="panel side-panels">
          <div class="tasks-panel">
            <h3>Linear tasks</h3>
            <ul class="tasks-list">${renderLinearTasks(state.liveLinearTasks)}</ul>
          </div>
          ${
            showDocuments
              ? `<div class="tasks-panel">
                  <h3>Documents</h3>
                  <ul class="tasks-list">${renderDocuments()}</ul>
                </div>`
              : ""
          }
        </section>
      </div>
    </div>
  `;
}

// Shown once a run has finished and we captured its SDK session ID — lets
// the same agent conversation continue (e.g. answering a clarifying
// question it asked) instead of forcing a brand new, context-less run.
function renderReplyForm() {
  return `
    <form id="reply-form" class="reply-form">
      <textarea id="reply-input" placeholder="Reply to continue this conversation…" rows="1" required></textarea>
      <button type="submit" id="reply-submit-btn" class="reply-submit" aria-label="Send reply">
        <i data-lucide="corner-down-left"></i>
      </button>
    </form>
  `;
}

// A "tool_use" and its matching "tool_result" (joined by toolUseId) render as
// one collapsible card rather than two disconnected log lines — the reader
// cares about the call and its outcome together, not as a sequence.
function renderLog(events, status) {
  const resultsByToolUseId = new Map();
  for (const event of events) {
    if (event.type === "tool_result") resultsByToolUseId.set(event.toolUseId, event);
  }

  const parts = [];
  for (const event of events) {
    if (event.type === "tool_result") continue; // rendered inline with its tool_use
    if (event.type === "text") parts.push(renderTextMessage(event));
    else if (event.type === "tool_use") parts.push(renderToolCard(event, resultsByToolUseId.get(event.toolUseId)));
    else if (event.type === "done") parts.push(renderTurnDivider(event));
  }

  const body = parts.join("");
  if (!body) {
    return status === "running"
      ? `<div class="tasks-empty">Waiting for the agent…</div>${renderTypingIndicator(events)}`
      : '<div class="tasks-empty">No activity.</div>';
  }
  return body + (status === "running" ? renderTypingIndicator(events) : "");
}

function renderTextMessage(event) {
  const color = deptColor(event.source) || "var(--accent)";
  return `
    <div class="msg">
      <span class="msg-avatar" style="background:${color}">${escapeHtml(avatarInitial(event.source))}</span>
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-source">${escapeHtml(sourceLabel(event.source))}</span>
          <span class="msg-time">${formatClock(event.ts)}</span>
        </div>
        <div class="msg-text">${renderMarkdown(event.text)}</div>
      </div>
    </div>
  `;
}

function isToolCardOpen(toolUseId, isError) {
  return state.toolOverrides.has(toolUseId) ? state.toolOverrides.get(toolUseId) : isError;
}

function renderToolCard(event, result) {
  const color = deptColor(event.source) || "var(--accent)";
  const pending = !result;
  const isError = !!result?.isError;
  const statusClass = pending ? "pending" : isError ? "error" : "success";
  const statusIcon = pending ? "loader-circle" : isError ? "x-circle" : "check-circle-2";
  const open = isToolCardOpen(event.toolUseId, isError);

  return `
    <div class="tool-card ${statusClass}${open ? " open" : ""}">
      <button type="button" class="tool-card-head" data-toggle-tool="${event.toolUseId}">
        <span class="msg-avatar" style="background:${color}">${escapeHtml(avatarInitial(event.source))}</span>
        <span class="tool-icon"><i data-lucide="wrench"></i></span>
        <span class="tool-name">${escapeHtml(event.name)}</span>
        <span class="tool-status ${statusClass}"><i data-lucide="${statusIcon}"></i></span>
        <span class="tool-chevron"><i data-lucide="chevron-down"></i></span>
      </button>
      <div class="tool-card-body">
        <div class="tool-block">
          <span class="tool-block-label">Input</span>
          <pre>${escapeHtml(prettyJson(event.input))}</pre>
        </div>
        ${
          result
            ? `<div class="tool-block">
                <span class="tool-block-label">${isError ? "Error" : "Result"}</span>
                <pre>${escapeHtml(result.text)}</pre>
              </div>`
            : `<div class="tool-block pending-note">Waiting for result…</div>`
        }
      </div>
    </div>
  `;
}

function renderTurnDivider(event) {
  const label = event.status === "error" ? "Turn failed" : "Turn complete";
  return `<div class="turn-divider ${event.status}"><span>${escapeHtml(label)} · $${event.costUsd.toFixed(4)} · ${formatClock(event.ts)}</span></div>`;
}

function renderTypingIndicator(events) {
  const lastSourced = [...events].reverse().find((e) => "source" in e);
  const color = (lastSourced && deptColor(lastSourced.source)) || "var(--accent)";
  return `<div class="typing-indicator" style="--dot-color:${color}"><span></span><span></span><span></span></div>`;
}

function renderJumpButton() {
  return `<button type="button" class="log-jump-btn" id="log-jump"><i data-lucide="arrow-down"></i>New activity</button>`;
}

// Called both from the delegated scroll listener (live, no re-render) and
// from render() right after a DOM rebuild, so the pill's presence stays
// correct whether the reader is actively scrolling or a new SSE event just
// redrew the whole log underneath them.
function updateJumpButton(log) {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  state.logNearBottom = nearBottom;
  const existing = document.getElementById("log-jump");
  if (nearBottom) {
    existing?.remove();
    return;
  }
  if (!existing && state.selectedRun?.status === "running") {
    log.insertAdjacentHTML("beforeend", renderJumpButton());
    document.getElementById("log-jump")?.addEventListener("click", () => {
      log.scrollTop = log.scrollHeight;
      updateJumpButton(log);
    });
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderLinearTasks(tasks) {
  if (!tasks.length) return '<li class="tasks-empty">None yet.</li>';
  return tasks
    .map(
      (t) =>
        `<li><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.identifier)}</a><br>${escapeHtml(t.title)}</li>`,
    )
    .join("");
}

function renderDocuments() {
  if (!state.documents.length) return '<li class="tasks-empty">None yet.</li>';
  return state.documents
    .map(
      (d) =>
        `<li class="doc-item" data-doc-id="${d.id}"><strong>${escapeHtml(d.title)}</strong><br><span class="item-meta">${formatTime(d.createdAt)}</span></li>`,
    )
    .join("");
}

function renderAccountsView() {
  return `
    <div class="accounts-view">
      <h2>Connected accounts</h2>
      <p class="dept-tagline">These are the CEO's own accounts — connect them so agents can read and act on real signals.</p>
      <div class="account-cards">
        ${state.accounts
          .map((a) => {
            if (a.unsupported) {
              return `
                <div class="account-card unsupported">
                  <div class="account-card-header">
                    <strong>${escapeHtml(a.label)}</strong>
                    <span class="status-badge error">Unsupported</span>
                  </div>
                  <p class="account-reason">${escapeHtml(a.reason)}</p>
                </div>
              `;
            }
            return `
              <div class="account-card">
                <div class="account-card-header">
                  <strong>${escapeHtml(a.label)}</strong>
                  <span class="status-badge ${a.connected ? "success" : "running"}">${a.connected ? "Connected" : "Not connected"}</span>
                </div>
                ${
                  a.connected
                    ? `<button class="disconnect-btn" data-account-key="${a.key}">Disconnect</button>`
                    : `<a class="connect-btn" href="${a.connectUrl}">Connect ${escapeHtml(a.label)}</a>`
                }
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

// ---------- Event delegation ----------

function attachHandlers() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(JSON.parse(btn.dataset.nav)));
  });

  document.getElementById("sidebar-toggle")?.addEventListener("click", toggleSidebar);
  document.getElementById("sidebar-backdrop")?.addEventListener("click", closeSidebar);
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  document.querySelectorAll(".run-item").forEach((li) => {
    li.addEventListener("click", () => selectRun(li.dataset.runId));
  });

  document.querySelectorAll(".doc-item").forEach((li) => {
    li.addEventListener("click", () => openDocument(li.dataset.docId));
  });

  document.querySelectorAll(".disconnect-btn").forEach((btn) => {
    btn.addEventListener("click", () => disconnectAccount(btn.dataset.accountKey));
  });

  const form = document.getElementById("goal-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("goal-input");
      const goal = input.value.trim();
      if (!goal) return;
      const btn = document.getElementById("submit-btn");
      btn.disabled = true;
      try {
        await submitGoal(goal);
      } finally {
        btn.disabled = false;
      }
    });
  }

  const replyForm = document.getElementById("reply-form");
  if (replyForm) {
    replyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("reply-input");
      const message = input.value.trim();
      if (!message) return;
      const id = state.selectedRunId;
      const btn = document.getElementById("reply-submit-btn");
      btn.disabled = true;
      try {
        await sendReply(id, message);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

async function openDocument(id) {
  const doc = await fetchJSON(`/api/documents/${id}`);
  const win = window.open("", "_blank");
  win.document.write(
    `<title>${escapeHtml(doc.title)}</title><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:24px;max-width:800px;margin:0 auto;">${escapeHtml(doc.content)}</pre>`,
  );
}

// ---------- Nav tooltip ----------
//
// Delegated on `document` (not inside #app) so it survives every render()
// wiping and rebuilding the DOM — attaching this inside attachHandlers()
// would mean re-binding it on every single render for no benefit, since
// nothing here depends on the current view state.
function initNavTooltip() {
  const hoverCapable = window.matchMedia?.("(hover: hover)").matches;
  if (!hoverCapable) return; // touch devices: no hover, nothing to wire up

  const tooltip = () => document.getElementById("nav-tooltip");

  document.addEventListener("mouseover", (e) => {
    const icon = e.target.closest?.(".nav-icon");
    const el = tooltip();
    if (!icon || !el) return;
    const rect = icon.getBoundingClientRect();
    el.textContent = icon.dataset.label ?? "";
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.bottom + 10}px`;
    el.classList.add("visible");
  });

  document.addEventListener("mouseout", (e) => {
    if (!e.target.closest?.(".nav-icon")) return;
    tooltip()?.classList.remove("visible");
  });
}

// ---------- Log interactions ----------
//
// Delegated on `document`, same reasoning as initNavTooltip: .log and its
// tool-cards are recreated on every render(), so binding here once avoids
// rebinding on every SSE event for no benefit.
function initLogInteractions() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-toggle-tool]");
    if (!btn) return;
    const card = btn.closest(".tool-card");
    if (!card) return;
    const nowOpen = !card.classList.contains("open");
    state.toolOverrides.set(btn.dataset.toggleTool, nowOpen);
    card.classList.toggle("open", nowOpen);
  });

  // scroll doesn't bubble in every engine — capture phase catches it
  // regardless, without needing a listener on the (recreated) .log itself.
  document.addEventListener(
    "scroll",
    (e) => {
      const log = e.target.closest?.(".log");
      if (log) updateJumpButton(log);
    },
    true,
  );
}

// ---------- Init ----------

async function init() {
  initTheme();
  initNavTooltip();
  initLogInteractions();
  await Promise.all([loadDepartments(), loadAccounts()]);
  await Promise.all([loadRunsForCurrentView(), loadAnalytics()]);
  render();
}

init();
