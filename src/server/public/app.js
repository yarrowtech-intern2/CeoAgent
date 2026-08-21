// ---------- State ----------

const state = {
  view: { type: "overview" }, // {type:"overview"} | {type:"department", key} | {type:"accounts"}
  theme: "light", // "light" | "dark" — set for real in initTheme() before first render
  departments: [],
  accounts: [],
  settings: [], // MaskedField[] from /api/settings — loaded when the Settings view is active
  runs: [],
  showArchived: false, // toggles the sidebar's Tasks lists between active and archived runs
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
  confirmModal: null, // { title, message, confirmLabel, danger, onConfirm } | null
  schedules: [], // ScheduleRecord[] from /api/schedule — loaded when the Calendar department view is active
  calendarView: "week", // "week" | "month" — which main panel renderCalendarView() shows
  calendarCursor: null, // Date (first-of-month currently displayed by the mini calendar / month panel) — lazily set on first render
  calendarWeekCursor: null, // Date (any day within the week shown by the week grid) — lazily set to this week on first render
  calendarSelectedDate: null, // "YYYY-MM-DD" | null — drives the detail panel; lazily set to today on first render
  calendarStatusFilter: "all", // "all" | "active" | "disabled" — filters which schedules render everywhere in the calendar view
  calendarRangeMode: false, // when true, two clicks pick a date range instead of one click just selecting a date
  calendarPendingStart: null, // "YYYY-MM-DD" | null — first click of a range, while awaiting the second
  scheduleModal: null, // draft object | null — see openScheduleModal()/openEditScheduleModal()
  filesChildren: new Map(), // virtual path ("" = roots) -> FileEntry[] already fetched, so re-expanding a folder is instant
  filesExpanded: new Set(), // virtual paths of folders currently expanded in the tree
  filesSelectedPath: null, // virtual path of the selected file/folder, or null
  filesSelectedEntry: null, // the FileEntry for filesSelectedPath
  filesPreview: null, // { kind: "text"|"image"|"pdf"|"none", ... } | "loading" | null — see loadFilePreview()
  filesUploadTarget: null, // virtual path the next Upload click saves into (defaults to the selected/open folder)
  filesUploading: false,
  filesError: null,
};

let eventSource = null;
let lastRenderKey = null;

const NAV_STATIC = {
  overview: { key: "overview", label: "Overview", icon: "pie-chart" },
  files: { key: "files", label: "Files", icon: "folder" },
  accounts: { key: "accounts", label: "Accounts", icon: "plug-zap" },
  settings: { key: "settings", label: "Settings", icon: "settings" },
};

// Shared by render() and renderNav() — Accounts/Files/Settings are full-width
// utility pages with no goal composer or run history, unlike Overview/a
// department.
function isFullWidthView(viewType) {
  return viewType === "accounts" || viewType === "files" || viewType === "settings";
}

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

// Local-date (not UTC) YYYY-MM-DD, matching what the server's scheduler
// compares against — Date#toISOString would shift near midnight in
// timezones behind UTC and silently pick the wrong day.
function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseYmd(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeRecurrence(r) {
  if (r.type === "once") return `once on ${r.date}`;
  const range = `${r.startDate}${r.endDate ? ` to ${r.endDate}` : " onward"}`;
  if (r.type === "daily") return `daily, ${range}`;
  return `weekly on ${r.weekdays.map((d) => WEEKDAY_NAMES[d]).join("/")}, ${range}`;
}

// Whether a recurrence covers a given calendar day — mirrors scheduler.ts's
// isDueToday (minus the time-of-day check, which only matters for firing,
// not for which cells get a dot).
function scheduleActiveOn(schedule, dateStr, dateObj) {
  const r = schedule.recurrence;
  if (r.type === "once") return r.date === dateStr;
  if (dateStr < r.startDate) return false;
  if (r.endDate && dateStr > r.endDate) return false;
  if (r.type === "daily") return true;
  return r.weekdays.includes(dateObj.getDay());
}

function scheduleAgentColor(agentKey) {
  if (agentKey === "ceo") return "var(--accent)";
  return deptColor(agentKey) || "var(--accent)";
}

function matchesStatusFilter(schedule) {
  if (state.calendarStatusFilter === "active") return schedule.enabled;
  if (state.calendarStatusFilter === "disabled") return !schedule.enabled;
  return true;
}

function filteredSchedules() {
  return state.schedules.filter(matchesStatusFilter);
}

/** Monday of the week containing `date` (reference calendar's week starts Monday, not Sunday). */
function mondayOf(date) {
  const day = date.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diff);
  return monday;
}

function weekDates(monday) {
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
}

function scheduleHour(schedule) {
  return Number(schedule.time.split(":")[0]);
}

function scheduleMinute(schedule) {
  return Number(schedule.time.split(":")[1]);
}

