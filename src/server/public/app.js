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
  const run = await fetchJSON(`/api/runs/${id}`);
  state.selectedRun = run;
  state.liveLinearTasks = [...run.linearTasks];
  render();

  eventSource = new EventSource(`/api/runs/${id}/stream`);
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
  const showSidebar = state.view.type !== "accounts";
  app.innerHTML = `
    ${renderNav()}
    <div class="layout">
      ${showSidebar ? `<div class="sidebar-backdrop${state.sidebarOpen ? " open" : ""}" id="sidebar-backdrop"></div>` : ""}
      ${showSidebar ? renderSidebar() : ""}
      <main class="main">${renderMain()}</main>
    </div>
  `;
  attachHandlers();
  if (window.lucide) window.lucide.createIcons();
  initCharts();
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
        <button type="submit" id="submit-btn" class="ai-button">
          <i data-lucide="sparkles"></i> Run
        </button>
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

function fmtUsd(n) {
  return `$${(n ?? 0).toFixed(2)}`;
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
        ${statTile("circle-dollar-sign", "Total cost", fmtUsd(a.totals.totalCostUsd), "var(--accent)")}
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
          <div class="log">${renderLog(run.events)}</div>
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

function renderLog(events) {
  return (
    events
      .map((event) => {
        if (event.type === "text") {
          return `<div class="log-line agent-text"><span class="tag">${escapeHtml(event.source)}</span>${escapeHtml(event.text)}</div>`;
        }
        if (event.type === "tool_use") {
          return `<div class="log-line tool_use"><span class="tag">${escapeHtml(event.source)}</span>→ ${escapeHtml(event.name)}(${escapeHtml(JSON.stringify(event.input))})</div>`;
        }
        if (event.type === "tool_result") {
          return `<div class="log-line tool_result${event.isError ? " error" : ""}">${escapeHtml(event.text)}</div>`;
        }
        if (event.type === "done") {
          return `<div class="log-line turn-end">(turn ended — cost so far: $${event.costUsd.toFixed(4)})</div>`;
        }
        return "";
      })
      .join("") || '<div class="tasks-empty">Waiting for the agent…</div>'
  );
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
}

async function openDocument(id) {
  const doc = await fetchJSON(`/api/documents/${id}`);
  const win = window.open("", "_blank");
  win.document.write(
    `<title>${escapeHtml(doc.title)}</title><pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;padding:24px;max-width:800px;margin:0 auto;">${escapeHtml(doc.content)}</pre>`,
  );
}

// ---------- Init ----------

async function init() {
  initTheme();
  await Promise.all([loadDepartments(), loadAccounts()]);
  await Promise.all([loadRunsForCurrentView(), loadAnalytics()]);
  render();
}

init();
