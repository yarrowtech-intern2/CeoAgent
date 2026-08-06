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
  attachment: null, // { filename, text, truncated } | null — a parsed file pending on the goal form
  attaching: false, // true while an upload is being parsed server-side
  attachError: null, // error message from a failed upload, cleared on next attempt
};

let eventSource = null;
let lastRenderKey = null;

const NAV_STATIC = {
  overview: { key: "overview", label: "Overview", icon: "pie-chart" },
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

  // A department page with real run history but nothing selected used to
  // just show a blank "submit a goal" prompt — auto-open the most recent
  // run instead, so landing on e.g. Manager never looks empty when it
  // isn't. Overview is exempt: its own "nothing selected" state is the
  // bento dashboard, not a blank prompt, so there's nothing to fix there.
  if (view.type === "department" && state.runs.length > 0) {
    await selectRun(state.runs[0].id);
    return;
  }

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
  // The record's own displayed goal stays exactly what was typed — the
  // server appends the attachment's text only to what the agent receives,
  // so a large file dump never ends up rendered as a run's heading.
  const attachment = state.attachment ?? undefined;
  let id;
  if (state.view.type === "overview") {
    ({ id } = await fetchJSON("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, attachment }),
    }));
  } else if (state.view.type === "department") {
    ({ id } = await fetchJSON(`/api/agents/${state.view.key}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, attachment }),
    }));
  } else {
    return;
  }
  state.attachment = null;
  state.attachError = null;
  await loadRunsForCurrentView();
  render();
  await selectRun(id);
}

async function uploadAttachment(file) {
  state.attaching = true;
  state.attachment = null;
  state.attachError = null;
  render();

  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/uploads", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `Upload failed (${res.status})`);
    state.attachment = { filename: data.filename, text: data.text, truncated: data.truncated };
  } catch (err) {
    state.attachError = err instanceof Error ? err.message : String(err);
  } finally {
    state.attaching = false;
    render();
  }
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
    <div class="layout">
      ${showSidebar ? `<div class="sidebar-backdrop${state.sidebarOpen ? " open" : ""}" id="sidebar-backdrop"></div>` : ""}
      ${showSidebar ? renderSidebar() : ""}
      <div class="main-column">
        ${renderNav()}
        <main class="main">${renderMain()}</main>
      </div>
    </div>
    <div id="nav-tooltip"></div>
  `;
  attachHandlers();
  if (window.lucide) window.lucide.createIcons();
  initLenis();

  // Only replay the entrance animation on a genuine navigation (different
  // view/department/run), not on every SSE event during an active run —
  // render() fires on every streamed token, and re-fading the whole panel
  // each time would flicker rather than feel smooth.
  const renderKey = `${state.view.type}:${state.view.key ?? ""}:${state.selectedRunId ?? ""}`;
  animateEntrance(renderKey !== lastRenderKey);
  lastRenderKey = renderKey;

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

// ---------- Motion: GSAP entrance + Lenis smooth scroll ----------

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// Bento cells get a staggered fade+rise whenever they're present — always,
// not gated on viewChanged, because the Overview renders once showing a
// "Loading analytics…" placeholder (no .bento-cell yet) and again once
// loadAnalytics() resolves (see switchView()); the cells only actually
// exist starting on that *second* render, which has the same view identity
// as the first, so gating on "did the view change" would miss them
// entirely. Safe to run unconditionally since bento cells only ever appear
// on the Overview, which isn't re-rendered by SSE traffic.
//
// Every other view's root content element only fades on a genuine
// navigation (viewChanged) — render() also fires on every SSE event while
// a run is streaming, and re-fading the whole run-detail panel each time
// would flicker instead of feeling smooth.
function animateEntrance(viewChanged) {
  if (!window.gsap || prefersReducedMotion()) return;
  const cells = document.querySelectorAll(".bento-cell");
  if (cells.length) {
    gsap.fromTo(
      cells,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.5, ease: "power2.out", stagger: 0.06 },
    );
    return;
  }
  if (!viewChanged) return;
  const mainChild = document.querySelector(".main")?.firstElementChild;
  if (mainChild) {
    gsap.fromTo(mainChild, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" });
  }
}

const lenisInstances = new Map();
let lenisRafStarted = false;

function startLenisRaf() {
  if (lenisRafStarted) return;
  lenisRafStarted = true;
  function raf(time) {
    for (const instance of lenisInstances.values()) instance.raf(time);
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
}

// .main is fully recreated on every render() (the whole #app subtree is), so
// its Lenis instance is torn down and rebuilt each time too — cheap enough
// given Lenis is just a scroll-position interpolator. Scoped to .main only:
// .log has its own hand-tuned scroll-preservation/jump-button logic (see
// render()'s scroll-restore block and updateJumpButton()) built and debugged
// earlier in this project, and Lenis's virtual scroll model risks fighting
// that rather than complementing it — not worth the risk for a secondary
// scroll surface.
function initLenis() {
  for (const instance of lenisInstances.values()) instance.destroy();
  lenisInstances.clear();
  if (!window.Lenis || prefersReducedMotion()) return;
  const mainEl = document.querySelector(".main");
  if (!mainEl || !mainEl.firstElementChild) return;
  lenisInstances.set(
    "main",
    new window.Lenis({ wrapper: mainEl, content: mainEl.firstElementChild, autoRaf: false, lerp: 0.12 }),
  );
  startLenisRaf();
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

const ATTACH_ACCEPT =
  ".xlsx,.csv,.pdf,.docx,.txt,.md,.json,.log,.yml,.yaml,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rb,.php,.sh,.sql";

// A file is parsed to plain text server-side on upload, then carried
// as pending state until the goal is submitted, at which point submitGoal
// inlines it into the prompt text — no file tool, no agent-side file access
// needed at all (see attachments.ts for why that's the deliberate choice).
// Shown above .goal-actions only once something is attached or errored; the
// trigger itself lives in .goal-actions as the circular "+" button.
function renderAttachmentRow() {
  if (state.attachment) {
    return `
      <div class="attachment-row">
        <div class="attachment-chip">
          <i data-lucide="file-text"></i>
          <span class="attachment-name">${escapeHtml(state.attachment.filename)}</span>
          ${
            state.attachment.truncated
              ? `<span class="attachment-warn" title="File was large — only the first part was attached"><i data-lucide="alert-triangle"></i></span>`
              : ""
          }
          <button type="button" class="attachment-remove" id="attachment-remove" aria-label="Remove attachment">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
    `;
  }
  if (state.attachError) {
    return `<div class="attachment-row"><span class="attachment-error">${escapeHtml(state.attachError)}</span></div>`;
  }
  return "";
}

function renderGoalActions() {
  return `
    <div class="goal-actions">
      <button type="button" class="attach-circle" id="attach-btn" ${state.attaching ? "disabled" : ""} aria-label="Attach file">
        <i data-lucide="${state.attaching ? "loader-circle" : "plus"}"></i>
      </button>
      <input type="file" id="attach-input" accept="${ATTACH_ACCEPT}" hidden />
      <span class="ai-button-wrap">
        <button type="submit" id="submit-btn" class="ai-button">
          <i data-lucide="sparkles"></i> Run
        </button>
      </span>
    </div>
  `;
}

function renderSidebar() {
  const placeholder =
    state.view.type === "overview"
      ? "Give me a task..."
      : `Ask ${escapeHtml(viewLabel())} directly…`;
  const accent = state.view.type === "department" ? deptColor(state.view.key) : null;
  const style = accent ? ` style="--dept-accent:${accent}"` : "";

  return `
    <aside class="sidebar${state.sidebarOpen ? " open" : ""}" id="sidebar"${style}>
      <h1>${state.view.type === "overview" ? "House of Musa" : escapeHtml(viewLabel())}</h1>
      <p class="sidebar-subtitle">${state.view.type === "overview" ? "Ceo Agent" : escapeHtml(departmentMeta(state.view.key)?.tagline ?? "Department")}</p>

      <form id="goal-form">
        <textarea id="goal-input" placeholder="${placeholder}" rows="4" required></textarea>
        ${renderAttachmentRow()}
        ${renderGoalActions()}
      </form>

      <h2>Tasks lists</h2>
      <ul class="run-list">
        ${state.runs
          .map(
            (run) => `
          <li class="run-item${run.id === state.selectedRunId ? " selected" : ""}" data-run-id="${run.id}">
            <span class="run-checkbox"></span>
            <span class="run-item-body">
              <span class="goal-excerpt">
                <span class="goal-excerpt-text">${escapeHtml(run.goal)}</span>
                <span class="status-dot ${run.status}" title="${escapeHtml(statusLabel(run.status))}"></span>
              </span>
              <span class="item-meta">${formatTime(run.createdAt)}</span>
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

// A cell with a label (only the hero has one, "Overview") gets two direct
// children — the label and the value group — so space-between (see CSS)
// pushes them to opposite ends of the taller hero cell, top and bottom. A
// cell with no label has just the one value-group child, which naturally
// sits at the top instead, matching the reference's secondary cells.
function bentoCell(colorClass, label, value, caption, subvalue) {
  return `
    <div class="bento-cell ${colorClass}">
      ${label ? `<div class="bento-label">${escapeHtml(label)}</div>` : ""}
      <div class="bento-value-group">
        <div class="bento-value">${value}</div>
        <div class="bento-caption">${escapeHtml(caption)}</div>
        ${subvalue ? `<div class="bento-subvalue">${escapeHtml(subvalue)}</div>` : ""}
      </div>
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

      <div class="bento-grid">
        ${bentoCell("bento-mint bento-hero", "Overview", a.totals.totalRuns, "Total runs")}
        ${bentoCell("bento-forest", null, successRate == null ? "—" : `${successRate}%`, "Success rate")}
        ${bentoCell("bento-orange", null, a.totals.errorRuns, "Errors")}
        ${bentoCell("bento-lavender", null, a.totals.totalDocuments, "Documents analysed", `${a.totals.totalLinearTasks} Linear tasks`)}
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

  document.getElementById("attach-btn")?.addEventListener("click", () => {
    document.getElementById("attach-input")?.click();
  });

  document.getElementById("attach-input")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) uploadAttachment(file);
  });

  document.getElementById("attachment-remove")?.addEventListener("click", () => {
    state.attachment = null;
    render();
  });

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