function formatHourLabel(hour) {
  const h = ((hour + 11) % 12) + 1;
  return `${h} ${hour < 12 || hour === 24 ? "AM" : "PM"}`;
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

// Matches the CSS `@media (min-width: 720px)` breakpoint (style.css) that
// turns .sidebar from an off-canvas drawer into a permanent column — below
// it, render() moves the composer out of that drawer into .main instead.
const MOBILE_LAYOUT_QUERY = "(max-width: 719.98px)";

function isMobileLayout() {
  return window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches ?? false;
}

// Re-render only when crossing the breakpoint (not on every resize pixel),
// so the composer hops between .sidebar and .main as the viewport crosses
// 720px without spamming re-renders.
function initResponsiveLayout() {
  window.matchMedia?.(MOBILE_LAYOUT_QUERY).addEventListener("change", () => render());
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", state.theme);
  document.documentElement.setAttribute("data-theme", state.theme);
  render(); // chart colors and department accents are theme-dependent — full re-render
}

function viewLabel() {
  if (state.view.type === "overview") return NAV_STATIC.overview.label;
  if (state.view.type === "files") return NAV_STATIC.files.label;
  if (state.view.type === "accounts") return NAV_STATIC.accounts.label;
  if (state.view.type === "settings") return NAV_STATIC.settings.label;
  return departmentMeta(state.view.key)?.label ?? state.view.key;
}

// ---------- Data loading ----------

async function loadDepartments() {
  state.departments = await fetchJSON("/api/departments");
}

async function loadAccounts() {
  state.accounts = await fetchJSON("/api/accounts");
}

async function loadSettings() {
  state.settings = await fetchJSON("/api/settings");
}

async function loadAnalytics() {
  state.analytics = await fetchJSON("/api/analytics");
}

async function loadRunsForCurrentView() {
  const archivedParam = `archived=${state.showArchived}`;
  if (state.view.type === "overview") {
    state.runs = await fetchJSON(`/api/runs?${archivedParam}`);
  } else if (state.view.type === "department") {
    state.runs = await fetchJSON(
      `/api/runs?agentKey=${encodeURIComponent(state.view.key)}&${archivedParam}`,
    );
  } else {
    state.runs = [];
  }
}

async function toggleArchivedFilter() {
  state.showArchived = !state.showArchived;
  await loadRunsForCurrentView();
  render();
}

// Archive/unarchive/delete all refresh the current task list afterward, and
// clear the open run detail if that's the run just acted on — archived runs
// stay viewable via the Archived toggle, but a deleted one no longer exists.
async function archiveRun(id) {
  await fetchJSON(`/api/runs/${id}/archive`, { method: "POST" });
  await loadRunsForCurrentView();
  if (state.selectedRunId === id) {
    state.selectedRunId = null;
    state.selectedRun = null;
  }
  render();
}

async function unarchiveRun(id) {
  await fetchJSON(`/api/runs/${id}/unarchive`, { method: "POST" });
  await loadRunsForCurrentView();
  if (state.selectedRunId === id) {
    state.selectedRunId = null;
    state.selectedRun = null;
  }
  render();
}

function deleteRun(id) {
  openConfirmModal({
    title: "Delete this task?",
    message: "Its log and cost history will be permanently removed. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => performDeleteRun(id),
  });
}

async function performDeleteRun(id) {
  await fetchJSON(`/api/runs/${id}`, { method: "DELETE" });
  await loadRunsForCurrentView();
  if (state.selectedRunId === id) {
    state.selectedRunId = null;
    state.selectedRun = null;
  }
  render();
}

// ---------- Confirm modal ----------
//
// A single reusable centered dialog for anything that needs a yes/no gate
// before a destructive action, replacing window.confirm() with UI that
// matches the app instead of the browser's native prompt.
function openConfirmModal({ title, message, confirmLabel = "Confirm", danger = false, onConfirm }) {
  state.confirmModal = { title, message, confirmLabel, danger, onConfirm };
  render();
}

function closeConfirmModal() {
  state.confirmModal = null;
  render();
}

function renderConfirmModal() {
  const m = state.confirmModal;
  if (!m) return "";
  return `
    <div class="confirm-backdrop" id="confirm-backdrop">
      <div class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <h3 id="confirm-modal-title">${escapeHtml(m.title)}</h3>
        <p class="confirm-modal-message">${escapeHtml(m.message)}</p>
        <div class="confirm-modal-actions">
          <button type="button" class="confirm-btn confirm-btn-cancel" id="confirm-modal-cancel">Cancel</button>
          <button type="button" class="confirm-btn ${m.danger ? "confirm-btn-danger" : "confirm-btn-primary"}" id="confirm-modal-confirm">${escapeHtml(m.confirmLabel)}</button>
        </div>
      </div>
    </div>
  `;
}

async function loadDocumentsForCurrentView() {
  if (state.view.type === "department") {
    state.documents = await fetchJSON(`/api/documents?agentKey=${encodeURIComponent(state.view.key)}`);
  } else {
    state.documents = [];
  }
}

async function loadSchedules() {
  state.schedules = await fetchJSON("/api/schedule");
}

// ---------- Files view ----------

async function loadFilesDir(virtualPath) {
  const data = await fetchJSON(`/api/files/list?path=${encodeURIComponent(virtualPath)}`);
  state.filesChildren.set(virtualPath, data.entries);
  return data.entries;
}

async function loadFilesRoot() {
  state.filesError = null;
  try {
    await loadFilesDir("");
  } catch (err) {
    state.filesError = err instanceof Error ? err.message : String(err);
  }
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".json", ".js", ".ts", ".html", ".css", ".log", ".yml", ".yaml",
]);
const IMAGE_PREVIEW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function fileIconFor(name) {
  const ext = extOf(name);
  if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) return "image";
  if (ext === ".pdf") return "file-text";
  if ([".xlsx", ".xls", ".csv"].includes(ext)) return "file-spreadsheet";
  if ([".doc", ".docx"].includes(ext)) return "file-text";
  if ([".ppt", ".pptx"].includes(ext)) return "presentation";
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return "file-text";
  return "file";
}

async function toggleFilesFolder(path) {
  if (state.filesExpanded.has(path)) {
    state.filesExpanded.delete(path);
    render();
    return;
  }
  state.filesExpanded.add(path);
  render();
  if (!state.filesChildren.has(path)) {
    try {
      await loadFilesDir(path);
    } catch (err) {
      state.filesError = err instanceof Error ? err.message : String(err);
    }
    render();
  }
}

async function selectFilesEntry(entry) {
  state.filesSelectedPath = entry.path;
  state.filesSelectedEntry = entry;
  state.filesError = null;
  if (entry.type === "dir") {
    state.filesUploadTarget = entry.path;
    state.filesPreview = null;
    await toggleFilesFolder(entry.path);
    return;
  }
  // A file's own folder is where "Upload" should land next, not the file itself.
  state.filesUploadTarget = entry.path.split("/").slice(0, -1).join("/");
  state.filesPreview = "loading";
  render();
  await loadFilePreview(entry);
}

async function loadFilePreview(entry) {
  const ext = extOf(entry.name);
  try {
    if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) {
      state.filesPreview = { kind: "image", url: `/api/files/raw?path=${encodeURIComponent(entry.path)}` };
    } else if (ext === ".pdf") {
      state.filesPreview = { kind: "pdf", url: `/api/files/raw?path=${encodeURIComponent(entry.path)}` };
    } else if (TEXT_PREVIEW_EXTENSIONS.has(ext) && (entry.size ?? 0) <= MAX_TEXT_PREVIEW_BYTES) {
      const res = await fetch(`/api/files/raw?path=${encodeURIComponent(entry.path)}`);
      const text = await res.text();
      state.filesPreview = { kind: ext === ".md" ? "markdown" : "text", text };
    } else {
      state.filesPreview = { kind: "none" };
    }
  } catch (err) {
    state.filesPreview = { kind: "none" };
    state.filesError = err instanceof Error ? err.message : String(err);
  }
  render();
}

function formatFileSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function uploadFilesToTarget(fileList) {
  const target = state.filesUploadTarget || state.filesSelectedPath;
  if (!target || !fileList?.length) return;
  state.filesUploading = true;
  state.filesError = null;
  render();
  try {
    const formData = new FormData();
    formData.append("path", target);
    for (const file of fileList) formData.append("files", file);
    const res = await fetch("/api/files/upload", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `upload failed (${res.status})`);
    }
    state.filesChildren.delete(target);
    state.filesExpanded.add(target);
    await loadFilesDir(target);
  } catch (err) {
    state.filesError = err instanceof Error ? err.message : String(err);
  } finally {
    state.filesUploading = false;
    render();
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
  state.showArchived = false;
  state.calendarPendingStart = null;
  state.scheduleModal = null;
  render();
  const loaders = [loadRunsForCurrentView(), loadDocumentsForCurrentView()];
  if (view.type === "overview") loaders.push(loadAnalytics());
  if (view.type === "department" && view.key === "calendar") loaders.push(loadSchedules());
  if (view.type === "files") loaders.push(loadFilesRoot());
  if (view.type === "settings") loaders.push(loadSettings());
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

// ---------- Calendar / scheduled automations ----------

// Lazily initializes the three pieces of "where are we looking" state to
// today, once — separate from state.scheduleModal (what's being created/
// edited) and state.calendarPendingStart (an in-progress range selection).
function ensureCalendarState() {
  if (!state.calendarCursor) {
    const now = new Date();
    state.calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  if (!state.calendarWeekCursor) {
    state.calendarWeekCursor = mondayOf(new Date());
  }
  if (!state.calendarSelectedDate) {
    state.calendarSelectedDate = ymd(new Date());
  }
}

function shiftCalendarMonth(delta) {
  ensureCalendarState();
  state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + delta, 1);
  render();
}

function shiftCalendarWeek(delta) {
  ensureCalendarState();
  const monday = state.calendarWeekCursor;
  state.calendarWeekCursor = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + delta * 7);
  render();
}

function goToToday() {
  const now = new Date();
  state.calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
  state.calendarWeekCursor = mondayOf(now);
  state.calendarSelectedDate = ymd(now);
  render();
}

function setCalendarView(view) {
  state.calendarView = view;
  render();
}

function setCalendarStatusFilter(filter) {
  state.calendarStatusFilter = filter;
  render();
}

function toggleCalendarRangeMode() {
  state.calendarRangeMode = !state.calendarRangeMode;
  state.calendarPendingStart = null;
  render();
}

function clearCalendarSelection() {
  state.calendarPendingStart = null;
  render();
}

// Shared by every clickable date cell (mini calendar and the big month
// grid): a plain click just selects the date (drives the detail panel and
// jumps the week grid to that date's week) — it never opens the create
// modal by surprise. Creating happens explicitly via the toolbar's "+"
// button, the detail panel's "+" button, or completing a 2-click range
// selection, which is unambiguously an intent to create.
function selectCalendarDate(dateStr) {
  if (state.calendarRangeMode) {
    if (!state.calendarPendingStart) {
      state.calendarPendingStart = dateStr;
      render();
      return;
    }
    const start = state.calendarPendingStart < dateStr ? state.calendarPendingStart : dateStr;
    const end = state.calendarPendingStart < dateStr ? dateStr : state.calendarPendingStart;
    state.calendarPendingStart = null;
    openScheduleModal(start, end);
    return;
  }
  state.calendarSelectedDate = dateStr;
  state.calendarWeekCursor = mondayOf(parseYmd(dateStr));
  render();
}

function defaultScheduleAgentKey() {
  return state.departments.find((d) => d.key !== "calendar")?.key ?? state.departments[0]?.key ?? "ceo";
}

function openScheduleModal(start, end) {
  const isRange = start !== end;
  state.scheduleModal = {
    id: null,
    label: "",
    goal: "",
    agentKey: defaultScheduleAgentKey(),
    time: "09:00",
    recurrenceType: isRange ? "daily" : "once",
    date: start,
    startDate: start,
    endDate: end,
    weekdays: [],
    submitting: false,
    error: null,
  };
  render();
}

// Opens the same modal pre-filled from an existing ScheduleRecord, so
// clicking an automation (in the week grid or the detail panel) edits it
// in place rather than only offering toggle/delete from a list.
function openEditScheduleModal(schedule) {
  const r = schedule.recurrence;
  state.scheduleModal = {
    id: schedule.id,
    label: schedule.label,
    goal: schedule.goal,
    agentKey: schedule.agentKey,
    time: schedule.time,
    recurrenceType: r.type,
    date: r.type === "once" ? r.date : "",
    startDate: r.type !== "once" ? r.startDate : "",
    endDate: r.type !== "once" ? (r.endDate ?? "") : "",
    weekdays: r.type === "weekly" ? r.weekdays : [],
    submitting: false,
    error: null,
  };
  render();
}

function closeScheduleModal() {
  state.scheduleModal = null;
  render();
}

// Reads the live form values back into state.scheduleModal before a
// recurrence-type change forces a re-render — render() rebuilds the whole
// modal from state, and without this, whatever the user had already typed
// into label/goal/etc. would be silently discarded by that rebuild.
function syncScheduleModalFromForm() {
  const form = document.getElementById("schedule-form");
  if (!form || !state.scheduleModal) return;
  const weekdays = [...form.querySelectorAll('input[name="weekday"]:checked')].map((cb) => Number(cb.value));
  Object.assign(state.scheduleModal, {
    label: form.label.value,
    goal: form.goal.value,
    agentKey: form.agentKey.value,
    time: form.time.value,
    date: form.date ? form.date.value : state.scheduleModal.date,
    startDate: form.startDate ? form.startDate.value : state.scheduleModal.startDate,
    endDate: form.endDate ? form.endDate.value : state.scheduleModal.endDate,
    weekdays,
  });
}

function changeScheduleRecurrenceType(type) {
  syncScheduleModalFromForm();
  state.scheduleModal.recurrenceType = type;
  render();
}

function buildRecurrenceFromModal(m) {
  if (m.recurrenceType === "once") return { type: "once", date: m.date };
  if (m.recurrenceType === "daily") return { type: "daily", startDate: m.startDate, endDate: m.endDate || undefined };
  return { type: "weekly", weekdays: m.weekdays, startDate: m.startDate, endDate: m.endDate || undefined };
}

async function submitScheduleModal() {
  syncScheduleModalFromForm();
  const m = state.scheduleModal;
  if (!m.label.trim() || !m.goal.trim() || !m.time) {
    m.error = "Label, goal, and time are all required.";
    render();
    return;
  }
  if (m.recurrenceType === "once" && !m.date) {
    m.error = "Pick a date.";
    render();
    return;
  }
  if (m.recurrenceType !== "once" && !m.startDate) {
    m.error = "Pick a start date.";
    render();
    return;
  }
  if (m.recurrenceType === "weekly" && m.weekdays.length === 0) {
    m.error = "Pick at least one weekday.";
    render();
    return;
  }
  m.error = null;
  m.submitting = true;
  render();
  const body = {
    label: m.label.trim(),
    goal: m.goal.trim(),
    agentKey: m.agentKey,
    time: m.time,
    recurrence: buildRecurrenceFromModal(m),
  };
  try {
    if (m.id) {
      await fetchJSON(`/api/schedule/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await fetchJSON("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    await loadSchedules();
    state.scheduleModal = null;
    render();
  } catch (err) {
    m.submitting = false;
    m.error = err instanceof Error ? err.message : String(err);
    render();
  }
}

async function toggleSchedule(id, enabled) {
  await fetchJSON(`/api/schedule/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  await loadSchedules();
  render();
}

function deleteSchedule(id) {
  openConfirmModal({
    title: "Delete this automation?",
    message: "It will stop running and its schedule will be permanently removed. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => performDeleteSchedule(id),
  });
}

async function performDeleteSchedule(id) {
  await fetchJSON(`/api/schedule/${id}`, { method: "DELETE" });
  if (state.scheduleModal?.id === id) state.scheduleModal = null;
  await loadSchedules();
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

  const showSidebar = !isFullWidthView(state.view.type);
  const mobile = isMobileLayout();
  app.innerHTML = `
    <div class="layout">
      ${showSidebar ? `<div class="sidebar-backdrop${state.sidebarOpen ? " open" : ""}" id="sidebar-backdrop"></div>` : ""}
      ${showSidebar ? renderSidebar(mobile) : ""}
      <div class="main-column">
        ${renderNav()}
        <main class="main">
          ${showSidebar && mobile ? renderComposer() : ""}
          ${renderMain()}
        </main>
      </div>
    </div>
    <div id="nav-tooltip"></div>
    ${renderConfirmModal()}
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
  // .main's last child is always the actual view content (.dashboard,
  // .run-detail, .empty-state, .accounts-view) — its first child is the
  // composer on mobile (see render()), which shouldn't replay this fade.
  const mainChild = document.querySelector(".main")?.lastElementChild;
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
  const isFiles = state.view.type === "files";
  const isAccounts = state.view.type === "accounts";
  const isSettings = state.view.type === "settings";
  const showSidebar = !isFullWidthView(state.view.type);

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
        ${navButton("files", NAV_STATIC.files.label, NAV_STATIC.files.icon, isFiles, { type: "files" })}
        ${deptButtons}
      </div>
      <div class="nav-divider"></div>
      ${navButton("accounts", NAV_STATIC.accounts.label, NAV_STATIC.accounts.icon, isAccounts, { type: "accounts" })}
      ${navButton("settings", NAV_STATIC.settings.label, NAV_STATIC.settings.icon, isSettings, { type: "settings" })}
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

// The composer (title + goal form) is rendered as its own function, not
// inlined in renderSidebar(), because on mobile it moves out of the
// off-canvas .sidebar drawer entirely and sits always-visible at the top of
// .main instead (see render()) — only the run history stays behind the
// hamburger there. Desktop keeps it inside .sidebar, unchanged.
function renderComposer() {
  const placeholder =
    state.view.type === "overview"
      ? "Give me a task..."
      : `Ask ${escapeHtml(viewLabel())} directly…`;
  const accent = state.view.type === "department" ? deptColor(state.view.key) : null;
  const style = accent ? ` style="--dept-accent:${accent}"` : "";

  return `
    <div class="composer"${style}>
      <h1>${state.view.type === "overview" ? "House of Musa" : escapeHtml(viewLabel())}</h1>
      <p class="sidebar-subtitle">${state.view.type === "overview" ? "Ceo Agent" : escapeHtml(departmentMeta(state.view.key)?.tagline ?? "Department")}</p>

      <form id="goal-form">
        <div class="goal-input-shell">
          <textarea id="goal-input" placeholder="${placeholder}" rows="4" required></textarea>
        </div>
        ${renderAttachmentRow()}
        ${renderGoalActions()}
      </form>
    </div>
  `;
}

function renderRunActionIcons(run) {
  const archiveIcon = run.archived
    ? `<button type="button" class="run-action-icon" data-unarchive-run="${run.id}" title="Unarchive" aria-label="Unarchive"><i data-lucide="archive-restore"></i></button>`
    : `<button type="button" class="run-action-icon" data-archive-run="${run.id}" title="Archive" aria-label="Archive" ${run.status === "running" ? "disabled" : ""}><i data-lucide="archive"></i></button>`;
  return `
    <span class="run-item-actions">
      ${archiveIcon}
      <button type="button" class="run-action-icon run-action-danger" data-delete-run="${run.id}" title="Delete" aria-label="Delete" ${run.status === "running" ? "disabled" : ""}><i data-lucide="trash-2"></i></button>
    </span>
  `;
}

function renderSidebar(mobile) {
  return `
    <aside class="sidebar${state.sidebarOpen ? " open" : ""}" id="sidebar">
      ${mobile ? "" : renderComposer()}

      <div class="tasks-header">
        <h2>Tasks lists</h2>
        <button type="button" class="archive-toggle-btn" id="toggle-archived-btn">
          ${state.showArchived ? "Active" : "Archived"}
        </button>
      </div>
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
            ${renderRunActionIcons(run)}
          </li>
        `,
          )
          .join("") ||
          `<li class="tasks-empty">${state.showArchived ? "No archived tasks." : "No runs yet."}</li>`}
      </ul>
    </aside>
  `;
}

function renderMain() {
  if (state.view.type === "accounts") return renderAccountsView();
  if (state.view.type === "files") return renderFilesView();
  if (state.view.type === "settings") return renderSettingsView();
  if (!state.selectedRun) {
    if (state.view.type === "overview") return renderOverviewDashboard();
    if (state.view.type === "department" && state.view.key === "calendar") return renderCalendarView();
    return `<div class="empty-state"><p>Submit a goal to start, or pick a past run from the history.</p></div>`;
  }
  return renderRunDetail();
}

// A cell with a label (only the hero has one, "Overview") gets two direct
// children — the label and the value group — so space-between (see CSS)
// pushes them to opposite ends of the taller hero cell, top and bottom. A
// cell with no label has just the one value-group child, which naturally
// sits at the top instead, matching the reference's secondary cells.
function truncateText(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// A translucent multi-segment ring, drawn as plain stacked <circle> arcs —
// no charting library, just stroke-dasharray/-dashoffset math. Opacity is
// applied in CSS (.bento-ring), not baked into these colors, so it stays
// tunable in one place.
function donutRing(segments, { size = 84, strokeWidth = 10 } = {}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) return "";
  const r = (size - strokeWidth) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = (s.value / total) * circumference;
      const circle = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${strokeWidth}" stroke-dasharray="${len} ${circumference - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})" />`;
      offset += len;
      return circle;
    })
    .join("");
  return `<svg class="bento-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${arcs}</svg>`;
}

function bentoDeptBreakdown(runsByDepartment) {
  const items = runsByDepartment.filter((d) => d.count > 0);
  if (!items.length) return '<div class="bento-detail-empty">No runs yet.</div>';
  return `
    <ul data-lenis-prevent class="bento-detail-list bento-dept-breakdown">
      ${items
        .map((d) => {
          const color = departmentMeta(d.key)?.color[state.theme] ?? "currentColor";
          return `<li><span class="bento-dept-dot" style="background:${color}"></span>${escapeHtml(d.label)}<span class="bento-dept-count">${d.count}</span></li>`;
        })
        .join("")}
    </ul>
  `;
}

function bentoErrorList(recentErrors) {
  if (!recentErrors.length) return '<div class="bento-detail-empty">No errors — clean run history.</div>';
  return `
    <ul data-lenis-prevent class="bento-detail-list">
      ${recentErrors
        .map(
          (e) => `
        <li class="bento-detail-item" data-run-id="${e.id}">
          <div class="bento-detail-item-head">
            <strong>${escapeHtml(departmentMeta(e.agentKey)?.label ?? capitalize(e.agentKey))}</strong>
            <span class="bento-detail-time">${formatClock(e.createdAt)}</span>
          </div>
          <div class="bento-detail-goal">${escapeHtml(truncateText(e.goal, 60))}</div>
          <div class="bento-detail-error">${escapeHtml(truncateText(e.error, 90))}</div>
        </li>`,
        )
        .join("")}
    </ul>
  `;
}

function bentoDocumentList(recentDocuments) {
  if (!recentDocuments.length) return '<div class="bento-detail-empty">None yet.</div>';
  return `
    <ul data-lenis-prevent class="bento-detail-list">
      ${recentDocuments
        .map(
          (d) => `
        <li class="bento-detail-item" data-doc-id="${d.id}">
          <strong>${escapeHtml(truncateText(d.title, 46))}</strong>
          <span class="bento-detail-time">${escapeHtml(departmentMeta(d.agentKey)?.label ?? capitalize(d.agentKey))} · ${formatClock(d.createdAt)}</span>
        </li>`,
        )
        .join("")}
    </ul>
  `;
}

function renderOverviewDashboard() {
  const a = state.analytics;
  if (!a) return `<div class="empty-state"><p>Loading analytics…</p></div>`;

  const successRate = a.totals.totalRuns
    ? Math.round((a.totals.successRuns / a.totals.totalRuns) * 100)
    : null;

  const runsRing = donutRing(
    a.runsByDepartment
      .filter((d) => d.count > 0)
      .map((d) => ({ value: d.count, color: departmentMeta(d.key)?.color[state.theme] ?? "currentColor" })),
  );

  const successRing = donutRing([
    { value: a.totals.successRuns, color: "var(--bento-forest-ink)" },
    { value: a.totals.errorRuns, color: "var(--error)" },
    { value: a.totals.runningRuns, color: "var(--warning)" },
  ]);

  return `
    <div class="dashboard">
      <div class="dashboard-head">
        <h2>Overview</h2>
        <p class="dept-tagline">Real activity across every agent — submit a goal below, or pick a past run from the history to inspect it.</p>
      </div>

      <div class="bento-grid">
        <div class="bento-cell bento-mint bento-hero">
          ${runsRing ? `<div class="bento-ring-wrap">${runsRing}</div>` : ""}
          <div class="bento-label">Overview</div>
          <div class="bento-value-group">
            <div class="bento-value">${a.totals.totalRuns}</div>
            <div class="bento-caption">Total runs</div>
          </div>
          ${bentoDeptBreakdown(a.runsByDepartment)}
        </div>

        <div class="bento-cell bento-forest">
          ${successRing ? `<div class="bento-ring-wrap">${successRing}</div>` : ""}
          <div class="bento-value-group">
            <div class="bento-value">${successRate == null ? "—" : `${successRate}%`}</div>
            <div class="bento-caption">Success rate</div>
          </div>
          <div class="bento-status-breakdown">
            <div><span class="bento-dot success"></span>${a.totals.successRuns} success</div>
            <div><span class="bento-dot error"></span>${a.totals.errorRuns} error</div>
            <div><span class="bento-dot running"></span>${a.totals.runningRuns} running</div>
          </div>
        </div>

        <div class="bento-cell bento-orange">
          <div class="bento-value-group">
            <div class="bento-value">${a.totals.errorRuns}</div>
            <div class="bento-caption">Errors</div>
          </div>
          ${bentoErrorList(a.recentErrors)}
        </div>

        <div class="bento-cell bento-lavender">
          <div class="bento-value-group">
            <div class="bento-value">${a.totals.totalDocuments}</div>
            <div class="bento-caption">Documents analysed</div>
            <div class="bento-subvalue">${a.totals.totalLinearTasks} Linear tasks</div>
          </div>
          ${bentoDocumentList(a.recentDocuments)}
        </div>
      </div>
    </div>
  `;
}

function renderRunDetail() {
  const run = state.selectedRun;
  const showDocuments = state.view.type === "department" && state.view.key !== "manager";
  const source = run.agentKey === "ceo" ? "CEO" : (departmentMeta(run.agentKey)?.label ?? capitalize(run.agentKey));
  const timestamps = [
    `Started ${formatTime(run.createdAt)}`,
    run.finishedAt ? `Finished ${formatTime(run.finishedAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="run-detail">
      <header class="run-header">
        <span class="status-badge ${run.status}">${statusLabel(run.status)}</span>
        ${run.archived ? `<span class="status-badge archived">Archived</span>` : ""}
        <span class="run-meta">${run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : ""}</span>
        <div class="run-actions">
          ${
            run.archived
              ? `<button type="button" class="run-action-btn" data-unarchive-run="${run.id}" title="Unarchive" aria-label="Unarchive"><i data-lucide="archive-restore"></i></button>`
              : `<button type="button" class="run-action-btn" data-archive-run="${run.id}" title="Archive" aria-label="Archive" ${run.status === "running" ? "disabled" : ""}><i data-lucide="archive"></i></button>`
          }
          <button type="button" class="run-action-btn run-action-danger" data-delete-run="${run.id}" title="Delete" aria-label="Delete" ${run.status === "running" ? "disabled" : ""}><i data-lucide="trash-2"></i></button>
        </div>
        <h2>${escapeHtml(run.goal)}</h2>
        <p class="run-subheader">${escapeHtml(source)} · ${timestamps}</p>
      </header>

      <div class="panels">
        <section class="panel log-panel">
          <h3>Log</h3>
          <div class="log" data-lenis-prevent>${renderLog(run.events, run.status)}</div>
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
            if (a.configOnly) {
              return `
                <div class="account-card">
                  <div class="account-card-header">
                    <strong>${escapeHtml(a.label)}</strong>
                    <span class="status-badge ${a.connected ? "success" : "running"}">${a.connected ? "Connected" : "Not connected"}</span>
                  </div>
                  ${
                    a.connected
                      ? `<p class="account-reason">Managed from the Settings screen — clear the key there to disconnect.</p>`
                      : `<p class="account-reason">${escapeHtml(a.configHint)}</p><a class="connect-btn" href="${a.signupUrl}" target="_blank" rel="noopener">Get an API key</a>`
                  }
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

// ---------- Settings view ----------
//
// Replaces hand-editing .env for packaged installs. Fields never show a
// saved value — only a masked placeholder plus a "Set" badge — so the form
// can safely POST just the fields the user actually typed into, without ever
// re-sending (or blanking out) an already-saved secret.

function renderSettingsView() {
  const groups = new Map();
  for (const field of state.settings) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }

  return `
    <div class="settings-view">
      <h2>Settings</h2>
      <p class="dept-tagline">API keys and credentials for connected services. Saved values are never displayed again — only whether a key is currently set.</p>
      <form id="settings-form">
        ${[...groups.entries()]
          .map(
            ([group, fields]) => `
              <div class="settings-group">
                <h3>${escapeHtml(group)}</h3>
                ${fields
                  .map(
                    (f) => `
                      <label class="settings-field">
                        <span class="settings-field-label">
                          ${escapeHtml(f.label)}
                          ${f.isSet ? `<span class="status-badge success">Set</span>` : ""}
                        </span>
                        <input type="text" name="${escapeHtml(f.envVar)}" placeholder="${f.isSet ? escapeHtml(f.masked) : "Not set"}" autocomplete="off" spellcheck="false" />
                      </label>
                    `,
                  )
                  .join("")}
              </div>
            `,
          )
          .join("")}
        <div class="settings-actions">
          <button type="submit" class="ai-button">Save</button>
        </div>
      </form>
    </div>
  `;
}

async function saveSettings(form) {
  const payload = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === "string" && value.trim() !== "") payload[key] = value.trim();
  }
  if (!Object.keys(payload).length) return;
  await fetchJSON("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await Promise.all([loadSettings(), loadAccounts()]);
  render();
}

// ---------- Files view ----------
//
// A two-pane VS Code-style browser: a lazily-expanding folder tree on the
// left (each root — Company Data / Deliverables / Agent Files — loads its
// children only once expanded), a preview + details pane on the right.
// Deliberately its own full-width view (no composer sidebar, like Accounts)
// since browsing files has nothing to do with the goal composer.

function renderFilesTreeNode(entry, depth) {
  const isDir = entry.type === "dir";
  const isExpanded = isDir && state.filesExpanded.has(entry.path);
  const isSelected = state.filesSelectedPath === entry.path;
  const indent = 10 + depth * 16;

  const rowIcon = isDir
    ? `<i data-lucide="${isExpanded ? "folder-open" : "folder"}"></i>`
    : `<i data-lucide="${fileIconFor(entry.name)}"></i>`;

  const chevron = isDir
    ? `<i class="files-chevron" data-lucide="${isExpanded ? "chevron-down" : "chevron-right"}"></i>`
    : `<span class="files-chevron"></span>`;

  const row = `
    <div class="files-row${isSelected ? " selected" : ""}" data-files-path="${escapeHtml(entry.path)}" data-files-type="${entry.type}" style="padding-left:${indent}px" title="${escapeHtml(entry.name)}">
      ${chevron}
      <span class="files-row-icon">${rowIcon}</span>
      <span class="files-row-name">${escapeHtml(entry.name)}</span>
    </div>
  `;

  if (!isDir || !isExpanded) return row;

  const children = state.filesChildren.get(entry.path);
  const childrenHtml =
    children === undefined
      ? `<div class="files-row files-loading" style="padding-left:${indent + 16}px">Loading…</div>`
      : children.length === 0
        ? `<div class="files-row files-empty-row" style="padding-left:${indent + 16}px">Empty folder</div>`
        : children.map((c) => renderFilesTreeNode(c, depth + 1)).join("");

  return row + childrenHtml;
}

function renderFilesPreview() {
  const entry = state.filesSelectedEntry;
  if (!entry) {
    return `
      <div class="files-preview-empty">
        <i data-lucide="folder-open"></i>
        <p>Select a folder to browse, or a file to preview it here.</p>
      </div>
    `;
  }

  const crumb = entry.path
    .split("/")
    .map((seg, i, arr) => (i === arr.length - 1 ? escapeHtml(seg) : `${escapeHtml(seg)} <span class="files-crumb-sep">/</span> `))
    .join("");

  if (entry.type === "dir") {
    const children = state.filesChildren.get(entry.path) ?? [];
    const count = children.length;
    const folderCount = children.filter((c) => c.type === "dir").length;
    const fileCount = count - folderCount;
    return `
      <div class="files-preview-head">
        <div class="files-crumb">${crumb}</div>
        <button type="button" class="files-upload-btn" id="files-upload-btn">
          <i data-lucide="upload"></i> Upload here
        </button>
      </div>
      <div class="files-preview-empty">
        <i data-lucide="folder"></i>
        <p>${folderCount} folder${folderCount === 1 ? "" : "s"}, ${fileCount} file${fileCount === 1 ? "" : "s"}</p>
      </div>
    `;
  }

  const downloadUrl = `/api/files/raw?path=${encodeURIComponent(entry.path)}&download=1`;
  const meta = `${formatFileSize(entry.size)}${entry.modifiedAt ? ` · edited ${new Date(entry.modifiedAt).toLocaleString()}` : ""}`;

  let body = `<div class="files-preview-empty"><i data-lucide="file"></i><p>Preview not available for this file type — download to view it.</p></div>`;
  if (state.filesPreview === "loading") {
    body = `<div class="files-preview-empty"><p>Loading preview…</p></div>`;
  } else if (state.filesPreview?.kind === "image") {
    body = `<div class="files-preview-media"><img src="${state.filesPreview.url}" alt="${escapeHtml(entry.name)}" /></div>`;
  } else if (state.filesPreview?.kind === "pdf") {
    body = `<iframe class="files-preview-frame" src="${state.filesPreview.url}" title="${escapeHtml(entry.name)}"></iframe>`;
  } else if (state.filesPreview?.kind === "markdown") {
    body = `<div class="files-preview-doc">${renderMarkdown(state.filesPreview.text)}</div>`;
  } else if (state.filesPreview?.kind === "text") {
    body = `<pre class="files-preview-text">${escapeHtml(state.filesPreview.text)}</pre>`;
  }

  return `
    <div class="files-preview-head">
      <div class="files-crumb">${crumb}</div>
      <div class="files-preview-actions">
        <button type="button" class="files-upload-btn" id="files-upload-btn">
          <i data-lucide="upload"></i> Upload here
        </button>
        <a class="files-download-btn" href="${downloadUrl}"><i data-lucide="download"></i> Download</a>
      </div>
    </div>
    <div class="files-preview-meta">${escapeHtml(meta)}</div>
    <div class="files-preview-body">${body}</div>
  `;
}

function renderFilesView() {
  const roots = state.filesChildren.get("") ?? [];
  return `
    <div class="files-view">
      <aside class="files-tree" data-lenis-prevent>
        <div class="files-tree-head">
          <h2>Files</h2>
          <input type="file" id="files-upload-input" multiple hidden />
        </div>
        ${state.filesError ? `<div class="files-error">${escapeHtml(state.filesError)}</div>` : ""}
        ${
          roots.length
            ? roots.map((r) => renderFilesTreeNode(r, 0)).join("")
            : `<div class="files-row files-loading">Loading…</div>`
        }
      </aside>
      <div class="files-preview-pane">
        ${state.filesUploading ? `<div class="files-uploading-banner">Uploading…</div>` : ""}
        ${renderFilesPreview()}
      </div>
    </div>
  `;
}

// ---------- Calendar view ----------

function formatWeekRangeLabel(monday) {
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const sameMonth = monday.getMonth() === sunday.getMonth() && monday.getFullYear() === sunday.getFullYear();
  const startStr = monday.toLocaleDateString([], { month: "short", day: "numeric" });
  const endStr = sunday.toLocaleDateString(
    [],
    sameMonth ? { day: "numeric", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
  return `${startStr} – ${endStr}`;
}

// Default business-hours-ish window, widened to include any schedule that
// actually falls outside it that week — nothing is ever hidden just because
// it fires at an unusual hour.
function weekHourRange(days, active) {
  let min = 7;
  let max = 21;
  for (const s of active) {
    for (const d of days) {
      const dateStr = ymd(d);
      if (!scheduleActiveOn(s, dateStr, d)) continue;
      const h = scheduleHour(s);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return [min, max];
}

function renderMiniCalendar() {
  ensureCalendarState();
  const cursor = state.calendarCursor;
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayStr = ymd(new Date());
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const active = filteredSchedules();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(`<span class="mini-cell empty"></span>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateStr = ymd(dateObj);
    const hasSchedule = active.some((s) => scheduleActiveOn(s, dateStr, dateObj));
    const classes = ["mini-cell"];
    if (dateStr === todayStr) classes.push("today");
    if (dateStr === state.calendarSelectedDate) classes.push("selected");
    if (dateStr === state.calendarPendingStart) classes.push("pending");
    cells.push(`
      <button type="button" class="${classes.join(" ")}" data-date="${dateStr}">
        ${day}${hasSchedule ? `<span class="mini-dot"></span>` : ""}
      </button>
    `);
  }

  return `
    <div class="mini-calendar">
      <div class="mini-calendar-head">
        <button type="button" class="run-action-icon" id="mini-cal-prev" aria-label="Previous month"><i data-lucide="chevron-left"></i></button>
        <strong>${cursor.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
        <button type="button" class="run-action-icon" id="mini-cal-next" aria-label="Next month"><i data-lucide="chevron-right"></i></button>
      </div>
      <div class="mini-weekdays">${WEEKDAY_NAMES.map((d) => `<span>${d[0]}</span>`).join("")}</div>
      <div class="mini-grid">${cells.join("")}</div>
    </div>
  `;
}

function renderMonthGrid() {
  ensureCalendarState();
  const cursor = state.calendarCursor;
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayStr = ymd(new Date());
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const active = filteredSchedules();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(`<div class="calendar-cell empty"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateStr = ymd(dateObj);
    const items = active.filter((s) => scheduleActiveOn(s, dateStr, dateObj));
    const dots = items
      .slice(0, 4)
      .map((s) => `<span class="calendar-dot" style="background:${scheduleAgentColor(s.agentKey)}" title="${escapeHtml(s.label)}"></span>`)
      .join("");
    const classes = ["calendar-cell"];
    if (dateStr === todayStr) classes.push("today");
    if (dateStr === state.calendarSelectedDate) classes.push("selected");
    if (dateStr === state.calendarPendingStart) classes.push("pending");
    cells.push(`
      <button type="button" class="${classes.join(" ")}" data-date="${dateStr}">
        <span class="calendar-cell-num">${day}</span>
        <span class="calendar-cell-dots">${dots}</span>
      </button>
    `);
  }

  return `
    <div class="calendar-weekdays">${WEEKDAY_NAMES.map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="calendar-grid">${cells.join("")}</div>
  `;
}

function renderWeekGrid() {
  ensureCalendarState();
  const monday = state.calendarWeekCursor;
  const days = weekDates(monday);
  const todayStr = ymd(new Date());
  const nowHour = new Date().getHours();
  const active = filteredSchedules();
  const [minHour, maxHour] = weekHourRange(days, active);

  const parts = [`<div class="week-cell week-corner"></div>`];
  for (const d of days) {
    const dateStr = ymd(d);
    const classes = ["week-day-head"];
    if (dateStr === todayStr) classes.push("today");
    if (dateStr === state.calendarSelectedDate) classes.push("selected");
    parts.push(`
      <button type="button" class="${classes.join(" ")}" data-date="${dateStr}">
        <span class="week-day-name">${WEEKDAY_NAMES[d.getDay()]}</span>
        <span class="week-day-num">${d.getDate()}</span>
      </button>
    `);
  }

  for (let h = minHour; h <= maxHour; h++) {
    const isCurrentHour = h === nowHour;
    parts.push(`<div class="week-hour-label${isCurrentHour ? " current" : ""}">${formatHourLabel(h)}</div>`);
    for (const d of days) {
      const dateStr = ymd(d);
      const items = active.filter((s) => scheduleActiveOn(s, dateStr, d) && scheduleHour(s) === h);
      const chips = items
        .map(
          (s) => `
        <button type="button" class="week-chip${s.enabled ? "" : " disabled"}" style="--chip-color:${scheduleAgentColor(s.agentKey)}" data-edit-schedule="${s.id}" title="${escapeHtml(s.label)}">
          <span class="week-chip-time">${s.time}</span>
          <span class="week-chip-label">${escapeHtml(s.label)}</span>
        </button>
      `,
        )
        .join("");
      const isNow = dateStr === todayStr && isCurrentHour;
      parts.push(`<div class="week-cell${isNow ? " current" : ""}">${chips}</div>`);
    }
  }

  return `
    <div class="week-grid-wrap">
      <div class="week-grid">${parts.join("")}</div>
    </div>
  `;
}

function renderDetailPanel() {
  ensureCalendarState();
  const dateStr = state.calendarSelectedDate;
  const dateObj = parseYmd(dateStr);
  const items = filteredSchedules().filter((s) => scheduleActiveOn(s, dateStr, dateObj));
  const dateLabel = dateObj.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const body = items.length
    ? items
        .map(
          (s) => `
      <div class="detail-card" style="--chip-color:${scheduleAgentColor(s.agentKey)}">
        <div class="detail-card-head">
          <span class="detail-card-title">${escapeHtml(s.label)}</span>
          <span class="detail-card-time">${s.time}</span>
        </div>
        <div class="detail-card-meta">${escapeHtml(sourceLabel(s.agentKey))} · ${escapeHtml(describeRecurrence(s.recurrence))}</div>
        <div class="detail-card-goal">${escapeHtml(truncateText(s.goal, 90))}</div>
        <div class="detail-card-actions">
          <button type="button" class="toggle-switch${s.enabled ? " on" : ""}" data-toggle-schedule="${s.id}" data-enabled="${s.enabled}" role="switch" aria-checked="${s.enabled}" aria-label="${s.enabled ? "Disable" : "Enable"} ${escapeHtml(s.label)}">
            <span class="toggle-knob"></span>
          </button>
          <button type="button" class="run-action-icon" data-edit-schedule="${s.id}" title="Edit" aria-label="Edit"><i data-lucide="pencil"></i></button>
          <button type="button" class="run-action-icon run-action-danger" data-delete-schedule="${s.id}" title="Delete" aria-label="Delete"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
    `,
        )
        .join("")
    : `<div class="bento-detail-empty">No automations on this date.</div>`;

  return `
    <div class="detail-panel">
      <div class="detail-panel-head">
        <strong>${escapeHtml(dateLabel)}</strong>
        <button type="button" class="run-action-icon" id="detail-add-schedule" title="New automation" aria-label="New automation"><i data-lucide="plus"></i></button>
      </div>
      <div class="detail-panel-body">${body}</div>
    </div>
  `;
}

function renderScheduleList() {
  const items = filteredSchedules();
  if (!items.length) {
    return `<div class="bento-detail-empty">No automations match this filter.</div>`;
  }
  return `
    <ul class="schedule-list">
      ${items
        .map(
          (s) => `
        <li class="schedule-item${s.enabled ? "" : " disabled"}">
          <span class="calendar-dot" style="background:${scheduleAgentColor(s.agentKey)}"></span>
          <span class="schedule-item-body">
            <span class="schedule-item-label">${escapeHtml(s.label)}</span>
            <span class="item-meta">${escapeHtml(sourceLabel(s.agentKey))} · ${s.time} · ${escapeHtml(describeRecurrence(s.recurrence))}${s.lastFiredDate ? ` · last ran ${s.lastFiredDate}` : ""}</span>
          </span>
          <span class="schedule-item-actions">
            <button type="button" class="toggle-switch${s.enabled ? " on" : ""}" data-toggle-schedule="${s.id}" data-enabled="${s.enabled}" role="switch" aria-checked="${s.enabled}" aria-label="${s.enabled ? "Disable" : "Enable"} ${escapeHtml(s.label)}">
              <span class="toggle-knob"></span>
            </button>
            <button type="button" class="run-action-icon" data-edit-schedule="${s.id}" title="Edit" aria-label="Edit"><i data-lucide="pencil"></i></button>
            <button type="button" class="run-action-icon run-action-danger" data-delete-schedule="${s.id}" title="Delete" aria-label="Delete"><i data-lucide="trash-2"></i></button>
          </span>
        </li>
      `,
        )
        .join("")}
    </ul>
  `;
}

function renderCalendarTabs() {
  const tabs = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "disabled", label: "Disabled" },
  ];
  return `
    <div class="calendar-tabs">
      ${tabs
        .map(
          (t) =>
            `<button type="button" class="calendar-tab${state.calendarStatusFilter === t.key ? " active" : ""}" data-calendar-status="${t.key}">${t.label}</button>`,
        )
        .join("")}
    </div>
  `;
}

function renderCalendarToolbar() {
  ensureCalendarState();
  const label =
    state.calendarView === "week"
      ? formatWeekRangeLabel(state.calendarWeekCursor)
      : state.calendarCursor.toLocaleDateString([], { month: "long", year: "numeric" });

  return `
    <div class="calendar-toolbar">
      <div class="calendar-toolbar-left">
        <button type="button" class="archive-toggle-btn" id="calendar-today">Today</button>
        <div class="calendar-nav-arrows">
          <button type="button" class="run-action-icon" id="calendar-prev" aria-label="Previous"><i data-lucide="chevron-left"></i></button>
          <button type="button" class="run-action-icon" id="calendar-next" aria-label="Next"><i data-lucide="chevron-right"></i></button>
        </div>
        <strong class="calendar-range-label">${escapeHtml(label)}</strong>
      </div>
      <div class="calendar-toolbar-right">
        ${
          state.calendarRangeMode && state.calendarPendingStart
            ? `<span class="calendar-hint">Selecting range from ${state.calendarPendingStart} — click the end date. <button type="button" class="link-btn" id="calendar-clear-selection">Cancel</button></span>`
            : ""
        }
        <button type="button" class="archive-toggle-btn${state.calendarRangeMode ? " active" : ""}" id="calendar-range-toggle">
          ${state.calendarRangeMode ? "Range: on" : "Select a range"}
        </button>
        <div class="view-toggle">
          <button type="button" class="view-toggle-btn${state.calendarView === "week" ? " active" : ""}" data-calendar-view="week">Week</button>
          <button type="button" class="view-toggle-btn${state.calendarView === "month" ? " active" : ""}" data-calendar-view="month">Month</button>
        </div>
        <button type="button" class="ai-button" id="calendar-add"><i data-lucide="plus"></i> Schedule automation</button>
      </div>
    </div>
  `;
}

function renderCalendarView() {
  ensureCalendarState();
  return `
    <div class="calendar-view">
      <div class="calendar-view-head">
        <h2>Calendar</h2>
        ${renderCalendarTabs()}
      </div>

      ${renderCalendarToolbar()}

      <div class="calendar-columns">
        <aside class="calendar-side">
          ${renderMiniCalendar()}
          ${renderDetailPanel()}
        </aside>
        <div class="calendar-main">
          ${state.calendarView === "week" ? renderWeekGrid() : renderMonthGrid()}
        </div>
      </div>

      <div class="tasks-panel schedule-panel">
        <h3>All scheduled automations</h3>
        ${renderScheduleList()}
      </div>
    </div>
    ${renderScheduleModal()}
  `;
}

function agentOptionsHtml(selected) {
  const options = [{ key: "ceo", label: "CEO" }, ...state.departments.filter((d) => d.key !== "calendar")];
  return options
    .map((o) => `<option value="${o.key}"${o.key === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
}

function renderScheduleModal() {
  const m = state.scheduleModal;
  if (!m) return "";

  const recurrenceFields =
    m.recurrenceType === "once"
      ? `<label class="field-label">Date<input type="date" name="date" value="${m.date}" required /></label>`
      : `
        <label class="field-label">Start date<input type="date" name="startDate" value="${m.startDate}" required /></label>
        <label class="field-label">End date (optional)<input type="date" name="endDate" value="${m.endDate === m.startDate ? "" : m.endDate}" /></label>
        ${
          m.recurrenceType === "weekly"
            ? `<div class="field-label">Repeats on
                <div class="weekday-picker">
                  ${WEEKDAY_NAMES.map(
                    (name, i) => `
                    <label class="weekday-chip">
                      <input type="checkbox" name="weekday" value="${i}" ${m.weekdays.includes(i) ? "checked" : ""} />
                      ${name}
                    </label>
                  `,
                  ).join("")}
                </div>
              </div>`
            : ""
        }
      `;

  const isEdit = Boolean(m.id);

  return `
    <div class="confirm-backdrop" id="schedule-modal-backdrop">
      <div class="confirm-modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
        <h3 id="schedule-modal-title">${isEdit ? "Edit automation" : "Schedule an automation"}</h3>
        <form id="schedule-form">
          <label class="field-label">Title<input type="text" name="label" value="${escapeHtml(m.label)}" placeholder="e.g. Weekly sales outreach" required /></label>
          <label class="field-label">Agent
            <select name="agentKey">${agentOptionsHtml(m.agentKey)}</select>
          </label>
          <label class="field-label">Goal<textarea name="goal" rows="3" placeholder="What should the agent do when this fires?" required>${escapeHtml(m.goal)}</textarea></label>
          <label class="field-label">Recurrence
            <select id="schedule-recurrence-type" name="recurrenceType">
              <option value="once"${m.recurrenceType === "once" ? " selected" : ""}>Once</option>
              <option value="daily"${m.recurrenceType === "daily" ? " selected" : ""}>Daily</option>
              <option value="weekly"${m.recurrenceType === "weekly" ? " selected" : ""}>Weekly</option>
            </select>
          </label>
          ${recurrenceFields}
          <label class="field-label">Time<input type="time" name="time" value="${m.time}" required /></label>
          ${m.error ? `<p class="attachment-error">${escapeHtml(m.error)}</p>` : ""}
          <div class="confirm-modal-actions">
            ${isEdit ? `<button type="button" class="confirm-btn confirm-btn-danger" id="schedule-modal-delete">Delete</button>` : ""}
            <button type="button" class="confirm-btn confirm-btn-cancel" id="schedule-modal-cancel">Cancel</button>
            <button type="submit" class="confirm-btn confirm-btn-primary" ${m.submitting ? "disabled" : ""}>${m.submitting ? "Saving…" : isEdit ? "Save changes" : "Schedule automation"}</button>
          </div>
        </form>
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

  document.getElementById("toggle-archived-btn")?.addEventListener("click", () => toggleArchivedFilter());

  // Action icons live inside .run-item (sidebar list) or .run-header
  // (detail page) — stopPropagation so clicking one doesn't also trigger
  // the parent .run-item's click-to-select handler above.
  document.querySelectorAll("[data-archive-run]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      archiveRun(btn.dataset.archiveRun);
    });
  });
  document.querySelectorAll("[data-unarchive-run]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      unarchiveRun(btn.dataset.unarchiveRun);
    });
  });
  document.querySelectorAll("[data-delete-run]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRun(btn.dataset.deleteRun);
    });
  });

  if (state.confirmModal) {
    document.getElementById("confirm-backdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "confirm-backdrop") closeConfirmModal();
    });
    document.getElementById("confirm-modal-cancel")?.addEventListener("click", () => closeConfirmModal());
    document.getElementById("confirm-modal-confirm")?.addEventListener("click", () => {
      const onConfirm = state.confirmModal?.onConfirm;
      closeConfirmModal();
      onConfirm?.();
    });
  }

  document.querySelectorAll(".doc-item").forEach((li) => {
    li.addEventListener("click", () => openDocument(li.dataset.docId));
  });

  document.querySelectorAll(".bento-detail-item[data-run-id]").forEach((li) => {
    li.addEventListener("click", () => selectRun(li.dataset.runId));
  });

  document.querySelectorAll(".bento-detail-item[data-doc-id]").forEach((li) => {
    li.addEventListener("click", () => openDocument(li.dataset.docId));
  });

  document.querySelectorAll(".disconnect-btn").forEach((btn) => {
    btn.addEventListener("click", () => disconnectAccount(btn.dataset.accountKey));
  });

  document.getElementById("settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await saveSettings(form);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Files ---

  document.querySelectorAll(".files-row[data-files-path]").forEach((row) => {
    row.addEventListener("click", () => {
      const path = row.dataset.filesPath;
      const parentPath = path.split("/").slice(0, -1).join("/");
      const entry = (state.filesChildren.get(parentPath) ?? []).find((c) => c.path === path);
      if (entry) selectFilesEntry(entry);
    });
  });

  const filesUploadInput = document.getElementById("files-upload-input");
  document.getElementById("files-upload-btn")?.addEventListener("click", () => filesUploadInput?.click());
  filesUploadInput?.addEventListener("change", () => {
    if (filesUploadInput.files?.length) uploadFilesToTarget(filesUploadInput.files);
    filesUploadInput.value = "";
  });

  // --- Calendar ---

  document.getElementById("mini-cal-prev")?.addEventListener("click", () => shiftCalendarMonth(-1));
  document.getElementById("mini-cal-next")?.addEventListener("click", () => shiftCalendarMonth(1));
  document.getElementById("calendar-today")?.addEventListener("click", () => goToToday());
  document.getElementById("calendar-prev")?.addEventListener("click", () => {
    if (state.calendarView === "week") shiftCalendarWeek(-1);
    else shiftCalendarMonth(-1);
  });
  document.getElementById("calendar-next")?.addEventListener("click", () => {
    if (state.calendarView === "week") shiftCalendarWeek(1);
    else shiftCalendarMonth(1);
  });
  document.getElementById("calendar-range-toggle")?.addEventListener("click", () => toggleCalendarRangeMode());
  document.getElementById("calendar-clear-selection")?.addEventListener("click", () => clearCalendarSelection());
  document.getElementById("calendar-add")?.addEventListener("click", () => openScheduleModal(state.calendarSelectedDate, state.calendarSelectedDate));
  document.getElementById("detail-add-schedule")?.addEventListener("click", () => openScheduleModal(state.calendarSelectedDate, state.calendarSelectedDate));

  document.querySelectorAll("[data-calendar-view]").forEach((btn) => {
    btn.addEventListener("click", () => setCalendarView(btn.dataset.calendarView));
  });

  document.querySelectorAll("[data-calendar-status]").forEach((btn) => {
    btn.addEventListener("click", () => setCalendarStatusFilter(btn.dataset.calendarStatus));
  });

  document.querySelectorAll(".calendar-cell[data-date], .mini-cell[data-date], .week-day-head[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => selectCalendarDate(cell.dataset.date));
  });

  document.querySelectorAll("[data-toggle-schedule]").forEach((btn) => {
    btn.addEventListener("click", () => toggleSchedule(btn.dataset.toggleSchedule, btn.dataset.enabled !== "true"));
  });

  document.querySelectorAll("[data-delete-schedule]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSchedule(btn.dataset.deleteSchedule));
  });

  document.querySelectorAll("[data-edit-schedule]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const schedule = state.schedules.find((s) => s.id === btn.dataset.editSchedule);
      if (schedule) openEditScheduleModal(schedule);
    });
  });

  if (state.scheduleModal) {
    document.getElementById("schedule-modal-backdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "schedule-modal-backdrop") closeScheduleModal();
    });
    document.getElementById("schedule-modal-cancel")?.addEventListener("click", () => closeScheduleModal());
    document.getElementById("schedule-modal-delete")?.addEventListener("click", () => deleteSchedule(state.scheduleModal.id));
    document.getElementById("schedule-recurrence-type")?.addEventListener("change", (e) => {
      changeScheduleRecurrenceType(e.target.value);
    });
    document.getElementById("schedule-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitScheduleModal();
    });
  }

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
    document.getElementById("goal-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
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
    document.getElementById("reply-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        replyForm.requestSubmit();
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
  initResponsiveLayout();
  await Promise.all([loadDepartments(), loadAccounts()]);
  await Promise.all([loadRunsForCurrentView(), loadAnalytics()]);
  render();
}

init();
