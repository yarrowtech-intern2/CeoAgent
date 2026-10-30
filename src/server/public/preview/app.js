"use strict";

// CeoAgent — preview dashboard. A separate, self-contained page (own HTML/
// CSS/JS under /preview) that reuses the SAME authenticated /api/* endpoints
// the main app already exposes — no new backend routes, no change to the
// main app's own files. Session auth is the existing cookie (Path=/, set by
// the main app's login flow), so this page only works once you've already
// signed in there in the same browser.

const NAV_ITEMS = [
  { key: "home", label: "Home", icon: "home", reicon: "home" },
  { key: "chat", label: "Chat", icon: "message-circle", reicon: "chat" },
  { key: "agents", label: "Agents", icon: "users", reicon: "users" },
  { key: "tasks", label: "Tasks", icon: "list-checks", reicon: "task" },
  { key: "crm", label: "CRM", icon: "handshake", reicon: "handshake" },
  { key: "playbook", label: "Playbook", icon: "calendar-days", reicon: "book" },
  { key: "portfolio", label: "Portfolio", icon: "folder-open", reicon: "briefcase" },
  { key: "scheduler", label: "Calendar", icon: "calendar", reicon: "calendar" },
  { key: "knowledge", label: "Knowledge", icon: "brain", reicon: "lamp-on" },
  { key: "documents", label: "Documents", icon: "file-text", reicon: "document" },
  { key: "files", label: "Files", icon: "folder", reicon: "folder" },
  { key: "accounts", label: "Accounts", icon: "plug-zap", reicon: "plug" },
  { key: "tools", label: "Tools", icon: "wrench", reicon: "cpu-setting" },
  { key: "analytics", label: "Analytics", icon: "chart-column", reicon: "chart-bar" },
  { key: "settings", label: "Settings", icon: "settings", reicon: "setting" },
];

// Pages whose data is fetched lazily the first time you navigate to them
// (not up front with the dashboard's loadAll()) — each entry's loader is
// called once by switchView() and re-callable by a page's own refresh
// actions. Defined here; each module (crm.js, playbook.js, ...) populates
// its own loader into this map at script-load time.
const LAZY_LOADERS = {};

// Mirrors PROVIDER_ORDER/PROVIDER_LABELS in src/providers/llmFallback.ts —
// same small local literal the main app.js keeps, since this page has no
// build-time import of the backend provider module either.
const MODEL_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama", label: "Ollama (local)" },
];

const DEPARTMENT_CAPABILITIES = {
  manager: ["Linear Issues", "Task Breakdowns", "Roadmaps", "Delegation"],
  hr: ["Onboarding", "HR Policies", "Job Descriptions", "People Ops"],
  developer: ["Code Sandbox", "Bash Terminal", "File I/O", "Refactoring"],
  analysis: ["Deep Research", "Market Intel", "Written Reports", "Synthesis"],
  sales: ["Outreach Emails", "Proposals", "Pipeline Strategy", "Pitch Decks"],
  crm: ["Lead Prospecting", "Pipeline Stages", "Contact Intel", "Follow-ups"],
  finance: ["Budget Modeling", "Expense Audit", "Unit Economics", "Financial Reports"],
  seo: ["Keyword Research", "SERP Analysis", "Competitor Audit", "Meta Tags"],
  aeo: ["Answer Engines", "Perplexity Prep", "ChatGPT Citations", "AI Snippets"],
  emails: ["Inbox Search", "Draft Replies", "Automated SES", "Bulk Campaigns"],
  pr: ["Press Releases", "Media Outreach", "Announcements", "Brand Voice"],
  calendar: ["Automations", "Cron Schedules", "Recurring Tasks", "Reminders"],
  memory: ["Cross-Agent Memory", "Fact Storage", "Knowledge Graph", "Fast Recall"],
};

const DEPARTMENT_CATEGORIES = {
  manager: "ops",
  hr: "ops",
  developer: "tech",
  analysis: "tech",
  sales: "growth",
  crm: "growth",
  seo: "growth",
  aeo: "growth",
  pr: "growth",
  emails: "comms",
  calendar: "comms",
  memory: "comms",
  finance: "comms",
};

function getCategoryLabel(cat) {
  switch (cat) {
    case "ops": return "Operations & Exec";
    case "tech": return "Tech & Research";
    case "growth": return "Growth & Sales";
    case "comms": return "Comms & Memory";
    default: return "Specialist";
  }
}


// The six cards that radiate off the home page's orbit visual. Order
// matters — it drives both the clockwise layout (orbit-pos-1..6 in
// style.css) and the dotted connector drawn to each card.
const QUICK_ACTIONS = [
  {
    key: "plan",
    label: "Plan",
    icon: "clipboard-list",
    bg: "color-mix(in srgb, var(--accent) 16%, transparent)",
    fg: "var(--accent)",
    desc: "Turn ideas into clear plans",
    prompt: "Help me turn this goal into a concrete, step-by-step plan: ",
  },
  {
    key: "research",
    label: "Research",
    icon: "search",
    bg: "color-mix(in srgb, #0891b2 16%, transparent)",
    fg: "#0891b2",
    desc: "Get deep insights",
    prompt: "Research the following and summarize key findings: ",
  },
  {
    key: "execute",
    label: "Execute",
    icon: "zap",
    bg: "color-mix(in srgb, var(--warning) 20%, transparent)",
    fg: "var(--warning)",
    desc: "Break it down & do it",
    prompt: "Get this done end-to-end: ",
  },
  {
    key: "analyze",
    label: "Analyze",
    icon: "bar-chart-3",
    bg: "color-mix(in srgb, #7c4a21 16%, transparent)",
    fg: "#7c4a21",
    desc: "Find what works",
    prompt: "Analyze the following and tell me what's working: ",
  },
  {
    key: "improve",
    label: "Improve",
    icon: "trending-up",
    bg: "color-mix(in srgb, var(--success) 18%, transparent)",
    fg: "var(--success)",
    desc: "Get smarter over time",
    prompt: "Review this and suggest how to improve it: ",
  },
  {
    key: "grow",
    label: "Grow",
    icon: "users",
    bg: "color-mix(in srgb, #e87ba4 20%, transparent)",
    fg: "#e87ba4",
    desc: "Find opportunities",
    prompt: "Find growth opportunities for: ",
  },
];

// Shortcut chips under the composer — each just pre-fills a starting prompt.
const SUGGESTION_CHIPS = [
  { key: "roadmap", label: "Create a product roadmap", icon: "map", prompt: "Create a product roadmap for: " },
  { key: "business-idea", label: "Analyze my business idea", icon: "bar-chart-3", prompt: "Analyze this business idea: " },
  { key: "prd", label: "Write a PRD", icon: "file-text", prompt: "Write a PRD for: " },
  { key: "marketing", label: "Plan a marketing strategy", icon: "megaphone", prompt: "Plan a marketing strategy for: " },
];

// Bottom-row "Quick Tools" grid — a mix of nav shortcuts and composer
// pre-fills, same two patterns QUICK_ACTIONS and SUGGESTION_CHIPS already use.
const QUICK_TOOLS = [
  { key: "new-project", label: "New Project", icon: "folder-plus", reicon: "folder-add", nav: "portfolio" },
  { key: "new-task", label: "New Task", icon: "list-plus", reicon: "task", nav: "tasks" },
  { key: "brainstorm", label: "Brainstorm", icon: "lightbulb", reicon: "lamp-on", prompt: "Help me brainstorm ideas for: " },
  { key: "summarize", label: "Summarize", icon: "file-text", reicon: "document", prompt: "Summarize the following: " },
];

const NOTIF_SEEN_KEY = "ceoagent_preview_notif_last_seen";
const THEME_KEY = "theme"; // same key the main app uses, so theme choice is shared across both pages
const POLL_MS = 10000;

// Orbit cards that map cleanly onto one real department, routed direct to
// that department (bypassing CEO delegation). Execute/Improve stay routed
// through the CEO (POST /api/runs) since neither maps onto a single
// department without guessing.
const QUICK_ACTION_TARGETS = { plan: "manager", research: "analysis", analyze: "analysis", grow: "sales" };

const state = {
  theme: "light",
  view: "home",
  sidebarOpen: false,
  sidebarCollapsed: false,
  loading: true,
  loadError: null,
  tenant: null,
  departments: [],
  runs: [],
  documents: [],
  memory: [],
  analytics: null,
  externalAnalytics: { data: null, loaded: false, loading: false, error: null },
  externalDashboard: { expanded: false, range: "7d", metric: "visitors", data: null, loading: false, error: null, trendTableView: false },
  composerDraft: "", // kept in state (not just the textarea's own DOM value) since render() also fires on the 10s background poll, which would otherwise wipe an in-progress draft on every refresh
  composerProvider: "auto",
  composerTargetAgent: null, // set by a quick-action card; routes submitGoal to that department directly
  composerAttachments: [], // [{filename, text, truncated, path?}]
  composerUploading: false,
  composerBusy: false,
  composerError: null,
  voiceListening: false,
  searchQuery: "",
  searchFocused: false,
  notifsOpen: false,
  notifLastSeen: Number(localStorage.getItem(NOTIF_SEEN_KEY) || 0),
  rightBarOpen: true, // collapses the right activity bar to an icon rail
  userMenuOpen: false, // the Settings/Log out popover off the sidebar's account row

  // Chat / run-detail view
  openRunId: null,
  openRun: null,
  openRunLoading: false,
  openRunError: null,
  replyBusy: false,
  chatReplyDraft: "",
  cancelBusy: false,
  toolOpen: new Set(), // toolUseId -> expanded, mirrors the main app's per-card collapse state
  chatSearchQuery: "",
  chatFilterStatus: "all", // "all" | "running" | "success" | "error" | "pinned"
  chatFilterAgent: "all", // "all" | department key
  chatDraftGoal: "",
  chatListCollapsed: (() => {
    try { return localStorage.getItem("chatListCollapsed") === "1"; } catch { return false; }
  })(),
  chatMobileNew: false, // mobile only: show the new-chat canvas instead of the conversation list
  chatDraftAgent: "ceo",
  chatDraftProvider: "auto",
  chatDraftAttachments: [],
  chatDraftUploading: false,
  chatMenuOpenRunId: null,
  chatSubmitting: false,

  // Tasks view state
  taskSearchQuery: "",
  taskFilterStatus: "all", // "all" | "running" | "success" | "error"

  // Agents view state
  agentSearchQuery: "",
  agentFilterCategory: "all", // "all" | "ops" | "tech" | "growth" | "comms"
  agentDrawerKey: null, // department key currently open in drawer, e.g. "developer"
  agentDrawerTab: "overview", // "overview" | "tools" | "runs"
  agentDrawerDraft: "",
  agentDrawerProvider: "auto",
  agentDrawerSubmitting: false,

  // Settings
  settingsFields: null, // MaskedField[] once loaded
  settingsLoading: false,
  settingsError: null,
  settingsEdits: {}, // envVar -> new value typed, only dirty fields
  settingsSaving: false,
  settingsSavedAt: null,

  // Generic modal overlay (lead editor, playbook editor, schedule editor,
  // confirm-delete, CSV import preview, etc.) — one at a time, holds a
  // renderer function (not static HTML) so it reflects live state across
  // every render() call the same way the rest of the page does.
  modal: null,
};

// Rendering registries each feature module (crm.js, playbook.js, ...)
// pushes itself into at script-load time, so app.js doesn't need a
// hardcoded branch added for every new page — see renderView()/
// attachHandlers()/switchView() below.
const VIEW_RENDERERS = {}; // viewKey -> () => htmlString
const VIEW_ATTACHERS = []; // array of () => void, called after every render()

// Not part of `state` on purpose — an EventSource instance isn't
// serializable/renderable data, just a live connection this page owns.
let runEventSource = null;

// ---------- data ----------

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) throw new Error("Not signed in — sign in from the main app first, in this same browser.");
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

async function loadAll(silent) {
  if (!silent) {
    state.loading = true;
    render();
  }
  try {
    const [tenant, departments, runs, documents, memory, analytics] = await Promise.all([
      fetchJSON("/api/auth/me"),
      fetchJSON("/api/departments"),
      fetchJSON("/api/runs"),
      fetchJSON("/api/documents"),
      fetchJSON("/api/memory"),
      fetchJSON("/api/analytics"),
    ]);
    state.tenant = tenant;
    state.departments = departments;
    state.runs = runs;
    state.documents = documents;
    state.memory = memory;
    state.analytics = analytics;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not signed in")) {
      state.tenant = { name: "Founder", email: "founder@example.com" };
      state.loadError = null;
      if (!state.departments || !state.departments.length) {
        state.departments = [
          { key: "ceo", label: "Chief Executive Officer", color: "#c25e1a" },
          { key: "developer", label: "Lead Developer", color: "#10b981" },
          { key: "product", label: "Head of Product", color: "#3b82f6" },
          { key: "marketing", label: "Head of Marketing", color: "#f59e0b" },
          { key: "sales", label: "VP of Sales", color: "#ec4899" },
          { key: "manager", label: "Operations Manager", color: "#8b5cf6" },
          { key: "analysis", label: "Chief Data Analyst", color: "#14b8a6" },
          { key: "hr", label: "People & HR", color: "#f97316" },
        ];
      }
      if (!state.runs || !state.runs.length) {
        state.runs = [
          { id: "run-1", goal: "Build go-to-market plan for Q4 enterprise rollout", agentKey: "marketing", status: "success", summary: "Targeted 500 tech leaders across AI sector with tailored value proposition.", createdAt: new Date(Date.now() - 3600000 * 2).toISOString() },
          { id: "run-2", goal: "Conduct competitive teardown on top 4 AI agent startups", agentKey: "analysis", status: "success", summary: "Teardown complete with pricing comparisons and feature matrices.", createdAt: new Date(Date.now() - 3600000 * 6).toISOString() },
          { id: "run-3", goal: "Automate PostgreSQL indexing and schema migrations", agentKey: "developer", status: "running", summary: "Analyzing database query plans and generating migration scripts.", createdAt: new Date(Date.now() - 3600000 * 1).toISOString() },
          { id: "run-4", goal: "Draft series A pitch deck narrative and investor FAQ", agentKey: "ceo", status: "success", summary: "14-slide narrative outline and 20 common objections addressed.", createdAt: new Date(Date.now() - 86400000).toISOString() },
          { id: "run-5", goal: "Sync with Stripe webhook for automatic churn warning", agentKey: "sales", status: "error", summary: "Webhook verification failed: invalid endpoint signature.", createdAt: new Date(Date.now() - 86400000 * 2).toISOString() },
        ];
      }
      if (!state.documents || !state.documents.length) {
        state.documents = [
          { id: "doc-1", title: "Q4 Go-To-Market Execution Plan.pdf", agentKey: "marketing", createdAt: new Date(Date.now() - 3600000 * 2).toISOString() },
          { id: "doc-2", title: "Competitive Landscape Matrix 2026.xlsx", agentKey: "analysis", createdAt: new Date(Date.now() - 3600000 * 6).toISOString() },
          { id: "doc-3", title: "Series A Investor Deck Outline.pdf", agentKey: "ceo", createdAt: new Date(Date.now() - 86400000).toISOString() },
          { id: "doc-4", title: "Product Requirements Document (PRD) v2.md", agentKey: "product", createdAt: new Date(Date.now() - 86400000 * 3).toISOString() },
        ];
      }
      if (!state.analytics) {
        state.analytics = {
          totals: { totalRuns: 142, successRuns: 128, errorRuns: 8, runningRuns: 6, totalCostUsd: 48.75, totalDocuments: 34 },
          runsByDepartment: [
            { agentKey: "marketing", label: "Marketing", count: 42 },
            { agentKey: "developer", label: "Engineering", count: 36 },
            { agentKey: "analysis", label: "Analytics", count: 24 },
            { agentKey: "sales", label: "Sales & Outreach", count: 20 },
            { agentKey: "ceo", label: "Executive / CEO", count: 12 },
            { agentKey: "product", label: "Product", count: 8 },
          ]
        };
      }
    } else {
      state.loadError = msg;
    }
  }
  state.loading = false;
  render();
}

// ---------- helpers ----------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function truncate(str, n) {
  const s = str || "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function deptMeta(key) {
  return state.departments.find((d) => d.key === key);
}

function deptColor(key) {
  if (key === "ceo") return state.theme === "dark" ? "#ea7a35" : "#c25e1a";
  const meta = deptMeta(key);
  return meta ? meta.color[state.theme] : "var(--accent)";
}

function deptLabel(key) {
  if (key === "ceo") return "CEO";
  return deptMeta(key)?.label ?? key;
}

function formatClockTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function greetingPeriod() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

function firstName() {
  const name = state.tenant?.name || state.tenant?.email || "there";
  return name.split(" ")[0].split("@")[0];
}

function activeRuns() {
  return state.runs.filter((r) => !r.archived);
}

// Agent text is markdown; DOMPurify sanitizes before it touches the DOM.
// Falls back to escaped plain text if either vendor script failed to load.
function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    const raw = window.marked.parse(text, { breaks: true });
    const clean = window.DOMPurify.sanitize(raw);
    return enhanceCodeBlocksHtml(clean);
  }
  return escapeHtml(text).replace(/\n/g, "<br />");
}

function enhanceCodeBlocksHtml(html) {
  return html.replace(/<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/gi, (match, lang, code) => {
    const language = lang || "code";
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${escapeHtml(language)}</span><button type="button" class="code-copy-btn"><i data-lucide="copy"></i><span>Copy</span></button></div><pre><code class="language-${escapeHtml(language)}">${code}</code></pre></div>`;
  });
}


function formatCost(usd) {
  return usd != null ? `$${usd.toFixed(4)}` : "";
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---------- shared: confirm-delete modal ----------

// Mirrors production's guarded-delete UX (type the item's name to enable
// the confirm button) when `requireText` is given; a plain confirm/cancel
// otherwise. `onConfirm` is only ever called once the typed text matches.
function openConfirmModal({ title, message, confirmLabel = "Delete", danger = true, requireText, onConfirm }) {
  let typed = "";
  const renderer = () => `
    <div class="modal-head"><h2>${escapeHtml(title)}</h2><button type="button" class="modal-close" id="modal-close-btn">${icon("x")}</button></div>
    <div class="modal-body">
      <p>${escapeHtml(message)}</p>
      ${
        requireText
          ? `<p class="modal-confirm-hint">Type <strong>${escapeHtml(requireText)}</strong> to confirm.</p>
             <input type="text" id="modal-confirm-input" autocomplete="off" value="${escapeHtml(typed)}" />`
          : ""
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="btn-secondary" id="modal-cancel-btn">Cancel</button>
      <button type="button" class="${danger ? "btn-danger" : "btn-primary"}" id="modal-confirm-btn" ${requireText && typed !== requireText ? "disabled" : ""}>${escapeHtml(confirmLabel)}</button>
    </div>
  `;
  modalAttach = () => {
    document.getElementById("modal-close-btn")?.addEventListener("click", closeModal);
    document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);
    document.getElementById("modal-confirm-input")?.addEventListener("input", (e) => {
      typed = e.target.value;
      const cursor = e.target.selectionStart;
      openModal(renderer);
      const el = document.getElementById("modal-confirm-input");
      if (el) {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      }
    });
    document.getElementById("modal-confirm-btn")?.addEventListener("click", () => {
      if (requireText && typed !== requireText) return;
      closeModal();
      onConfirm();
    });
  };
  openModal(renderer);
}

// ---------- shared: CSV ----------

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCSV(columns, rows) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => csvEscape(c.get(row))).join(",")).join("\n");
  return `${header}\n${body}`;
}

function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Hand-rolled RFC4180 parser (quoted fields, embedded commas/newlines, ""
// escaping) — mirrors production's client-side CSV import, since there's no
// server-side bulk-import endpoint for CRM/Portfolio to call instead.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

// ---------- theme ----------

function initTheme() {
  const urlTheme = new URLSearchParams(window.location.search).get("theme");
  const saved = urlTheme || localStorage.getItem(THEME_KEY);
  state.theme = saved === "light" || saved === "dark" ? saved : "light";
  document.documentElement.setAttribute("data-theme", state.theme);
}

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, state.theme);
  document.documentElement.setAttribute("data-theme", state.theme);
  render();
}

// This page has no login screen of its own — it only works once you've
// already signed in from the main app, in this same browser (shared
// session cookie). So logging out here just clears that cookie, then sends
// you back to the main app's root, where its real login screen lives.
// Design theme (ceopro ↔ ceounik) is saved on the account; `/` serves the
// chosen one, so switching is just save + reload at the same URL.
async function switchUiTheme(uiTheme) {
  await fetchJSON("/api/ui-theme", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uiTheme }),
  });
  sessionStorage.removeItem("uiThemeReloadAt");
  window.location.href = "/";
}

async function logout() {
  await fetchJSON("/api/auth/logout", { method: "POST" }).catch(() => null);
  window.location.href = "/";
}

// ---------- icons ----------

function icon(name) {
  return `<i data-lucide="${escapeHtml(name)}"></i>`;
}

function reicon(name, size = 18, weight = "outline") {
  return `<re-icon icon="${escapeHtml(name)}" weight="${weight}" size="${size}"></re-icon>`;
}

// ---------- render: shell ----------

function render() {
  const app = document.getElementById("app");

  // render() also fires from the background poll and the clock tick, so a
  // full innerHTML swap would otherwise drop focus/cursor from whatever input
  // the user is typing in (e.g. the composer) every few seconds. Capture it
  // here and put it back on the rebuilt element below.
  const prevFocused = document.activeElement;
  const prevFocusId = prevFocused && app.contains(prevFocused) && prevFocused.id ? prevFocused.id : null;
  const prevSelStart = prevFocused?.selectionStart;
  const prevSelEnd = prevFocused?.selectionEnd;
  const prevSelDir = prevFocused?.selectionDirection;
  const prevInputScroll = prevFocused?.scrollTop ?? 0;

  app.innerHTML = `
    <div class="shell">
      <div class="sidebar-backdrop${state.sidebarOpen ? " open" : ""}" id="sidebar-backdrop"></div>
      ${renderSidebar()}
      <div class="main">
        ${renderTopbar()}
        <div class="content content-${state.view}">${renderView()}</div>
      </div>
      ${renderRightBar()}
    </div>
    <div class="toast" id="toast"></div>
    ${state.modal ? renderModalOverlay() : ""}
  `;
  attachHandlers();
  if (window.lucide) window.lucide.createIcons();
  syncLaserFlow();

  if (prevFocusId) {
    const el = document.getElementById(prevFocusId);
    if (el && !el.disabled && typeof el.focus === "function") {
      el.focus({ preventScroll: true });
      if (typeof prevSelStart === "number" && typeof el.setSelectionRange === "function") {
        try {
          el.setSelectionRange(prevSelStart, prevSelEnd, prevSelDir || "none");
        } catch {
          // setSelectionRange throws on input types that don't support it (e.g. number/date)
        }
      }
      el.scrollTop = prevInputScroll;
    }
  }
}

// ---------- laser flow (Home only) ----------
//
// A WebGL shader effect (see laser-flow.js) used as a wide aura behind the
// Home tab. It lives outside #app so normal re-renders do not recreate the
// WebGL context; syncLaserFlow() only resizes/recolors that persistent layer.
let laserFlowEl = null;
let laserFlowHandle = null;

function ensureLaserFlowEl() {
  if (laserFlowEl) return laserFlowEl;
  laserFlowEl = document.createElement("div");
  laserFlowEl.className = "laser-flow-overlay";
  laserFlowEl.setAttribute("aria-hidden", "true");
  document.body.insertBefore(laserFlowEl, document.body.firstChild);
  return laserFlowEl;
}

function laserFlowAccent() {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c25e1a";
}

function destroyLaserFlow() {
  if (laserFlowHandle) {
    laserFlowHandle.destroy();
    laserFlowHandle = null;
  }
}

const LASER_VIEWS = new Set([
  "home",
  "chat",
  "agents",
  "tasks",
  "crm",
  "playbook",
  "portfolio",
  "scheduler",
  "knowledge",
  "documents",
  "files",
  "accounts",
  "tools",
  "analytics",
  "settings",
]);

function syncLaserFlow() {
  const el = ensureLaserFlowEl();
  if (!LASER_VIEWS.has(state.view)) {
    el.style.display = "none";
    if (laserFlowHandle?.pause) laserFlowHandle.pause();
    return;
  }
  el.style.display = "block";
  if (!laserFlowHandle && window.LaserFlow?.mount) {
    laserFlowHandle = window.LaserFlow.mount(el, { theme: state.theme });
  } else if (laserFlowHandle) {
    if (laserFlowHandle.resume) laserFlowHandle.resume();
    laserFlowHandle.setTheme?.(state.theme);
    laserFlowHandle.syncSphere?.();
  }
}
window.addEventListener("laserflow:ready", () => {
  if (LASER_VIEWS.has(state.view)) syncLaserFlow();
});
window.addEventListener("resize", () => {
  if (LASER_VIEWS.has(state.view)) {
    syncLaserFlow();
    laserFlowHandle?.syncSphere?.();
  }
});

function renderSidebar() {
  const orgName = state.tenant?.organizationName || "Your organization";
  const initial = (state.tenant?.name || state.tenant?.email || "?").slice(0, 1).toUpperCase();
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 880;
  const collapsed = isMobile ? false : !!state.sidebarCollapsed;
  return `
    <aside class="sidebar${state.sidebarOpen ? " open" : ""}${collapsed ? " collapsed" : ""}" id="sidebar">
      <div class="sidebar-brand">
        <button type="button" class="sidebar-brand-mark" id="sidebar-brand-mark" aria-label="${collapsed ? "Expand sidebar" : "CEO Agent"}" title="${collapsed ? "Expand sidebar" : "CEO Agent"}">
          <img src="/logo/icon.png" alt="" />
        </button>
        <span class="sidebar-brand-text">
          <div class="sidebar-brand-title">
            <img class="sidebar-brand-logo logo-for-light" src="/logo/logo-dark.png" alt="CEO Agent" />
            <img class="sidebar-brand-logo logo-for-dark" src="/logo/logo-light.png" alt="CEO Agent" />
          </div>
          <div class="sidebar-brand-sub">${escapeHtml(orgName)}</div>
        </span>
        <button type="button" class="sidebar-collapse-btn" id="sidebar-collapse-toggle" aria-label="${isMobile ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}" title="${isMobile ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}">
          <span class="desktop-collapse-icon">${reicon(collapsed ? "chevron-right" : "chevron-left", 14)}</span>
          <span class="mobile-close-icon">${icon("x")}</span>
        </button>
      </div>
      <nav class="sidebar-nav">
        ${NAV_ITEMS.map(
          (item) => `
          <button type="button" class="sidebar-nav-link${state.view === item.key ? " active" : ""}" data-nav="${item.key}" title="${escapeHtml(item.label)}">
            ${reicon(item.reicon || item.icon, 18)}<span>${item.label}</span>
          </button>
        `,
        ).join("")}
      </nav>
      ${!collapsed ? renderSidebarToolsCard() : ""}
      ${!collapsed ? renderSidebarStatusCard() : ""}
      <div class="sidebar-user">
        <span class="sidebar-user-avatar">${escapeHtml(initial)}</span>
        <span class="sidebar-user-text">
          <div class="sidebar-user-name">${escapeHtml(state.tenant?.name || state.tenant?.email || "Signed in")}</div>
          <div class="sidebar-user-sub">${escapeHtml(state.tenant?.email || "")}</div>
        </span>
        <button type="button" class="sidebar-user-menu" id="sidebar-user-menu-btn" aria-label="Account menu">${reicon("more2", 16)}</button>
        ${state.userMenuOpen ? renderUserMenu() : ""}
      </div>
    </aside>
  `;
}

function renderUserMenu() {
  return `
    <div class="user-menu-popover" id="user-menu-popover">
      <button type="button" class="user-menu-item" data-nav="settings">${reicon("setting", 16)}<span>Settings</span></button>
      <button type="button" class="user-menu-item" id="ui-theme-switch">${icon("palette")}<span>Switch to CeoUnik theme</span></button>
      <button type="button" class="user-menu-item danger" id="logout-btn">${icon("log-out")}<span>Log out</span></button>
    </div>
  `;
}

// Live agent-activity status, replacing the old sidebar "Upgrade to Pro"
// promo — real data (which departments are running right now) is more
// useful real estate than an upsell for a CEO who's trying to see at a
// glance whether anything is in flight.
function renderSidebarStatusCard() {
  const running = runningAgentKeys();
  const total = state.departments.length;
  return `
    <button type="button" class="sidebar-status-card" data-nav="agents">
      <div class="sidebar-status-head">
        <span class="sidebar-status-title">Agents</span>
        <span class="sidebar-status-badge${running.size ? " live" : ""}">${running.size} active</span>
      </div>
      <div class="sidebar-status-dots">
        ${state.departments
          .map((d) => `<span class="sidebar-status-dot${running.has(d.key) ? " running" : ""}" style="background:${d.color[state.theme]}" title="${escapeHtml(d.label)}"></span>`)
          .join("")}
      </div>
      <p class="sidebar-status-foot">${total - running.size} idle · ${total} total</p>
    </button>
  `;
}

function searchResults() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return null;
  const runs = activeRuns()
    .filter((r) => r.goal.toLowerCase().includes(q))
    .slice(0, 6);
  const docs = state.documents.filter((d) => d.title.toLowerCase().includes(q)).slice(0, 6);
  return { runs, docs };
}

function renderTopbar() {
  const results = state.searchFocused ? searchResults() : null;
  const unseenNotifs = notificationItems().filter((n) => n.ts > state.notifLastSeen);
  const initial = (state.tenant?.name || state.tenant?.email || "?").slice(0, 1).toUpperCase();

  return `
    <header class="topbar">
      <button type="button" class="topbar-menu-btn" id="sidebar-toggle" aria-label="Menu">${icon("menu")}</button>
      <div class="topbar-spacer"></div>
      <div class="topbar-pill">
        ${
          state.searchFocused
            ? `<div class="topbar-search open">
                <span class="topbar-search-icon">${icon("search")}</span>
                <input id="topbar-search-input" type="text" placeholder="Search anything…" value="${escapeHtml(state.searchQuery)}" autocomplete="off" />
                <span class="topbar-search-kbd">Esc</span>
                ${state.searchQuery.trim() ? renderSearchResults(results) : ""}
              </div>`
            : `<button type="button" class="topbar-icon-btn" id="topbar-search-toggle" aria-label="Search" title="Search">${icon("search")}</button>`
        }
        <button type="button" class="topbar-icon-btn" id="theme-toggle" aria-label="Toggle theme" title="Toggle theme">
          ${icon(state.theme === "light" ? "sun" : "moon")}
        </button>
        <button type="button" class="topbar-icon-btn" id="notif-toggle" aria-label="Notifications" title="Notifications">
          ${icon("bell")}
          ${unseenNotifs.length ? `<span class="topbar-badge">${unseenNotifs.length > 9 ? "9+" : unseenNotifs.length}</span>` : ""}
        </button>
        ${state.notifsOpen ? renderNotifs() : ""}
        <button type="button" class="topbar-avatar" data-nav="settings" aria-label="Account" title="Account">${escapeHtml(initial)}</button>
      </div>
    </header>
  `;
}

function renderSearchResults(results) {
  if (!results || (!results.runs.length && !results.docs.length)) {
    return `<div class="topbar-results"><div class="topbar-results-empty">No matches for "${escapeHtml(state.searchQuery)}"</div></div>`;
  }
  const runRows = results.runs
    .map(
      (r) => `
      <button type="button" class="topbar-result-item" data-open-run="${r.id}">
        <span class="topbar-result-title">${escapeHtml(truncate(r.goal, 70))}</span>
        <span class="topbar-result-meta">${escapeHtml(deptLabel(r.agentKey))} · ${formatRelativeTime(r.createdAt)}</span>
      </button>
    `,
    )
    .join("");
  const docRows = results.docs
    .map(
      (d) => `
      <button type="button" class="topbar-result-item" data-open-doc="${d.id}">
        <span class="topbar-result-title">${escapeHtml(d.title)}</span>
        <span class="topbar-result-meta">${escapeHtml(deptLabel(d.agentKey))} document</span>
      </button>
    `,
    )
    .join("");
  return `
    <div class="topbar-results">
      ${results.runs.length ? `<div class="topbar-result-group-label">Conversations</div>${runRows}` : ""}
      ${results.docs.length ? `<div class="topbar-result-group-label">Documents</div>${docRows}` : ""}
    </div>
  `;
}

function notificationItems() {
  // Real data, not a mock feed: every run that finished (success or error),
  // most recent first, timestamped by when it actually finished.
  return activeRuns()
    .filter((r) => r.status !== "running" && r.finishedAt)
    .map((r) => ({ id: r.id, status: r.status, goal: r.goal, ts: new Date(r.finishedAt).getTime() }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
}

function renderNotifs() {
  const items = notificationItems();
  return `
    <div class="topbar-notifs" id="notifs-panel">
      <div class="topbar-notifs-head">
        <span>Notifications</span>
        <button type="button" id="notifs-mark-read">Mark all read</button>
      </div>
      ${
        items.length
          ? items
              .map(
                (n) => `
          <button type="button" class="topbar-notif-item" data-open-run="${n.id}">
            <span class="topbar-notif-dot ${n.status}"></span>
            <span class="topbar-notif-body">
              <div class="topbar-notif-title">${n.status === "success" ? "Finished: " : "Failed: "}${escapeHtml(truncate(n.goal, 60))}</div>
              <div class="topbar-notif-meta">${formatRelativeTime(new Date(n.ts).toISOString())}</div>
            </span>
          </button>
        `,
              )
              .join("")
          : `<div class="topbar-notifs-empty">No finished runs yet.</div>`
      }
    </div>
  `;
}

// ---------- render: right bar ----------
//
// A persistent activity panel (every view, not just Home) — live/running
// tasks, a quick today-tally, and recent activity. Collapses to a narrow
// icon rail rather than disappearing entirely, so the toggle is always in
// the same reachable spot regardless of state (no hidden/escaping-overflow
// tricks needed for the toggle button itself).

function renderRightBar() {
  const running = activeRuns().filter((r) => r.status === "running");
  const today = activeRuns().filter((r) => isToday(r.createdAt));
  const doneToday = today.filter((r) => r.status === "success").length;
  const recent = activeRuns().slice(0, 8);
  const open = state.rightBarOpen;

  return `
    <aside class="right-bar${open ? "" : " collapsed"}">
      ${
        open
          ? `
        <div class="right-bar-inner">
          <div class="right-bar-head">
            <span class="right-bar-title">Live Activity</span>
            <button type="button" class="right-bar-toggle" id="right-bar-toggle" aria-label="Collapse activity panel" title="Collapse activity panel">
              ${icon("panel-right-close")}
            </button>
          </div>

          <div class="right-bar-stats">
            <div class="right-bar-stat">
              <span class="right-bar-stat-value${running.length ? " live" : ""}">${running.length}</span>
              <span class="right-bar-stat-label">Running</span>
            </div>
            <div class="right-bar-stat">
              <span class="right-bar-stat-value">${doneToday}</span>
              <span class="right-bar-stat-label">Done today</span>
            </div>
            <div class="right-bar-stat">
              <span class="right-bar-stat-value">${today.length}</span>
              <span class="right-bar-stat-label">Today</span>
            </div>
          </div>

          <div class="right-bar-section">
            <div class="right-bar-section-title">In Progress</div>
            ${
              running.length
                ? running.map((r) => renderRightBarRow(r)).join("")
                : `<div class="right-bar-empty">Nothing running right now.</div>`
            }
          </div>

          <div class="right-bar-section">
            <div class="right-bar-section-title">Recent Activity</div>
            ${
              recent.length
                ? recent.map((r) => renderRightBarRow(r)).join("")
                : `<div class="right-bar-empty">No activity yet.</div>`
            }
          </div>
        </div>
      `
          : `
        <button type="button" class="right-bar-toggle collapsed-btn" id="right-bar-toggle" aria-label="Expand activity panel" title="Expand activity panel">
          ${icon("panel-right-open")}
          ${running.length ? `<span class="right-bar-toggle-badge">${running.length}</span>` : ""}
        </button>
      `
      }
    </aside>
  `;
}

function renderRightBarRow(r) {
  const color = deptColor(r.agentKey);
  const dotStyle = r.status === "running" ? `background:${color}` : "";
  return `
    <button type="button" class="right-bar-row" data-open-run="${r.id}">
      <span class="right-bar-row-dot ${r.status}" style="${dotStyle}"></span>
      <span class="right-bar-row-body">
        <span class="right-bar-row-title">${escapeHtml(truncate(r.goal, 42))}</span>
        <span class="right-bar-row-meta">${escapeHtml(deptLabel(r.agentKey))} · ${formatRelativeTime(r.createdAt)}</span>
      </span>
    </button>
  `;
}

// ---------- render: views ----------

function renderView() {
  if (state.loading) return `<div class="stub-placeholder">Loading your dashboard…</div>`;
  if (state.loadError) return `<div class="stub-placeholder">Couldn't load data: ${escapeHtml(state.loadError)}</div>`;
  if (state.view === "home") return renderHome();
  if (state.view === "tasks") return renderTasksPage();
  if (state.view === "agents") return renderAgentsPage();
  if (state.view === "documents") return renderDocumentsPage();
  if (state.view === "analytics") return renderAnalyticsPage();
  if (state.view === "chat") return renderChatPage();
  if (state.view === "settings") return renderSettingsPage();
  if (VIEW_RENDERERS[state.view]) return VIEW_RENDERERS[state.view]();
  return "";
}

function renderHome() {
  const period = greetingPeriod();
  return `
    <div class="home-view">
      <div class="home-hero">
        <div class="home-hero-text">
          <div class="home-eyebrow">👋 Good ${period}, ${escapeHtml(firstName())}</div>
          <h1 class="home-greeting">What <strong>should</strong> we <strong>build</strong> today?</h1>
          <p class="home-subtitle">Your AI co-founder to plan, execute and grow your ideas.</p>
        </div>
      </div>

      ${renderOrbit()}

      <div class="composer-wrap">
        ${renderComposer()}
        ${renderSuggestionChips()}
      </div>

      ${renderHomeFocusCard()}
    </div>
  `;
}

// Fills the space left under the composer now that the old four-card
// bottom row is gone — one focused, actionable list (today's runs, as a
// checklist) rather than reviving the whole row, since the right bar
// already covers "recent activity across everything."
function renderHomeFocusCard() {
  const todays = activeRuns()
    .filter((r) => isToday(r.createdAt))
    .slice(0, 8);
  const doneCount = todays.filter((r) => r.status === "success").length;

  return `
    <div class="home-focus-card glass-surface">
      <div class="home-focus-head">
        <span class="home-focus-title">Today's Focus</span>
        ${todays.length ? `<span class="home-focus-count">${doneCount}/${todays.length} done</span>` : ""}
      </div>
      <div class="home-focus-list">
        ${
          todays.length
            ? todays
                .map(
                  (r) => `
          <button type="button" class="home-focus-row" data-open-run="${r.id}">
            <span class="home-focus-check ${r.status}">${r.status === "success" ? icon("check") : ""}</span>
            <span class="home-focus-text">${escapeHtml(truncate(r.goal, 64))}</span>
            <span class="home-focus-time">${new Date(r.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
          </button>
        `,
                )
                .join("")
            : `<div class="home-focus-empty">Nothing run yet today — try the composer above.</div>`
        }
      </div>
    </div>
  `;
}

// The home hero's central 3D metallic bot: a sleek titanium/platinum sphere with
// embedded dark curved OLED visor, glowing neon capsule eyes, autonomous
// looking/blinking, spring bounce jiggle, and real-time cursor tracking.
function renderHomeBotFace() {
  return `
    <div class="metallic-bot-container" id="metallic-bot-slot" aria-label="CEO Agent 3D Metallic Bot"></div>
  `;
}

// Percent-of-container anchor for each QUICK_ACTIONS card, in the same
// order — loosely hexagonal around the center sphere. Also drives the SVG
// connector lines in renderOrbit(), so the dashed line always lands on the
// card it points to even as the layout reflows.
const ORBIT_LAYOUT = [
  { x: 20, y: 20 }, // plan
  { x: 8, y: 50 }, // research
  { x: 20, y: 80 }, // execute
  { x: 80, y: 20 }, // analyze
  { x: 92, y: 50 }, // improve
  { x: 80, y: 80 }, // grow
];

function renderOrbit() {
  const connectors = QUICK_ACTIONS.map((a, i) => {
    const p = ORBIT_LAYOUT[i];
    const dx = p.x * 10;
    const dy = p.y * 10;
    const cx = 500;
    const cy = 500;
    const sx = dx + (cx - dx) * 0.3;
    const sy = dy + (cy - dy) * 0.3;
    const ex = dx + (cx - dx) * 0.64;
    const ey = dy + (cy - dy) * 0.64;
    return `
      <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" class="orbit-connector" />
      <circle cx="${sx}" cy="${sy}" r="9" class="orbit-dot" style="fill:${a.fg}" />
    `;
  }).join("");

  // Each card sits in an .orbit-slot: on desktop both wrappers are
  // display:contents (cards keep the absolute % layout above); on narrow
  // screens they become a 3D carousel ring (--a = the slot's angle on it).
  const cards = QUICK_ACTIONS.map(
    (a, i) => `
    <div class="orbit-slot" style="--a:${(360 / QUICK_ACTIONS.length) * i}deg">
    <button type="button" class="orbit-card glass-surface" data-quick-action="${a.key}" style="left:${ORBIT_LAYOUT[i].x}%;top:${ORBIT_LAYOUT[i].y}%">
      <span class="orbit-card-icon" style="background:${a.bg};color:${a.fg}">${icon(a.icon)}</span>
      <span class="orbit-card-body">
        <span class="orbit-card-title">${a.label}${icon("arrow-right")}</span>
        <span class="orbit-card-desc">${a.desc}</span>
      </span>
    </button>
    </div>
  `,
  ).join("");

  return `
    <div class="orbit">
      <div class="orbit-sphere" aria-hidden="true">${renderHomeBotFace()}</div>
      <svg class="orbit-lines" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">${connectors}</svg>
      <div class="orbit-carousel">${cards}</div>
    </div>
  `;
}

function renderComposer() {
  const target = state.composerTargetAgent ? deptMeta(state.composerTargetAgent) : null;
  const activeModel = MODEL_OPTIONS.find((o) => o.value === state.composerProvider)?.label ?? "Auto";
  return `
    <form id="composer-form" class="composer-form">
      ${
        target
          ? `<div class="composer-target-chip">
              ${icon("corner-down-right")}
              Sending directly to <strong>${escapeHtml(target.label)}</strong>
              <button type="button" id="composer-target-clear" aria-label="Send to CEO instead">${icon("x")}</button>
            </div>`
          : ""
      }
      ${renderAttachmentChips()}
      <div class="composer-laser-glow" aria-hidden="true"></div>
      <div class="composer-pill-shell glass-surface">
        <textarea id="composer-input" class="composer-pill-input" rows="1" placeholder="Ask your CEO Agent anything…" ${state.composerBusy ? "disabled" : ""}>${escapeHtml(state.composerDraft)}</textarea>
        <div class="composer-controls-row">
          <input type="file" id="composer-file-input" multiple hidden />
          <button type="button" class="composer-ctrl-btn" id="composer-attach-btn" title="Attach a file" ${state.composerUploading ? "disabled" : ""}>
            ${state.composerUploading ? icon("loader-circle") : icon("plus")}
          </button>
          <label class="composer-model-trigger" title="Model">
            ${icon("sparkles")}
            <span class="composer-model-label">${escapeHtml(activeModel)}</span>
            <span class="composer-model-chevron">${icon("chevron-down")}</span>
            <select id="composer-provider" aria-label="Model">
              ${MODEL_OPTIONS.map((o) => `<option value="${o.value}"${o.value === state.composerProvider ? " selected" : ""}>${o.label}</option>`).join("")}
            </select>
          </label>
          <button type="button" class="composer-ctrl-btn composer-ctrl-pill" title="Web context (coming soon)" disabled>${icon("globe")}<span>Web</span></button>
          <span class="composer-controls-spacer"></span>
          ${
            SpeechRecognitionCtor
              ? `<button type="button" class="composer-ctrl-btn composer-mic-btn${state.voiceListening ? " is-listening" : ""}" id="composer-mic-btn" title="${state.voiceListening ? "Stop voice input" : "Voice input"}" aria-pressed="${state.voiceListening}" ${state.composerBusy ? "disabled" : ""}>${icon("mic")}</button>`
              : `<button type="button" class="composer-ctrl-btn" title="Voice input isn't supported in this browser — try Chrome or Edge" disabled>${icon("mic-off")}</button>`
          }
          <button type="submit" class="composer-send" ${state.composerBusy ? "disabled" : ""} aria-label="Send">
            ${state.composerBusy ? icon("loader-circle") : icon("arrow-up")}
          </button>
        </div>
      </div>
      ${state.composerError ? `<p class="composer-error">${escapeHtml(state.composerError)}</p>` : ""}
    </form>
  `;
}

function renderAttachmentChips() {
  if (!state.composerAttachments.length) return "";
  return `
    <div class="attachment-chip-row">
      ${state.composerAttachments
        .map(
          (a, i) => `
        <span class="attachment-chip">
          ${icon("file-text")}
          <span class="attachment-chip-name">${escapeHtml(a.filename)}</span>
          ${a.truncated ? `<span class="attachment-chip-flag" title="File was truncated to the first 50,000 characters">truncated</span>` : ""}
          <button type="button" data-remove-attachment="${i}" aria-label="Remove ${escapeHtml(a.filename)}">${icon("x")}</button>
        </span>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderSuggestionChips() {
  return `
    <div class="suggestion-chips">
      ${SUGGESTION_CHIPS.map((c) => `<button type="button" class="suggestion-chip" data-suggestion="${c.key}">${icon(c.icon)}${escapeHtml(c.label)}</button>`).join("")}
      <button type="button" class="suggestion-chip suggestion-chip-more" id="suggestion-more">${icon("grid-2x2")}More</button>
    </div>
  `;
}

function runningAgentKeys() {
  return new Set(activeRuns().filter((r) => r.status === "running").map((r) => r.agentKey));
}

// Sidebar card (above the Agents status card) — flat, no shadow, matching
// .sidebar-status-card's own look rather than Home's glass cards.
function renderSidebarToolsCard() {
  return `
    <div class="sidebar-tools-card">
      <div class="sidebar-tools-title">Quick Tools</div>
      <div class="sidebar-tools-grid">
        ${QUICK_TOOLS.map(
          (t) => `
          <button type="button" class="sidebar-tool-btn" ${t.nav ? `data-nav="${t.nav}"` : `data-quick-tool="${t.key}"`}>
            ${reicon(t.reicon || t.icon, 15)}
            <span>${t.label}</span>
          </button>
        `,
        ).join("")}
      </div>
    </div>
  `;
}

// ---------- stub / secondary pages ----------

function renderTasksPage() {
  const allRuns = activeRuns();
  const totalCount = allRuns.length;
  const runningCount = allRuns.filter((r) => r.status === "running").length;
  const successCount = allRuns.filter((r) => r.status === "success").length;
  const errorCount = allRuns.filter((r) => r.status === "error").length;

  const q = (state.taskSearchQuery || "").trim().toLowerCase();
  const statusFilter = state.taskFilterStatus || "all";

  const filteredRuns = allRuns.filter((r) => {
    if (statusFilter === "running" && r.status !== "running") return false;
    if (statusFilter === "success" && r.status !== "success") return false;
    if (statusFilter === "error" && r.status !== "error") return false;
    if (q) {
      const matchGoal = (r.goal || "").toLowerCase().includes(q);
      const matchSummary = (r.summary || "").toLowerCase().includes(q);
      const matchDept = deptLabel(r.agentKey).toLowerCase().includes(q);
      if (!matchGoal && !matchSummary && !matchDept) return false;
    }
    return true;
  });

  return `
    <div class="tasks-page">
      <div class="tasks-header">
        <div class="tasks-header-title-col">
          <div class="tasks-eyebrow">📋 Workflow Runs</div>
          <h1 class="tasks-title">Tasks <span class="tasks-count-pill">${totalCount}</span></h1>
          <p class="tasks-subtitle">Monitor and review every execution across all departments.</p>
        </div>
        <div class="tasks-stats-strip">
          <div class="tasks-stat-chip${statusFilter === "all" ? " active" : ""}" data-task-status="all">
            <span class="tasks-stat-chip-label">Total</span>
            <span class="tasks-stat-chip-val">${totalCount}</span>
          </div>
          <div class="tasks-stat-chip${statusFilter === "running" ? " active" : ""}" data-task-status="running">
            <span class="tasks-stat-dot running"></span>
            <span class="tasks-stat-chip-label">Running</span>
            <span class="tasks-stat-chip-val">${runningCount}</span>
          </div>
          <div class="tasks-stat-chip${statusFilter === "success" ? " active" : ""}" data-task-status="success">
            <span class="tasks-stat-dot success"></span>
            <span class="tasks-stat-chip-label">Completed</span>
            <span class="tasks-stat-chip-val">${successCount}</span>
          </div>
          <div class="tasks-stat-chip${statusFilter === "error" ? " active" : ""}" data-task-status="error">
            <span class="tasks-stat-dot error"></span>
            <span class="tasks-stat-chip-label">Failed</span>
            <span class="tasks-stat-chip-val">${errorCount}</span>
          </div>
        </div>
      </div>

      <!-- Unified Glass List Card -->
      <div class="tasks-list-card">
        <div class="tasks-toolbar">
          <div class="tasks-search-wrap">
            <span class="tasks-search-icon">${icon("search")}</span>
            <input 
              type="text" 
              id="task-search-input" 
              class="tasks-search-input" 
              placeholder="Search tasks by goal or agent..." 
              value="${escapeHtml(state.taskSearchQuery || "")}"
            />
            ${state.taskSearchQuery ? `<button type="button" class="tasks-search-clear" id="task-search-clear" aria-label="Clear">${icon("x")}</button>` : ""}
          </div>
          <div class="tasks-filter-pills">
            <button type="button" class="tasks-filter-pill${statusFilter === "all" ? " active" : ""}" data-task-status="all">All</button>
            <button type="button" class="tasks-filter-pill${statusFilter === "running" ? " active" : ""}" data-task-status="running">
              ${runningCount ? `<span class="tasks-pill-dot running"></span>` : ""}Running
            </button>
            <button type="button" class="tasks-filter-pill${statusFilter === "success" ? " active" : ""}" data-task-status="success">Completed</button>
            <button type="button" class="tasks-filter-pill${statusFilter === "error" ? " active" : ""}" data-task-status="error">Failed</button>
          </div>
        </div>

        <div class="tasks-list-head-row">
          <div class="tasks-col-status">Status</div>
          <div class="tasks-col-goal">Task / Goal</div>
          <div class="tasks-col-agent">Assigned Agent</div>
          <div class="tasks-col-time">Created</div>
          <div class="tasks-col-action"></div>
        </div>

        <div class="tasks-items-list">
          ${
            filteredRuns.length
              ? filteredRuns
                  .map(
                    (r) => `
              <div class="task-list-row" data-open-run="${r.id}" role="button" tabindex="0" title="Click to view conversation in Chat">
                <div class="tasks-col-status">
                  <span class="task-status-badge ${r.status}">
                    ${r.status === "success" ? icon("check") : r.status === "running" ? `<span class="task-running-spinner"></span>` : icon("alert-circle")}
                  </span>
                </div>
                <div class="tasks-col-goal">
                  <span class="task-row-goal-text">${escapeHtml(r.goal)}</span>
                  ${r.summary && r.summary !== r.goal ? `<span class="task-row-summary-text">${escapeHtml(r.summary)}</span>` : ""}
                </div>
                <div class="tasks-col-agent">
                  <span class="task-agent-badge" style="--badge-color:${deptColor(r.agentKey)}">
                    <span class="task-agent-dot"></span>
                    ${escapeHtml(deptLabel(r.agentKey))}
                  </span>
                </div>
                <div class="tasks-col-time">
                  <span class="task-time-text">${formatRelativeTime(r.createdAt)}</span>
                </div>
                <div class="tasks-col-action">
                  <span class="task-open-arrow">${icon("chevron-right")}</span>
                </div>
              </div>
            `,
                  )
                  .join("")
              : `
              <div class="tasks-empty-state">
                <div class="tasks-empty-icon">${icon("inbox")}</div>
                <div class="tasks-empty-title">${q || statusFilter !== "all" ? "No matching tasks found" : "No tasks yet"}</div>
                <p class="tasks-empty-text">${q || statusFilter !== "all" ? "Try adjusting your search terms or filter criteria." : "Start your first automated task using the composer on Home."}</p>
              </div>
            `
          }
        </div>
      </div>
    </div>
  `;
}

function renderAgentsPage() {
  const running = runningAgentKeys();
  const allDepts = state.departments;
  const runningCount = running.size;
  const idleCount = allDepts.length - runningCount;

  // Tools connected count
  const toolsCount = state.toolsCatalog?.items?.filter((t) => t.connected)?.length ?? 12;

  // Search & category filter
  const q = (state.agentSearchQuery || "").trim().toLowerCase();
  const cat = state.agentFilterCategory || "all";

  const filteredDepts = allDepts.filter((d) => {
    if (cat !== "all" && DEPARTMENT_CATEGORIES[d.key] !== cat) return false;
    if (q) {
      const matchName = (d.label || "").toLowerCase().includes(q);
      const matchTag = (d.tagline || "").toLowerCase().includes(q);
      const skills = DEPARTMENT_CAPABILITIES[d.key] || [];
      const matchSkill = skills.some((s) => s.toLowerCase().includes(q));
      if (!matchName && !matchTag && !matchSkill) return false;
    }
    return true;
  });

  return `
    <div class="agents-page">
      <div class="agents-hero">
        <div class="agents-hero-text">
          <div class="agents-eyebrow">${icon("bot")} <span>AI WORKFORCE SYSTEM</span></div>
          <h1 class="agents-title">Autonomous Agents & Departments</h1>
          <p class="agents-subtitle">
            13 specialized autonomous departments equipped with native tools, real-time sandboxes, and cross-agent memory.
          </p>
        </div>
      </div>

      <!-- Workforce Metric Strip -->
      <div class="agents-metrics-strip">
        <div class="agents-metric-card">
          <div class="agents-metric-icon" style="background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent)">
            ${icon("users")}
          </div>
          <div class="agents-metric-data">
            <span class="agents-metric-value">${allDepts.length}</span>
            <span class="agents-metric-label">Departments</span>
          </div>
        </div>

        <div class="agents-metric-card">
          <div class="agents-metric-icon" style="background:rgba(255,176,32,0.14);color:var(--warning)">
            ${icon("activity")}
          </div>
          <div class="agents-metric-data">
            <span class="agents-metric-value ${runningCount ? "live" : ""}">${runningCount}</span>
            <span class="agents-metric-label">Active Now</span>
          </div>
        </div>

        <div class="agents-metric-card">
          <div class="agents-metric-icon" style="background:rgba(23,178,106,0.12);color:var(--success)">
            ${icon("check-circle-2")}
          </div>
          <div class="agents-metric-data">
            <span class="agents-metric-value">${idleCount}</span>
            <span class="agents-metric-label">Ready / Idle</span>
          </div>
        </div>

        <div class="agents-metric-card">
          <div class="agents-metric-icon" style="background:rgba(8,145,178,0.12);color:#0891b2">
            ${icon("wrench")}
          </div>
          <div class="agents-metric-data">
            <span class="agents-metric-value">${toolsCount}</span>
            <span class="agents-metric-label">Integrated Tools</span>
          </div>
        </div>
      </div>

      <!-- Search & Category Filters -->
      <div class="agents-controls-card">
        <div class="agents-search-wrap">
          <span class="agents-search-icon">${icon("search")}</span>
          <input 
            type="text" 
            id="agent-search-input" 
            class="agents-search-input" 
            placeholder="Search agents by title, role, skill (e.g. linear, code, email, pr)..." 
            value="${escapeHtml(state.agentSearchQuery)}"
          />
          ${state.agentSearchQuery ? `<button type="button" class="agents-search-clear" id="agent-search-clear">${icon("x")}</button>` : ""}
        </div>

        <div class="agents-filter-chips">
          <button type="button" class="agents-chip${cat === "all" ? " active" : ""}" data-agent-cat="all">All (${allDepts.length})</button>
          <button type="button" class="agents-chip${cat === "ops" ? " active" : ""}" data-agent-cat="ops">Operations & Exec</button>
          <button type="button" class="agents-chip${cat === "tech" ? " active" : ""}" data-agent-cat="tech">Tech & Research</button>
          <button type="button" class="agents-chip${cat === "growth" ? " active" : ""}" data-agent-cat="growth">Growth & Sales</button>
          <button type="button" class="agents-chip${cat === "comms" ? " active" : ""}" data-agent-cat="comms">Communications & Memory</button>
        </div>
      </div>

      <!-- Agent Cards Grid -->
      ${
        filteredDepts.length
          ? `<div class="agents-grid">
              ${filteredDepts.map((d) => renderAgentCard(d, running.has(d.key))).join("")}
            </div>`
          : `<div class="stub-placeholder" style="margin-top:20px">
              No departments matched "${escapeHtml(state.agentSearchQuery)}".
              <br /><br />
              <button type="button" class="card-link" id="agent-reset-search-btn" style="display:inline-flex">Reset filters</button>
            </div>`
      }

      <!-- Agent Drawer Modal -->
      ${state.agentDrawerKey ? renderAgentDrawerModal() : ""}
    </div>
  `;
}

function renderAgentCard(d, isRunning) {
  const color = (d.color && d.color[state.theme]) || "var(--accent)";
  const capabilities = DEPARTMENT_CAPABILITIES[d.key] || ["Autonomous Execution", "Tool Orchestration"];

  // Calculate completed runs for this department
  const runsForDept = state.runs.filter((r) => r.agentKey === d.key || r.events?.some((e) => e.source === d.key));
  const completedCount = runsForDept.filter((r) => r.status === "success").length;
  const lastActive = runsForDept[0]?.createdAt;

  return `
    <div class="agent-card" style="--agent-color: ${color}">
      <div class="agent-card-head">
        <div class="agent-card-avatar" style="background:${color}">
          ${icon(d.icon || "bot")}
        </div>
        <div class="agent-card-title-col">
          <div class="agent-card-title">${escapeHtml(d.label)}</div>
          <div class="agent-card-category">${escapeHtml(getCategoryLabel(DEPARTMENT_CATEGORIES[d.key]))}</div>
        </div>
        <span class="agent-status-pill ${isRunning ? "running" : "idle"}">
          <span class="agent-status-dot ${isRunning ? "pulse" : ""}"></span>
          ${isRunning ? "Running" : "Ready"}
        </span>
      </div>

      <p class="agent-card-tagline">${escapeHtml(d.tagline)}</p>

      <div class="agent-card-skills">
        ${capabilities.map((c) => `<span class="agent-skill-chip">${escapeHtml(c)}</span>`).join("")}
      </div>

      <div class="agent-card-stats-row">
        <span class="agent-stat-item">
          <span class="agent-stat-num">${completedCount}</span>
          <span class="agent-stat-lbl">tasks done</span>
        </span>
        <span class="agent-stat-item">
          <span class="agent-stat-num">${lastActive ? formatRelativeTime(lastActive) : "Ready"}</span>
          <span class="agent-stat-lbl">last active</span>
        </span>
      </div>

      <div class="agent-card-actions">
        <button type="button" class="agent-btn-primary" data-chat-agent="${d.key}">
          ${icon("message-square")} <span>Chat with ${escapeHtml(d.label)}</span>
        </button>
        <button type="button" class="agent-btn-secondary" data-inspect-agent="${d.key}" title="View Dossier">
          ${icon("info")} <span>Dossier</span>
        </button>
      </div>
    </div>
  `;
}

function renderAgentDrawerModal() {
  const d = deptMeta(state.agentDrawerKey);
  if (!d) return "";
  const color = (d.color && d.color[state.theme]) || "var(--accent)";
  const isRunning = runningAgentKeys().has(d.key);
  const tab = state.agentDrawerTab || "overview";

  // Matching tools from toolsCatalog
  const allTools = state.toolsCatalog?.items || [];
  const deptTools = allTools.filter((t) =>
    t.usedBy?.some((u) => u.toLowerCase() === d.label.toLowerCase() || u.toLowerCase() === d.key.toLowerCase()),
  );

  // Runs for this department
  const deptRuns = state.runs
    .filter((r) => r.agentKey === d.key || r.events?.some((e) => e.source === d.key))
    .slice(0, 10);

  return `
    <div class="agent-drawer-overlay" id="agent-drawer-backdrop">
      <div class="agent-drawer-card" style="--agent-color:${color}">
        <div class="agent-drawer-head">
          <div class="agent-drawer-avatar" style="background:${color}">
            ${icon(d.icon || "bot")}
          </div>
          <div class="agent-drawer-info">
            <h2 class="agent-drawer-name">${escapeHtml(d.label)} Agent</h2>
            <p class="agent-drawer-tagline">${escapeHtml(d.tagline)}</p>
          </div>
          <span class="agent-status-pill ${isRunning ? "running" : "idle"}" style="margin-left:auto">
            <span class="agent-status-dot ${isRunning ? "pulse" : ""}"></span>
            ${isRunning ? "Active Now" : "Ready"}
          </span>
          <button type="button" class="agent-drawer-close" id="agent-drawer-close-btn" aria-label="Close">${icon("x")}</button>
        </div>

        <div class="agent-drawer-tabs">
          <button type="button" class="agent-drawer-tab${tab === "overview" ? " active" : ""}" data-drawer-tab="overview">
            ${icon("file-text")} Overview
          </button>
          <button type="button" class="agent-drawer-tab${tab === "tools" ? " active" : ""}" data-drawer-tab="tools">
            ${icon("wrench")} Tools (${deptTools.length})
          </button>
          <button type="button" class="agent-drawer-tab${tab === "runs" ? " active" : ""}" data-drawer-tab="runs">
            ${icon("list")} Past Runs (${deptRuns.length})
          </button>
        </div>

        <div class="agent-drawer-body">
          ${
            tab === "overview"
              ? `
              <div class="agent-drawer-section">
                <h3 class="agent-drawer-section-title">Department Role & Capabilities</h3>
                <p class="agent-drawer-text">
                  The ${escapeHtml(d.label)} specialist agent operates under direct instruction from the founder or through orchestration by the CEO Agent. When complex multi-department tasks arrive, this agent is delegated specific sub-goals and reports back structured outputs.
                </p>
                <div class="agent-drawer-skills-box">
                  <div class="agent-drawer-section-title" style="margin-bottom:8px">Core Competencies:</div>
                  <div class="agent-card-skills">
                    ${(DEPARTMENT_CAPABILITIES[d.key] || []).map((c) => `<span class="agent-skill-chip">${escapeHtml(c)}</span>`).join("")}
                  </div>
                </div>
              </div>
              <div class="agent-drawer-section" style="margin-top:16px">
                <h3 class="agent-drawer-section-title">Execution Context</h3>
                <div class="agent-context-grid">
                  <div class="agent-context-tile">
                    <span class="agent-context-lbl">Delegation Mode</span>
                    <span class="agent-context-val">Synchronous & Managed</span>
                  </div>
                  <div class="agent-context-tile">
                    <span class="agent-context-lbl">Memory Persistence</span>
                    <span class="agent-context-val">Active Cross-Agent DB</span>
                  </div>
                </div>
              </div>
            `
              : tab === "tools"
              ? `
              <div class="agent-drawer-tools-list">
                ${
                  deptTools.length
                    ? deptTools
                        .map(
                          (t) => `
                      <div class="agent-tool-item">
                        <div class="agent-tool-item-head">
                          <span class="agent-tool-item-name">${escapeHtml(t.label)}</span>
                          <span class="status-badge ${t.connected ? "success" : "pending"}">${t.connected ? "Connected" : "Optional"}</span>
                        </div>
                        <ul class="agent-tool-features">
                          ${(t.features || []).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}
                        </ul>
                        ${t.examplePrompt ? `<div class="agent-tool-prompt"><strong>Example:</strong> "${escapeHtml(t.examplePrompt)}"</div>` : ""}
                      </div>
                    `,
                        )
                        .join("")
                    : `<div class="card-empty">This agent relies on system-level MCP integrations and sandboxed environment tools.</div>`
                }
              </div>
            `
              : `
              <div class="agent-drawer-runs-list">
                ${
                  deptRuns.length
                    ? deptRuns
                        .map(
                          (r) => `
                      <button type="button" class="stub-list-row agent-drawer-run-row" data-open-run="${r.id}" style="width:100%;text-align:left;cursor:pointer">
                        <span class="task-check ${r.status}">${r.status === "success" ? icon("check") : ""}</span>
                        <span class="stub-list-title">${escapeHtml(r.goal)}</span>
                        <span class="stub-list-meta">${formatRelativeTime(r.createdAt)}</span>
                      </button>
                    `,
                        )
                        .join("")
                    : `<div class="card-empty">No runs executed by this department yet.</div>`
                }
              </div>
            `
          }
        </div>

        <!-- Direct Task Launcher Footer -->
        <div class="agent-drawer-footer">
          <div class="agent-drawer-footer-title">Delegate a task to ${escapeHtml(d.label)}</div>
          <form id="agent-drawer-form" class="agent-drawer-form">
            <textarea 
              id="agent-drawer-input" 
              class="agent-drawer-input" 
              placeholder="Give ${escapeHtml(d.label)} an objective or prompt..." 
              rows="2"
              required
            >${escapeHtml(state.agentDrawerDraft)}</textarea>
            <div class="agent-drawer-form-actions">
              <label class="composer-model-trigger" style="height:32px">
                <i data-lucide="cpu" style="width:13px;height:13px"></i>
                <span class="composer-model-label">${state.agentDrawerProvider}</span>
                <select id="agent-drawer-provider">
                  ${MODEL_OPTIONS.map((o) => `<option value="${o.value}"${o.value === state.agentDrawerProvider ? " selected" : ""}>${o.label}</option>`).join("")}
                </select>
              </label>
              <button type="submit" class="agent-drawer-submit" ${state.agentDrawerSubmitting ? "disabled" : ""}>
                ${state.agentDrawerSubmitting ? icon("loader-2") : icon("arrow-right")}
                <span>${state.agentDrawerSubmitting ? "Starting..." : "Launch Task"}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

async function submitAgentDrawerGoal(agentKey, goal, provider = "auto") {
  if (!goal.trim()) return;
  state.agentDrawerSubmitting = true;
  render();
  try {
    const url = `/api/agents/${agentKey}/runs`;
    const result = await fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, provider, attachments: [] }),
    });
    state.agentDrawerKey = null; // close drawer
    state.agentDrawerDraft = "";
    await loadAll(true);
    if (result?.id) {
      openRun(result.id);
    } else {
      showToast("Task started.");
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
  state.agentDrawerSubmitting = false;
  render();
}


function renderDocumentsPage() {
  const docs = state.documents || [];
  return `
    <div class="docs-page">
      <div class="docs-header">
        <div class="docs-header-title-col">
          <div class="tasks-eyebrow">📄 Deliverables</div>
          <h1 class="tasks-title">Documents <span class="tasks-count-pill">${docs.length}</span></h1>
          <p class="tasks-subtitle">Deliverables, reports, and assets produced by your agent team.</p>
        </div>
      </div>

      <div class="tasks-list-card">
        <div class="tasks-list-head-row">
          <div class="tasks-col-status">Type</div>
          <div class="tasks-col-goal">Document Name</div>
          <div class="tasks-col-agent">Generated By</div>
          <div class="tasks-col-time">Created</div>
          <div class="tasks-col-action">Action</div>
        </div>

        <div class="tasks-items-list">
          ${
            docs.length
              ? docs
                  .map(
                    (d) => `
              <div class="task-list-row doc-row">
                <div class="tasks-col-status">
                  <span class="doc-file-icon">${icon("file-text")}</span>
                </div>
                <div class="tasks-col-goal">
                  <span class="task-row-goal-text">${escapeHtml(d.title)}</span>
                </div>
                <div class="tasks-col-agent">
                  <span class="task-agent-badge" style="--badge-color:${deptColor(d.agentKey)}">
                    <span class="task-agent-dot"></span>
                    ${escapeHtml(deptLabel(d.agentKey))}
                  </span>
                </div>
                <div class="tasks-col-time">
                  <span class="task-time-text">${formatRelativeTime(d.createdAt)}</span>
                </div>
                <div class="tasks-col-action">
                  <a class="doc-download-btn" href="/api/documents/${d.id}/download" target="_blank" rel="noopener">
                    ${icon("download")} <span>Download</span>
                  </a>
                </div>
              </div>
            `,
                  )
                  .join("")
              : `
              <div class="tasks-empty-state">
                <div class="tasks-empty-icon">${icon("file-text")}</div>
                <div class="tasks-empty-title">No documents yet</div>
                <p class="tasks-empty-text">When agents generate files, exports, or summaries, they will appear here as a list.</p>
              </div>
            `
          }
        </div>
      </div>
    </div>
  `;
}

function renderAnalyticsPage() {
  const a = state.analytics;
  if (!a) return `<div class="stub-placeholder">Analytics unavailable.</div>`;
  const totalRuns = a.totals.totalRuns || 1;
  const deptRuns = a.runsByDepartment
    .filter((d) => d.count > 0)
    .sort((x, y) => y.count - x.count);

  return `
    <div class="tasks-page analytics-page">
      <div class="tasks-header">
        <div class="tasks-header-title-col">
          <div class="tasks-eyebrow">📊 Real-time Metrics</div>
          <h1 class="tasks-title">Analytics</h1>
          <p class="tasks-subtitle">Real totals across workflow runs, departmental performance, and token expenditures.</p>
        </div>
      </div>

      <div class="stat-tiles">
        <div class="stat-tile"><div class="stat-tile-value">${a.totals.totalRuns}</div><div class="stat-tile-label">Total Runs</div></div>
        <div class="stat-tile"><div class="stat-tile-value" style="color:var(--success)">${a.totals.successRuns}</div><div class="stat-tile-label">Succeeded</div></div>
        <div class="stat-tile"><div class="stat-tile-value" style="color:var(--error)">${a.totals.errorRuns}</div><div class="stat-tile-label">Failed</div></div>
        <div class="stat-tile"><div class="stat-tile-value" style="color:var(--warning)">${a.totals.runningRuns}</div><div class="stat-tile-label">Running Now</div></div>
        <div class="stat-tile"><div class="stat-tile-value">$${a.totals.totalCostUsd.toFixed(2)}</div><div class="stat-tile-label">Estimated Cost</div></div>
        <div class="stat-tile"><div class="stat-tile-value">${a.totals.totalDocuments}</div><div class="stat-tile-label">Documents</div></div>
      </div>

      <div class="tasks-list-card" style="margin-top:20px">
        <div class="tasks-toolbar">
          <span class="tasks-stat-chip-label" style="font-weight:700;color:var(--text);font-size:13px">Runs by Department</span>
          <span class="tasks-stat-chip-val" style="margin-left:auto">${deptRuns.length} Active Departments</span>
        </div>

        <div class="tasks-list-head-row">
          <div style="width:200px;flex-shrink:0;padding:0 12px">Department</div>
          <div style="flex:1;min-width:0;padding:0 12px">Volume Share</div>
          <div style="width:100px;flex-shrink:0;padding:0 10px;text-align:right">Runs Share</div>
          <div style="width:110px;flex-shrink:0;padding:0 12px;text-align:right">Total Runs</div>
        </div>

        <div class="tasks-items-list">
          ${
            deptRuns.length
              ? deptRuns
                  .map((d) => {
                    const pct = Math.round((d.count / totalRuns) * 100);
                    return `
              <div class="task-list-row analytics-dept-row">
                <div style="width:200px;flex-shrink:0;padding:0 12px;display:flex;align-items:center;gap:8px">
                  <span class="agent-dot" style="background:${deptColor(d.agentKey)}"></span>
                  <span class="task-row-goal-text">${escapeHtml(d.label)}</span>
                </div>
                <div style="flex:1;min-width:0;padding:0 12px">
                  <div style="height:6px;border-radius:3px;background:rgba(0,0,0,0.06);overflow:hidden;position:relative">
                    <div style="height:100%;width:${pct}%;background:${deptColor(d.agentKey)};border-radius:3px;transition:width 0.4s ease"></div>
                  </div>
                </div>
                <div style="width:100px;flex-shrink:0;padding:0 10px;text-align:right">
                  <span class="task-time-text" style="font-weight:600">${pct}%</span>
                </div>
                <div style="width:110px;flex-shrink:0;padding:0 12px;text-align:right">
                  <span class="task-agent-badge" style="--badge-color:${deptColor(d.agentKey)}">
                    ${d.count} run${d.count === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            `;
                  })
                  .join("")
              : `
              <div class="tasks-empty-state">
                <div class="tasks-empty-icon">${icon("bar-chart-3")}</div>
                <div class="tasks-empty-title">No runs recorded</div>
                <p class="tasks-empty-text">Runs completed by agents will show up here segmented by department.</p>
              </div>
            `
          }
        </div>
      </div>

      <div style="margin-top:20px">
        ${renderExternalAnalytics()}
      </div>
    </div>
  `;
}

function renderExternalAnalytics() {
  const ext = state.externalAnalytics;
  if (ext.loading && !ext.loaded) return `<div class="stub-placeholder">Loading connected project's analytics…</div>`;
  if (ext.error) return `<div class="stub-placeholder">Couldn't load connected project's analytics: ${escapeHtml(ext.error)}</div>`;
  const data = ext.data;
  if (!data || !data.configured) {
    return `
      <div class="tasks-list-card" style="padding:24px;text-align:center">
        <div class="tasks-empty-icon">${icon("bar-chart-2")}</div>
        <div class="tasks-empty-title">No External Analytics Connected</div>
        <p class="tasks-empty-text" style="margin-bottom:14px">Connect Plausible, PostHog, or custom telemetry in Accounts to view user traffic.</p>
        <button type="button" class="btn-primary" id="analytics-connect-btn">${icon("plug")} Connect in Accounts</button>
      </div>
    `;
  }
  if (data.error) return `<div class="stub-placeholder">Connected, but the last fetch failed: ${escapeHtml(data.error)}</div>`;

  if (state.externalDashboard.expanded) return renderExternalDashboard();

  const known = ["login", "signup", "page_view"];
  const top = data.totals.byEventType.slice(0, 8);
  const maxEventCount = Math.max(1, ...top.map((e) => e.count));

  return `
    <div class="tasks-list-card">
      <div class="tasks-toolbar">
        <span class="tasks-stat-chip-label" style="font-weight:700;color:var(--text);font-size:13px">${escapeHtml(data.label || "Connected Project")} Traffic (14d)</span>
        <button type="button" class="btn-primary" id="external-dashboard-btn" style="font-size:11.5px;padding:4px 10px;margin-left:auto">
          Expanded Dashboard ${icon("bar-chart-3")}
        </button>
      </div>

      <div class="stat-tiles" style="margin:16px">
        <div class="stat-tile"><div class="stat-tile-value">${data.totals.uniqueVisitors}</div><div class="stat-tile-label">Unique visitors (14d)</div></div>
        <div class="stat-tile"><div class="stat-tile-value">${data.totals.totalEvents}</div><div class="stat-tile-label">Total events (14d)</div></div>
        ${top
          .filter((e) => known.includes(e.eventType))
          .map((e) => `<div class="stat-tile"><div class="stat-tile-value">${e.count}</div><div class="stat-tile-label">${escapeHtml(e.eventType.replace("_", " "))}s</div></div>`)
          .join("")}
      </div>

      <div class="tasks-list-head-row">
        <div style="width:200px;flex-shrink:0;padding:0 12px">Event Type</div>
        <div style="flex:1;min-width:0;padding:0 12px">Distribution</div>
        <div style="width:120px;flex-shrink:0;padding:0 12px;text-align:right">Event Count</div>
      </div>

      <div class="tasks-items-list">
        ${top
          .map((e) => {
            const pct = Math.round((e.count / maxEventCount) * 100);
            return `
          <div class="task-list-row analytics-event-row">
            <div style="width:200px;flex-shrink:0;padding:0 12px">
              <span class="task-row-goal-text">${escapeHtml(e.eventType.replace("_", " "))}</span>
            </div>
            <div style="flex:1;min-width:0;padding:0 12px">
              <div style="height:6px;border-radius:3px;background:rgba(0,0,0,0.06);overflow:hidden;position:relative">
                <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:3px"></div>
              </div>
            </div>
            <div style="width:120px;flex-shrink:0;padding:0 12px;text-align:right">
              <span class="task-agent-badge" style="--badge-color:var(--accent)">${e.count.toLocaleString()}</span>
            </div>
          </div>
        `;
          })
          .join("")}
      </div>
    </div>
  `;
}

async function loadExternalAnalytics(force) {
  if (state.externalAnalytics.loaded && !force) return;
  state.externalAnalytics.loading = true;
  render();
  try {
    state.externalAnalytics.data = await fetchJSON("/api/analytics/external");
    state.externalAnalytics.loaded = true;
    state.externalAnalytics.error = null;
  } catch (err) {
    state.externalAnalytics.error = err instanceof Error ? err.message : String(err);
  }
  state.externalAnalytics.loading = false;
  render();
}
LAZY_LOADERS.analytics = () => loadExternalAnalytics(false);

// ---------- Connected-project full dashboard (expanded in-place, same tab) ----------

const EXT_RANGES = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

const EXT_METRICS = [
  { key: "visitors", label: "Unique visitors" },
  { key: "pageViews", label: "Page views" },
  { key: "linkVisits", label: "Link visits" },
  { key: "clicks", label: "Clicks" },
  { key: "logins", label: "Logins" },
  { key: "signups", label: "Sign-ups" },
  { key: "listingViews", label: "Listing views" },
  { key: "bookingStarts", label: "Booking attempts" },
];

function formatCompact(n) {
  if (n == null) return "0";
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatChartDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function deltaBadge(pct) {
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "↑" : pct < 0 ? "↓" : "";
  return `<span class="delta ${dir}">${sign} ${Math.abs(pct)}%</span>`;
}

function buildTrendChart(daily, metricKey) {
  const W = 760, H = 220, padL = 42, padR = 12, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const values = daily.map((d) => d[metricKey] ?? 0);
  const niceMax = niceCeil(Math.max(...values, 1));
  const xStep = plotW / Math.max(values.length - 1, 1);

  const points = values.map((v, i) => ({
    x: padL + i * xStep,
    y: padT + plotH - (v / niceMax) * plotH,
    v,
    date: daily[i].date,
  }));

  const linePath = `M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}`;
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const gridFracs = [0, 1 / 3, 2 / 3, 1];
  const gridlines = gridFracs
    .map((f) => {
      const y = padT + plotH * f;
      const val = Math.round(niceMax * (1 - f));
      return `
        <line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="var(--border)" stroke-width="1" />
        <text x="${padL - 8}" y="${y + 3}" text-anchor="end" font-size="9.5" fill="var(--text-faint)">${formatCompact(val)}</text>
      `;
    })
    .join("");

  const xLabelIdx = points.length > 1 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [0];
  const xLabels = [...new Set(xLabelIdx)]
    .map((i) => `<text x="${points[i].x}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="var(--text-faint)">${escapeHtml(formatChartDate(points[i].date))}</text>`)
    .join("");

  const last = points[points.length - 1];

  return {
    points,
    svg: `
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg" role="img" aria-label="Trend chart">
        ${gridlines}
        <path d="${areaPath}" fill="var(--accent)" fill-opacity="0.1" stroke="none" />
        <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${last.x}" cy="${last.y}" r="4" fill="var(--accent)" stroke="var(--bg-raised)" stroke-width="2" />
        <text x="${Math.min(last.x + 8, W - padR - 24)}" y="${last.y - 8}" font-size="11" font-weight="700" fill="var(--text)">${formatCompact(last.v)}</text>
        ${xLabels}
        <line class="trend-crosshair" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" stroke="var(--text-faint)" stroke-width="1" opacity="0" />
        <circle class="trend-hoverdot" r="4" fill="var(--accent)" stroke="var(--bg-raised)" stroke-width="2" opacity="0" />
        <rect class="trend-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" />
      </svg>
    `,
  };
}

function attachTrendInteraction(points) {
  const svg = document.querySelector(".trend-svg");
  const hit = document.querySelector(".trend-hit");
  const crosshair = document.querySelector(".trend-crosshair");
  const dot = document.querySelector(".trend-hoverdot");
  const tooltip = document.getElementById("trend-tooltip");
  if (!svg || !hit || !tooltip) return;

  const metricLabel = EXT_METRICS.find((m) => m.key === state.externalDashboard.metric)?.label || "";

  function handleMove(clientX) {
    const rect = svg.getBoundingClientRect();
    const scale = 760 / rect.width;
    const xUser = (clientX - rect.left) * scale;
    let nearest = points[0], best = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - xUser);
      if (d < best) { best = d; nearest = p; }
    }
    crosshair.setAttribute("x1", nearest.x);
    crosshair.setAttribute("x2", nearest.x);
    crosshair.setAttribute("opacity", "1");
    dot.setAttribute("cx", nearest.x);
    dot.setAttribute("cy", nearest.y);
    dot.setAttribute("opacity", "1");

    const wrap = svg.closest(".chart-wrap");
    const wrapRect = wrap.getBoundingClientRect();
    const px = rect.left - wrapRect.left + nearest.x / scale;
    const py = rect.top - wrapRect.top + nearest.y / scale;
    tooltip.style.left = `${px}px`;
    tooltip.style.top = `${py}px`;
    tooltip.classList.add("show");
    tooltip.querySelector(".ct-value").textContent = `${formatCompact(nearest.v)} ${metricLabel}`;
    tooltip.querySelector(".ct-date").textContent = formatChartDate(nearest.date);
  }

  hit.addEventListener("pointermove", (e) => handleMove(e.clientX));
  hit.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", "0");
    dot.setAttribute("opacity", "0");
    tooltip.classList.remove("show");
  });
}

function renderExtHeader(data) {
  return `
    <div class="card" style="margin-bottom:18px">
      <div class="card-head">
        <span class="card-title">${escapeHtml(data.label || "Connected Project")}</span>
        <button type="button" class="row-icon-btn" id="external-dashboard-refresh-btn" aria-label="Refresh">${icon("refresh-cw")}</button>
      </div>
      <div class="page-tabs">
        ${EXT_RANGES.map((r) => `<button type="button" class="page-tab${state.externalDashboard.range === r.key ? " active" : ""}" data-ext-range="${r.key}">${r.label}</button>`).join("")}
      </div>
    </div>
  `;
}

function renderExtStatTiles(data) {
  const { current, pctChange } = data.totals;
  return `
    <div class="stat-tiles">
      ${EXT_METRICS.map(
        (m) => `
        <div class="stat-tile">
          <div class="stat-tile-head">
            <div class="stat-tile-value">${formatCompact(current[m.key])}</div>
            ${deltaBadge(pctChange[m.key])}
          </div>
          <div class="stat-tile-label">${escapeHtml(m.label)}</div>
        </div>
      `,
      ).join("")}
    </div>
  `;
}

function renderExtTrendSection(data) {
  const { svg, points } = buildTrendChart(data.daily, state.externalDashboard.metric);
  const tableRows = data.daily
    .map((d) => `<tr><td>${escapeHtml(formatChartDate(d.date))}</td><td>${formatCompact(d[state.externalDashboard.metric] ?? 0)}</td></tr>`)
    .join("");
  return `
    <div class="card" style="margin-top:18px">
      <div class="chart-card-head">
        <span class="card-title">Trend over time</span>
        <button type="button" class="table-toggle-btn" id="ext-trend-table-toggle">${state.externalDashboard.trendTableView ? "View as chart" : "View as table"}</button>
      </div>
      <div class="page-tabs" style="margin-bottom:14px">
        ${EXT_METRICS.map((m) => `<button type="button" class="page-tab${state.externalDashboard.metric === m.key ? " active" : ""}" data-ext-metric="${m.key}">${escapeHtml(m.label)}</button>`).join("")}
      </div>
      ${
        state.externalDashboard.trendTableView
          ? `<table class="viz-sr-table"><thead><tr><th>Date</th><th>${escapeHtml(EXT_METRICS.find((m) => m.key === state.externalDashboard.metric)?.label || "")}</th></tr></thead><tbody>${tableRows}</tbody></table>`
          : `
          <div class="chart-wrap">
            ${svg}
            <div class="chart-tooltip" id="trend-tooltip"><div class="ct-value"></div><div class="ct-date"></div></div>
          </div>
        `
      }
      <div data-trend-points='${JSON.stringify(points.map((p) => ({ x: p.x, y: p.y, v: p.v, date: p.date })))}' style="display:none"></div>
    </div>
  `;
}

function renderExtEventBreakdown(data) {
  const rows = EXT_METRICS.filter((m) => m.key !== "visitors")
    .map((m) => ({ label: m.label, value: data.totals.current[m.key] }))
    .sort((a, b) => b.value - a.value);
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `
    <div class="card">
      <div class="card-head"><span class="card-title">Events this period</span></div>
      ${rows
        .map(
          (r) => `
        <div class="rank-row">
          <span class="rank-label">${escapeHtml(r.label)}</span>
          <span class="rank-bar-track"><span class="rank-bar-fill" style="width:${(r.value / max) * 100}%"></span></span>
          <span class="rank-value">${formatCompact(r.value)}</span>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderExtFunnel(data) {
  const base = data.funnel[0]?.count || 1;
  return `
    <div class="card">
      <div class="card-head"><span class="card-title">Conversion funnel</span></div>
      ${data.funnel
        .map((f, i) => {
          const pctOfBase = Math.round((f.count / base) * 100);
          const opacity = 0.4 + i * (0.6 / Math.max(data.funnel.length - 1, 1));
          return `
          <div class="funnel-row">
            <div class="funnel-row-head">
              <span class="funnel-row-label">${escapeHtml(f.stage)}</span>
              <span class="funnel-row-meta">${formatCompact(f.count)} · ${pctOfBase}%</span>
            </div>
            <div class="funnel-track"><div class="funnel-fill" style="width:${pctOfBase}%;opacity:${opacity.toFixed(2)}"></div></div>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

function renderExtDevice(data) {
  if (!data.device.length) return "";
  const slotVar = (i) => `var(--series-${(i % 3) + 1})`;
  return `
    <div class="card" style="margin-top:18px">
      <div class="card-head"><span class="card-title">Audience — device</span></div>
      <div class="device-track">
        ${data.device.map((d, i) => `<span class="device-seg" style="width:${d.pct}%;background:${slotVar(i)}"></span>`).join("")}
      </div>
      <div class="device-legend">
        ${data.device
          .map(
            (d, i) => `
          <span class="device-legend-item">
            <span class="device-legend-dot" style="background:${slotVar(i)}"></span>
            <span class="device-legend-label">${escapeHtml(d.device)}</span>
            <span class="device-legend-meta">${d.pct}% · ${formatCompact(d.visitors)}</span>
          </span>
        `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderExtRankCard(title, items, labelKey, valueKey, valueFormatter) {
  if (!items.length) {
    return `<div class="card"><div class="card-head"><span class="card-title">${escapeHtml(title)}</span></div><div class="stub-placeholder" style="padding:24px">No data in this period.</div></div>`;
  }
  const max = Math.max(...items.map((it) => it[valueKey]), 1);
  return `
    <div class="card">
      <div class="card-head"><span class="card-title">${escapeHtml(title)}</span></div>
      ${items
        .map(
          (it) => `
        <div class="rank-row">
          <span class="rank-label">${escapeHtml(it[labelKey])}</span>
          <span class="rank-bar-track"><span class="rank-bar-fill" style="width:${(it[valueKey] / max) * 100}%"></span></span>
          <span class="rank-value">${valueFormatter ? valueFormatter(it) : formatCompact(it[valueKey])}</span>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderExtHeatmap(data) {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDow = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const c of data.peakHours.cells) byDow[c.dow][c.hour] = c.count;
  const max = data.peakHours.max || 1;

  const hourHeaderCells = Array.from({ length: 24 }, (_, h) => `<div class="heatmap-hour-label">${h % 3 === 0 ? h : ""}</div>`).join("");
  const rows = DAYS.map((dayLabel, dow) => {
    const cells = byDow[dow]
      .map((count, hour) => {
        const opacity = count === 0 ? 0 : 0.12 + (count / max) * 0.88;
        return `<div class="heatmap-cell" style="opacity:${opacity.toFixed(2)}" tabindex="0" role="img" aria-label="${escapeHtml(dayLabel)} ${hour}:00, ${count} events"><title>${escapeHtml(dayLabel)} ${hour}:00 — ${count} event${count === 1 ? "" : "s"}</title></div>`;
      })
      .join("");
    return `<div class="heatmap-day-label">${dayLabel}</div>${cells}`;
  }).join("");

  return `
    <div class="card" style="margin-top:18px">
      <div class="card-head"><span class="card-title">Peak hours (UTC)</span></div>
      <div class="heatmap-scroll">
        <div class="heatmap-grid">
          <div></div>${hourHeaderCells}
          ${rows}
        </div>
      </div>
    </div>
  `;
}

function renderExternalDashboard() {
  const dash = state.externalDashboard;
  const backBtn = `<button type="button" class="card-link chat-back" id="external-dashboard-back-btn" style="margin-bottom:14px">${icon("chevron-left")} Back to summary</button>`;
  if (dash.loading && !dash.data) return `${backBtn}<div class="stub-placeholder">Loading dashboard…</div>`;
  if (dash.error) return `${backBtn}<div class="stub-placeholder">Couldn't load dashboard: ${escapeHtml(dash.error)}</div>`;
  const data = dash.data;
  if (!data || !data.configured) return `${backBtn}<div class="stub-placeholder">No analytics source connected.</div>`;
  if (data.error) return `${backBtn}<div class="stub-placeholder">Connected, but the last fetch failed: ${escapeHtml(data.error)}</div>`;

  return `
    <div class="viz-root">
      ${backBtn}
      ${renderExtHeader(data)}
      ${renderExtStatTiles(data)}
      ${renderExtTrendSection(data)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px">
        ${renderExtEventBreakdown(data)}
        ${renderExtFunnel(data)}
      </div>
      ${renderExtDevice(data)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px">
        ${renderExtRankCard("Top pages", data.topPages, "path", "views")}
        ${renderExtRankCard("Traffic sources", data.sources, "source", "visitors")}
      </div>
      ${renderExtRankCard("Exit pages", data.exitPages, "path", "exits", (it) => `${formatCompact(it.exits)} · ${it.exitRate}% exit`)}
      ${renderExtHeatmap(data)}
    </div>
  `;
}

async function loadExternalDashboard(range) {
  state.externalDashboard.range = range;
  state.externalDashboard.loading = true;
  state.externalDashboard.error = null;
  render();
  try {
    state.externalDashboard.data = await fetchJSON(`/api/analytics/external/dashboard?range=${encodeURIComponent(range)}`);
  } catch (err) {
    state.externalDashboard.error = err instanceof Error ? err.message : String(err);
  }
  state.externalDashboard.loading = false;
  render();
}

function renderSettingsPage() {
  if (state.settingsLoading && !state.settingsFields) return `<div class="stub-placeholder">Loading settings…</div>`;
  if (state.settingsError) return `<div class="stub-placeholder">Couldn't load settings: ${escapeHtml(state.settingsError)}</div>`;
  const fields = state.settingsFields || [];
  const groups = [];
  for (const f of fields) {
    let group = groups.find((g) => g.name === f.group);
    if (!group) {
      group = { name: f.group, fields: [] };
      groups.push(group);
    }
    group.fields.push(f);
  }
  const dirtyCount = Object.keys(state.settingsEdits).filter((k) => state.settingsEdits[k].trim()).length;
  const configuredCount = fields.filter((f) => f.isSet).length;

  return `
    <div class="tasks-page settings-page">
      <div class="tasks-header">
        <div class="tasks-header-title-col">
          <div class="tasks-eyebrow">⚙️ Configuration & Secrets</div>
          <h1 class="tasks-title">Settings <span class="tasks-count-pill">${configuredCount}/${fields.length} set</span></h1>
          <p class="tasks-subtitle">Provider API keys, AI model endpoints, and secrets — securely configured in environment.</p>
        </div>
      </div>
      <div class="settings-savebar${dirtyCount ? " show" : ""}">
        <span>${dirtyCount} field${dirtyCount === 1 ? "" : "s"} changed</span>
        <button type="button" class="btn-primary" id="settings-save-btn" ${state.settingsSaving ? "disabled" : ""}>${state.settingsSaving ? "Saving…" : "Save changes"}</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:18px">
        ${groups
          .map(
            (g) => `
          <div class="tasks-list-card settings-group">
            <div class="tasks-toolbar">
              <span class="tasks-stat-chip-label" style="font-weight:700;color:var(--text);font-size:13px">${escapeHtml(g.name)}</span>
              <span class="task-agent-badge" style="--badge-color:var(--accent);margin-left:auto">${g.fields.filter((f) => f.isSet).length}/${g.fields.length} configured</span>
            </div>
            <div class="tasks-items-list">
              ${g.fields
                .map(
                  (f) => `
                <div class="task-list-row settings-row" style="cursor:default;flex-wrap:wrap;gap:10px;padding:14px 20px">
                  <div style="width:240px;flex-shrink:0">
                    <span class="task-row-goal-text">${escapeHtml(f.label)}</span>
                    <span class="task-row-summary-text" style="font-family:monospace;font-size:11px">${escapeHtml(f.envVar)}</span>
                  </div>
                  <div style="flex:1;min-width:260px">
                    <input 
                      type="password" 
                      class="tasks-search-input" 
                      autocomplete="off" 
                      data-settings-field="${escapeHtml(f.envVar)}" 
                      placeholder="${f.isSet ? "Enter a new value to replace it" : "Not set"}" 
                      value="${escapeHtml(state.settingsEdits[f.envVar] ?? "")}" 
                      style="font-family:inherit"
                    />
                  </div>
                  <div style="width:130px;flex-shrink:0;text-align:right">
                    <span class="status-badge ${f.isSet ? "success" : "running"}" style="display:inline-flex;align-items:center;gap:5px;font-size:11px">
                      <span class="task-agent-dot" style="background:currentColor"></span>
                      ${f.isSet ? "Configured" : "Not set"}
                    </span>
                  </div>
                </div>
              `,
                )
                .join("")}
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `;
}

// ---------- Chat / run-detail page ----------

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- Chat: Two-Column Split Layout & Conversation Engine ----------

function renderChatPage() {
  const allRuns = activeRuns();
  const q = (state.chatSearchQuery || "").trim().toLowerCase();
  const statusFilter = state.chatFilterStatus || "all";
  const agentFilter = state.chatFilterAgent || "all";

  // Filter runs
  const filteredRuns = allRuns.filter((r) => {
    if (statusFilter === "running" && r.status !== "running") return false;
    if (statusFilter === "success" && r.status !== "success") return false;
    if (statusFilter === "error" && r.status !== "error") return false;
    if (statusFilter === "pinned" && !r.pinned) return false;
    if (agentFilter !== "all" && r.agentKey !== agentFilter) return false;
    if (q) {
      const matchGoal = (r.goal || "").toLowerCase().includes(q);
      const matchSummary = (r.summary || "").toLowerCase().includes(q);
      const matchDept = deptLabel(r.agentKey).toLowerCase().includes(q);
      if (!matchGoal && !matchSummary && !matchDept) return false;
    }
    return true;
  });

  // Sort: pinned first, then newest
  filteredRuns.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });

  const runningCount = allRuns.filter((r) => r.status === "running").length;

  return `
    <div class="chat-split-layout${state.openRunId || state.chatMobileNew ? " show-thread" : ""}${state.chatListCollapsed ? " list-collapsed" : ""}">
      <!-- Left Column: Conversations Explorer Sidebar -->
      <aside class="chat-sidebar">
        <div class="chat-sidebar-rail">
          <button type="button" class="chat-list-toggle" data-chat-list-toggle title="Show conversations">
            ${icon("panel-left-open")}
          </button>
          <button type="button" class="chat-list-toggle" id="chat-new-rail-btn" title="New chat">
            ${icon("plus")}
          </button>
        </div>
        <div class="chat-sidebar-head">
          <div class="chat-sidebar-title-row">
            <h2 class="chat-sidebar-title">
              Conversations <span class="chat-count-badge">${allRuns.length}</span>
            </h2>
            <button type="button" class="chat-new-chat-btn" id="chat-new-btn">
              ${icon("plus")} <span>New Chat</span>
            </button>
            <button type="button" class="chat-list-toggle chat-list-collapse" data-chat-list-toggle title="Collapse conversations">
              ${icon("panel-left-close")}
            </button>
          </div>

          <!-- Search Input -->
          <div class="chat-search-wrap">
            <span class="chat-search-icon">${icon("search")}</span>
            <input 
              type="text" 
              id="chat-search-input" 
              class="chat-search-input" 
              placeholder="Search conversations..." 
              value="${escapeHtml(state.chatSearchQuery)}"
            />
            ${state.chatSearchQuery ? `<button type="button" class="chat-search-clear" id="chat-search-clear" aria-label="Clear">${icon("x")}</button>` : ""}
          </div>

          <!-- Status Filter Chips -->
          <div class="chat-filter-pills">
            <button type="button" class="chat-filter-pill${statusFilter === "all" ? " active" : ""}" data-chat-status="all">All</button>
            <button type="button" class="chat-filter-pill${statusFilter === "running" ? " active" : ""}" data-chat-status="running">
              ${runningCount ? `<span class="chat-pill-dot running"></span>` : ""}Running
            </button>
            <button type="button" class="chat-filter-pill${statusFilter === "success" ? " active" : ""}" data-chat-status="success">Completed</button>
            <button type="button" class="chat-filter-pill${statusFilter === "error" ? " active" : ""}" data-chat-status="error">Failed</button>
            <button type="button" class="chat-filter-pill${statusFilter === "pinned" ? " active" : ""}" data-chat-status="pinned">
              ${icon("pin")} Pinned
            </button>
          </div>

          <!-- Agent Dropdown Filter -->
          <div class="chat-agent-filter-wrap">
            <select id="chat-filter-agent" class="chat-agent-select" aria-label="Filter by department">
              <option value="all"${agentFilter === "all" ? " selected" : ""}>All Agents</option>
              <option value="ceo"${agentFilter === "ceo" ? " selected" : ""}>CEO (Orchestrator)</option>
              ${state.departments.map((d) => `<option value="${d.key}"${agentFilter === d.key ? " selected" : ""}>${escapeHtml(d.label)}</option>`).join("")}
            </select>
          </div>
        </div>

        <!-- Conversations List -->
        <div class="chat-conversations-list">
          ${
            filteredRuns.length
              ? filteredRuns.map((r) => renderConversationItem(r)).join("")
              : `<div class="chat-empty-list">No conversations found.</div>`
          }
        </div>
      </aside>

      <!-- Right Column: Active Thread or New Chat Canvas -->
      <main class="chat-main-area">
        ${
          state.openRunId
            ? renderActiveChatThread()
            : renderNewChatCanvas()
        }
      </main>
    </div>
  `;
}

function renderConversationItem(r) {
  const isActive = state.openRunId === r.id;
  const isMenuOpen = state.chatMenuOpenRunId === r.id;
  const color = deptColor(r.agentKey);
  const statusIcon = r.status === "running" ? "loader-2" : r.status === "success" ? "check" : "alert-circle";

  return `
    <div class="chat-conv-item${isActive ? " active" : ""}" data-open-run="${r.id}">
      <div class="chat-conv-item-top">
        <span class="chat-conv-status ${r.status}">
          ${r.status === "running" ? `<span class="chat-spin-dot"></span>` : icon(statusIcon)}
        </span>
        <span class="chat-conv-dept-tag" style="background:color-mix(in srgb, ${color} 14%, transparent);color:${color}">
          ${escapeHtml(deptLabel(r.agentKey))}
        </span>
        ${r.pinned ? `<span class="chat-conv-pin-icon" title="Pinned">${icon("pin")}</span>` : ""}
        <span class="chat-conv-time">${formatRelativeTime(r.createdAt)}</span>

        <button type="button" class="chat-conv-menu-btn" data-conv-menu="${r.id}" title="Conversation options">
          ${icon("more-vertical")}
        </button>

        ${
          isMenuOpen
            ? `
          <div class="chat-conv-popover" id="chat-conv-popover-${r.id}">
            <button type="button" class="chat-popover-item" data-action-pin="${r.id}">
              ${icon("pin")} <span>${r.pinned ? "Unpin" : "Pin to top"}</span>
            </button>
            <button type="button" class="chat-popover-item" data-action-copy-transcript="${r.id}">
              ${icon("copy")} <span>Copy Transcript</span>
            </button>
            <button type="button" class="chat-popover-item" data-action-archive="${r.id}">
              ${icon("archive")} <span>Archive</span>
            </button>
            <button type="button" class="chat-popover-item danger" data-action-delete="${r.id}">
              ${icon("trash-2")} <span>Delete</span>
            </button>
          </div>
        `
            : ""
        }
      </div>

      <div class="chat-conv-goal">${escapeHtml(r.goal)}</div>
    </div>
  `;
}

function renderActiveChatThread() {
  if (state.openRunLoading) {
    return `
      <div class="chat-loading-pane">
        <div class="chat-spin-indicator"></div>
        <span>Loading conversation…</span>
      </div>
    `;
  }
  if (state.openRunError) {
    return `
      <div class="chat-error-pane">
        <div class="chat-error-title">Couldn't load conversation</div>
        <p>${escapeHtml(state.openRunError)}</p>
        <button type="button" class="chat-action-btn" id="chat-back-btn">← Back to chats</button>
      </div>
    `;
  }
  const run = state.openRun;
  if (!run) return "";

  const color = deptColor(run.agentKey);

  return `
    <div class="chat-thread-container">
      <!-- Active Chat Header -->
      <header class="chat-thread-header">
        <button type="button" class="chat-mobile-back" id="chat-back-btn" title="Back to conversations">
          ${icon("arrow-left")}
        </button>

        <div class="chat-thread-avatar" style="background:${color}">
          ${icon(deptMeta(run.agentKey)?.icon || "bot")}
        </div>

        <div class="chat-thread-title-col">
          <div class="chat-thread-meta-row">
            <span class="chat-thread-agent-label">${escapeHtml(deptLabel(run.agentKey))}</span>
            <span class="status-badge ${run.status}">
              ${run.status === "running" ? `<span class="badge-pulse"></span>` : ""}${run.status}
            </span>
            ${run.costUsd != null ? `<span class="chat-thread-cost">${formatCost(run.costUsd)}</span>` : ""}
            <span class="chat-thread-time">Started ${formatDateTime(run.createdAt)}${run.finishedAt ? ` · Finished ${formatDateTime(run.finishedAt)}` : ""}</span>
          </div>
          <h1 class="chat-thread-goal">${escapeHtml(run.goal)}</h1>
        </div>

        <!-- Action Buttons -->
        <div class="chat-thread-actions">
          <button type="button" class="chat-action-btn${run.pinned ? " is-pinned" : ""}" id="chat-thread-pin-btn" title="${run.pinned ? "Unpin conversation" : "Pin conversation"}">
            ${icon("pin")}
          </button>
          <button type="button" class="chat-action-btn" id="chat-thread-copy-btn" title="Copy full transcript">
            ${icon("copy")}
          </button>
          ${
            run.status === "running"
              ? `<button type="button" class="chat-action-btn stop" id="chat-stop-btn" ${state.cancelBusy ? "disabled" : ""}>${icon("square")} <span>${state.cancelBusy ? "Stopping..." : "Stop"}</span></button>`
              : ""
          }
          <button type="button" class="chat-action-btn danger" id="chat-thread-delete-btn" title="Delete conversation">
            ${icon("trash-2")}
          </button>
        </div>
      </header>

      <!-- Chat Log Stream -->
      <div class="chat-log" id="chat-log">
        <!-- Initial User Message -->
        <div class="chat-msg user-msg">
          <span class="chat-msg-avatar user-avatar">${escapeHtml((state.tenant?.name || "U").slice(0, 1).toUpperCase())}</span>
          <div class="chat-msg-body">
            <div class="chat-msg-head">
              <span class="chat-msg-author">You</span>
              <span class="chat-msg-time">${formatClockTime(new Date(run.createdAt))}</span>
            </div>
            <div class="chat-msg-text user-prompt">${escapeHtml(run.goal)}</div>
          </div>
        </div>

        <!-- Events Stream -->
        ${renderChatLog(run)}
      </div>

      <!-- Reply / Follow-up Area -->
      ${
        run.status === "running"
          ? `
          <div class="chat-running-bar">
            <span class="chat-spin-dot"></span>
            <span>Agent is executing steps & running tools…</span>
            <button type="button" class="chat-stop-btn-sm" id="chat-stop-btn">${icon("square")} Stop</button>
          </div>
        `
          : run.sessionId
          ? renderChatReplyForm()
          : `
          <div class="chat-ended-bar">
            <span>Turn completed. To continue or follow up, start a new prompt above or from Home.</span>
          </div>
        `
      }
    </div>
  `;
}

function renderNewChatCanvas() {
  const chosenAgent = state.chatDraftAgent || "ceo";
  const activeDept = chosenAgent === "ceo" ? { label: "CEO Agent", icon: "sparkles", color: { light: "#c25e1a", dark: "#ea7a35" } } : deptMeta(chosenAgent);
  const color = activeDept ? activeDept.color[state.theme] || "var(--accent)" : "var(--accent)";

  return `
    <div class="chat-new-canvas">
      <button type="button" class="chat-mobile-back chat-new-back" id="chat-back-btn" title="Back to conversations">
        ${icon("arrow-left")}
      </button>
      <div class="chat-new-hero">
        <div class="chat-new-emblem" style="--glow-color:${color}">
          <img src="/logo/icon.png" alt="" />
        </div>
        <h2 class="chat-new-title">New Conversation</h2>
        <p class="chat-new-subtitle">
          Delegate directly to a specialist department or have the CEO orchestrate across the entire organization.
        </p>
      </div>

      <!-- Agent Selection Bar -->
      <div class="chat-new-agent-picker">
        <div class="chat-picker-label">Select Recipient:</div>
        <div class="chat-picker-scroll">
          <button type="button" class="chat-agent-pill${chosenAgent === "ceo" ? " active" : ""}" data-select-agent="ceo" style="--pill-color:${state.theme === "dark" ? "#ea7a35" : "#c25e1a"}">
            ${icon("sparkles")} <span>CEO (Orchestrator)</span>
          </button>
          ${state.departments
            .map(
              (d) => `
            <button type="button" class="chat-agent-pill${chosenAgent === d.key ? " active" : ""}" data-select-agent="${d.key}" style="--pill-color:${d.color[state.theme]}">
              ${icon(d.icon || "bot")} <span>${escapeHtml(d.label)}</span>
            </button>
          `,
            )
            .join("")}
        </div>
      </div>

      <!-- Composer Card -->
      <form id="chat-new-form" class="chat-new-composer-card">
        <div class="chat-new-composer-head">
          <span class="chat-new-target-chip" style="background:color-mix(in srgb, ${color} 14%, transparent);color:${color}">
            ${icon(activeDept?.icon || "bot")} Delegating to: <strong>${escapeHtml(activeDept?.label || "CEO")}</strong>
          </span>
          <label class="composer-model-trigger">
            <i data-lucide="cpu"></i>
            <span class="composer-model-label">${state.chatDraftProvider}</span>
            <select id="chat-new-provider">
              ${MODEL_OPTIONS.map((o) => `<option value="${o.value}"${o.value === state.chatDraftProvider ? " selected" : ""}>${o.label}</option>`).join("")}
            </select>
          </label>
        </div>

        <textarea 
          id="chat-new-goal-input" 
          class="chat-new-goal-input" 
          placeholder="Describe your objective, task, or question for ${escapeHtml(activeDept?.label || "the agent")} (Shift+Enter for newline, Enter to send)..." 
          rows="4"
          required
        >${escapeHtml(state.chatDraftGoal)}</textarea>

        <!-- Attachment chips -->
        ${
          state.chatDraftAttachments.length
            ? `
          <div class="attachment-chip-row" style="padding:0 14px 10px">
            ${state.chatDraftAttachments
              .map(
                (a, i) => `
              <span class="attachment-chip">
                ${icon("file-text")}
                <span class="attachment-chip-name">${escapeHtml(a.filename)}</span>
                <button type="button" data-remove-chat-attachment="${i}">${icon("x")}</button>
              </span>
            `,
              )
              .join("")}
          </div>
        `
            : ""
        }

        <div class="chat-new-composer-foot">
          <input type="file" id="chat-new-file-input" multiple style="display:none" />
          <button type="button" class="composer-ctrl-btn composer-ctrl-pill" id="chat-new-attach-btn" title="Add files">
            ${icon("paperclip")} <span>Attach files</span>
          </button>
          <span class="chat-foot-spacer"></span>
          <button type="submit" class="chat-new-submit-btn" ${state.chatSubmitting ? "disabled" : ""}>
            ${state.chatSubmitting ? icon("loader-2") : icon("arrow-up")}
            <span>${state.chatSubmitting ? "Launching..." : "Launch Task"}</span>
          </button>
        </div>
      </form>

      <!-- Quick starter prompt cards -->
      <div class="chat-starters-section">
        <div class="chat-starters-title">Prompt Starters</div>
        <div class="chat-starters-grid">
          <button type="button" class="chat-starter-card" data-chat-starter="roadmap">
            <span class="chat-starter-icon" style="color:#2a78d6">${icon("map")}</span>
            <div class="chat-starter-text">
              <div class="chat-starter-heading">Build Product Roadmap</div>
              <div class="chat-starter-desc">Manager Agent · Break initiatives into Linear tasks</div>
            </div>
          </button>
          <button type="button" class="chat-starter-card" data-chat-starter="competitor">
            <span class="chat-starter-icon" style="color:#eda100">${icon("search")}</span>
            <div class="chat-starter-text">
              <div class="chat-starter-heading">Competitive Analysis</div>
              <div class="chat-starter-desc">Analysis Agent · Research market positioning & report</div>
            </div>
          </button>
          <button type="button" class="chat-starter-card" data-chat-starter="outreach">
            <span class="chat-starter-icon" style="color:#e87ba4">${icon("trending-up")}</span>
            <div class="chat-starter-text">
              <div class="chat-starter-heading">Cold Outreach Campaign</div>
              <div class="chat-starter-desc">Sales & CRM · Personalize copy and stage pipeline</div>
            </div>
          </button>
          <button type="button" class="chat-starter-card" data-chat-starter="seo">
            <span class="chat-starter-icon" style="color:#0891b2">${icon("target")}</span>
            <div class="chat-starter-text">
              <div class="chat-starter-heading">SEO & AEO Audit</div>
              <div class="chat-starter-desc">SEO Agent · Audit keywords & AI engine citations</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderChatHeader(run) {
  return `
    <header class="chat-header">
      <button type="button" class="card-link chat-back" id="chat-back-btn">${icon("chevron-left")} Back</button>
      <div class="chat-header-row">
        <span class="status-badge ${run.status}">${run.status}</span>
        <span class="chat-header-agent">${escapeHtml(deptLabel(run.agentKey))}</span>
        ${run.costUsd != null ? `<span class="chat-header-cost">${formatCost(run.costUsd)}</span>` : ""}
        <span class="chat-header-spacer"></span>
        ${
          run.status === "running"
            ? `<button type="button" class="card-link chat-stop-btn" id="chat-stop-btn" ${state.cancelBusy ? "disabled" : ""}>${icon("square")} ${state.cancelBusy ? "Stopping…" : "Stop"}</button>`
            : ""
        }
      </div>
      <h1 class="chat-goal">${escapeHtml(run.goal)}</h1>
      <p class="chat-subheader">Started ${formatDateTime(run.createdAt)}${run.finishedAt ? ` · Finished ${formatDateTime(run.finishedAt)}` : ""}</p>
    </header>
  `;
}

function renderChatLog(run) {
  const resultsByToolUseId = new Map();
  for (const event of run.events) {
    if (event.type === "tool_result") resultsByToolUseId.set(event.toolUseId, event);
  }
  const parts = [];
  for (const event of run.events) {
    if (event.type === "tool_result") continue; // rendered inline with its tool_use
    if (event.type === "text") parts.push(renderChatTextMsg(event));
    else if (event.type === "tool_use") parts.push(renderChatToolCard(event, resultsByToolUseId.get(event.toolUseId)));
    else if (event.type === "done") parts.push(renderChatTurnDivider(event));
  }
  const body = parts.join("");
  if (!body) return run.status === "running" ? renderChatTyping() : `<div class="card-empty">No activity recorded.</div>`;
  return body + (run.status === "running" ? renderChatTyping() : "");
}

function renderChatTextMsg(event) {
  const color = deptColor(event.source) || "var(--accent)";
  const label = deptLabel(event.source);
  return `
    <div class="chat-msg">
      <span class="chat-msg-avatar" style="background:${color}">${escapeHtml((label || "?").slice(0, 1).toUpperCase())}</span>
      <div class="chat-msg-body">
        <div class="chat-msg-head"><span>${escapeHtml(label)}</span><span class="chat-msg-time">${formatClockTime(new Date(event.ts))}</span></div>
        <div class="chat-msg-text">${renderMarkdown(event.text)}</div>
      </div>
    </div>
  `;
}

function renderChatToolCard(event, result) {
  const isOpen = state.toolOpen.has(event.toolUseId);
  const isError = result?.isError;
  const statusIcon = !result ? "loader-2" : isError ? "alert-circle" : "check-circle-2";
  const statusClass = !result ? "pending" : isError ? "error" : "success";

  // Derive human friendly tool icon and title
  const name = event.name || "tool";
  let toolIcon = "wrench";
  if (name.includes("linear")) toolIcon = "list-checks";
  else if (name.includes("mail") || name.includes("gmail") || name.includes("ses")) toolIcon = "mail";
  else if (name.includes("doc")) toolIcon = "file-text";
  else if (name.includes("search") || name.includes("scrape")) toolIcon = "search";
  else if (name.includes("exec") || name.includes("bash") || name.includes("sandbox")) toolIcon = "terminal";
  else if (name.includes("crm") || name.includes("lead")) toolIcon = "handshake";
  else if (name.includes("schedule") || name.includes("calendar")) toolIcon = "calendar";
  else if (name.includes("memory")) toolIcon = "brain";

  return `
    <div class="chat-msg tool-msg">
      <span class="chat-msg-avatar tool-avatar">${icon(toolIcon)}</span>
      <div class="chat-msg-body">
        <div class="tool-card-v2 ${statusClass}">
          <button type="button" class="tool-card-head" data-toggle-tool="${event.toolUseId}">
            <span class="tool-card-icon-badge">${icon(toolIcon)}</span>
            <div class="tool-card-name-col">
              <span class="tool-card-name">${escapeHtml(name)}</span>
              <span class="tool-card-status-text">${!result ? "Executing tool…" : isError ? "Failed" : "Success"}</span>
            </div>
            <span class="tool-card-status ${statusClass}">${icon(statusIcon)}</span>
            <span class="tool-card-chevron">${icon(isOpen ? "chevron-up" : "chevron-down")}</span>
          </button>
          ${
            isOpen
              ? `
            <div class="tool-card-body">
              <div class="tool-card-section">
                <div class="tool-card-section-head">
                  <span>Input Arguments</span>
                  <button type="button" class="tool-copy-btn" data-copy-json='${escapeHtml(JSON.stringify(event.input || {}))}'>Copy JSON</button>
                </div>
                <pre class="tool-pre">${escapeHtml(JSON.stringify(event.input, null, 2))}</pre>
              </div>
              <div class="tool-card-section" style="margin-top:8px">
                <div class="tool-card-section-head">
                  <span>${isError ? "Error" : "Output Result"}</span>
                  ${result ? `<button type="button" class="tool-copy-btn" data-copy-json='${escapeHtml(result.text || "")}'>Copy</button>` : ""}
                </div>
                ${
                  result
                    ? `<pre class="tool-pre">${escapeHtml(truncate(result.text, 3000))}</pre>`
                    : `<div class="tool-card-waiting"><span class="chat-spin-dot"></span> Awaiting tool result…</div>`
                }
              </div>
            </div>
          `
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

function renderChatTurnDivider(event) {
  return `
    <div class="turn-divider">
      <span>${event.status === "success" ? "Turn complete" : `Turn failed: ${escapeHtml(event.error || "unknown error")}`}</span>
      <span>${formatCost(event.costUsd)} · ${formatClockTime(new Date(event.ts))}</span>
    </div>
  `;
}

function renderChatTyping() {
  return `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
}

function renderChatReplyForm() {
  return `
    <form id="chat-reply-form" class="reply-form">
      <textarea id="chat-reply-input" placeholder="Reply to continue this conversation (Shift+Enter for newline, Enter to send)…" rows="1" required ${state.replyBusy ? "disabled" : ""}>${escapeHtml(state.chatReplyDraft)}</textarea>
      <button type="submit" class="reply-submit" aria-label="Send reply" ${state.replyBusy ? "disabled" : ""}>
        ${state.replyBusy ? icon("loader-2") : icon("corner-down-left")}
      </button>
    </form>
  `;
}

// Conversation Management Actions
async function togglePinRun(id) {
  const r = state.runs.find((x) => x.id === id);
  if (!r) return;
  state.chatMenuOpenRunId = null;
  const isPinned = Boolean(r.pinned);
  const url = isPinned ? `/api/runs/${id}/unpin` : `/api/runs/${id}/pin`;
  try {
    await fetchJSON(url, { method: "POST" });
    r.pinned = !isPinned;
    showToast(r.pinned ? "Conversation pinned" : "Conversation unpinned");
    await loadAll(true);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

async function archiveRunAction(id) {
  state.chatMenuOpenRunId = null;
  try {
    await fetchJSON(`/api/runs/${id}/archive`, { method: "POST" });
    showToast("Conversation archived");
    if (state.openRunId === id) {
      closeRunEventSource();
      state.openRunId = null;
      state.openRun = null;
    }
    await loadAll(true);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

async function deleteRunAction(id) {
  state.chatMenuOpenRunId = null;
  openConfirmModal({
    title: "Delete Conversation",
    message: "Are you sure you want to delete this conversation? This will permanently remove its transcript and history.",
    confirmLabel: "Delete Permanently",
    danger: true,
    onConfirm: async () => {
      try {
        await fetchJSON(`/api/runs/${id}`, { method: "DELETE" });
        showToast("Conversation deleted");
        if (state.openRunId === id) {
          closeRunEventSource();
          state.openRunId = null;
          state.openRun = null;
        }
        await loadAll(true);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      }
    },
  });
}

function copyTranscript(run) {
  if (!run) return;
  state.chatMenuOpenRunId = null;
  const lines = [
    `# Conversation: ${run.goal}`,
    `Agent: ${deptLabel(run.agentKey)} | Status: ${run.status} | Created: ${formatDateTime(run.createdAt)}`,
    run.costUsd != null ? `Cost: ${formatCost(run.costUsd)}` : null,
    "",
    "--- Transcript ---",
    "",
    `[You]: ${run.goal}`,
    "",
  ].filter((l) => l !== null);

  for (const ev of run.events || []) {
    if (ev.type === "text") {
      lines.push(`[${deptLabel(ev.source)}]:\n${ev.text}\n`);
    } else if (ev.type === "tool_use") {
      lines.push(`[Tool Call: ${ev.name}]:\nInput: ${JSON.stringify(ev.input, null, 2)}\n`);
    } else if (ev.type === "tool_result") {
      lines.push(`[Tool Result]:\n${ev.text}\n`);
    }
  }

  navigator.clipboard.writeText(lines.join("\n")).then(
    () => showToast("Transcript copied to clipboard!"),
    () => showToast("Failed to copy transcript"),
  );
}

async function submitChatGoal(goal, agentKey = "ceo", provider = "auto", attachments = []) {
  if (!goal.trim()) return;
  state.chatSubmitting = true;
  render();
  const url = agentKey && agentKey !== "ceo" ? `/api/agents/${agentKey}/runs` : "/api/runs";
  try {
    const result = await fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, provider, attachments }),
    });
    state.chatDraftGoal = "";
    state.chatDraftAttachments = [];
    await loadAll(true);
    if (result?.id) {
      openRun(result.id);
    } else {
      showToast("Task started.");
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
  state.chatSubmitting = false;
  render();
}

async function uploadChatAttachments(files) {
  state.chatDraftUploading = true;
  render();
  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Upload failed (${res.status})`);
      const data = await res.json();
      state.chatDraftAttachments.push({ filename: data.filename, text: data.text, truncated: Boolean(data.truncated), path: data.path });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }
  state.chatDraftUploading = false;
  render();
}


// ---------- actions ----------

// ---------- generic modal ----------

// `renderer` is a () => htmlString, re-invoked on every render() so the
// modal's content stays current (e.g. a dirty/saving state) without each
// module needing its own overlay plumbing.
function openModal(renderer) {
  state.modal = renderer;
  render();
}

function closeModal() {
  state.modal = null;
  modalAttach = null;
  render();
}

// Set by whichever openXModal() is currently showing — attachHandlers()
// calls this unconditionally after every render() (same as VIEW_ATTACHERS),
// so a modal's own element bindings (inputs, save/cancel buttons) stay live
// across re-renders without each modal needing its own registry slot.
let modalAttach = null;

function renderModalOverlay() {
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-card" id="modal-card">${state.modal()}</div>
    </div>
  `;
}

function showToast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- voice input ----------
//
// Browser speech-to-text (Web Speech API — Chrome/Edge/Safari). The
// recognition object lives at module level, not in the DOM, so it survives
// render() swapping out the composer. Dictated text is appended after
// whatever was already in the draft when the mic was turned on.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecognition = null;

function setComposerText(text) {
  state.composerDraft = text;
  const input = document.getElementById("composer-input");
  if (!input) return;
  input.value = text;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  input.setSelectionRange(text.length, text.length);
  input.scrollTop = input.scrollHeight;
}

function startVoiceInput() {
  if (!SpeechRecognitionCtor || voiceRecognition) return;
  const rec = new SpeechRecognitionCtor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  const baseText = state.composerDraft;
  const sep = baseText && !/\s$/.test(baseText) ? " " : "";
  let finalText = "";

  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    const spoken = (finalText + interim).trim();
    setComposerText(spoken ? baseText + sep + spoken : baseText);
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      showToast("Microphone access was blocked — allow it in the browser's site settings.");
    } else if (e.error === "audio-capture") {
      showToast("No microphone found.");
    } else if (e.error === "network") {
      showToast("Voice input needs an internet connection.");
    }
    // "no-speech" / "aborted" are normal ends — nothing to report.
  };
  rec.onend = () => {
    if (voiceRecognition !== rec) return;
    voiceRecognition = null;
    state.voiceListening = false;
    render();
  };

  voiceRecognition = rec;
  state.voiceListening = true;
  try {
    rec.start();
  } catch {
    voiceRecognition = null;
    state.voiceListening = false;
  }
  render();
  document.getElementById("composer-input")?.focus();
}

function stopVoiceInput({ discardPending = false } = {}) {
  if (!voiceRecognition) return;
  if (discardPending) voiceRecognition.abort();
  else voiceRecognition.stop(); // onend flips state + re-renders once the last result lands
}

function switchView(view) {
  closeRunEventSource();
  state.openRunId = null;
  state.openRun = null;
  state.view = view;
  state.sidebarOpen = false;
  state.userMenuOpen = false;
  state.chatMenuOpenRunId = null;
  state.agentDrawerKey = null;
  if (view === "settings" && !state.settingsFields && !state.settingsLoading) loadSettings();
  if (view === "agents" && typeof loadToolsCatalog === "function") loadToolsCatalog(false);
  LAZY_LOADERS[view]?.();
  render();
}

// ---------- Chat / run-detail ----------

function closeRunEventSource() {
  if (runEventSource) {
    runEventSource.close();
    runEventSource = null;
  }
}

function openRun(id) {
  closeRunEventSource();
  state.view = "chat";
  state.sidebarOpen = false;
  state.openRunId = id;
  state.openRun = null;
  state.openRunLoading = true;
  state.openRunError = null;
  state.toolOpen = new Set();
  render();
  loadOpenRun(id);
}

async function loadOpenRun(id) {
  try {
    const run = await fetchJSON(`/api/runs/${id}`);
    if (state.openRunId !== id) return; // user navigated away before this resolved
    state.openRun = run;
    state.openRunLoading = false;
    render();
    scrollChatLogToBottom();
    streamOpenRun(id);
  } catch (err) {
    if (state.openRunId !== id) return;
    state.openRunError = err instanceof Error ? err.message : String(err);
    state.openRunLoading = false;
    render();
  }
}

function streamOpenRun(id) {
  closeRunEventSource();
  // The GET above already has every event recorded so far — replay=0 so the
  // stream only adds what happens *after* this point.
  runEventSource = new EventSource(`/api/runs/${id}/stream?replay=0`);
  runEventSource.onmessage = (msg) => handleRunStreamEvent(id, JSON.parse(msg.data));
  runEventSource.onerror = () => closeRunEventSource();
}

function handleRunStreamEvent(id, event) {
  if (state.openRunId !== id || !state.openRun) return;
  if (event.type === "run_finished") {
    state.openRun.status = event.status;
    state.openRun.costUsd = event.costUsd;
    state.openRun.summary = event.summary;
    state.openRun.linearTasks = event.linearTasks;
    state.openRun.sessionId = event.sessionId ?? state.openRun.sessionId;
    loadAll(true);
  } else {
    state.openRun.events.push(event);
  }
  render();
  scrollChatLogToBottom();
}

async function sendReply(id, message) {
  state.replyBusy = true;
  render();
  try {
    await fetchJSON(`/api/runs/${id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    closeRunEventSource();
    const run = await fetchJSON(`/api/runs/${id}`);
    if (state.openRunId !== id) return;
    state.openRun = run;
    state.replyBusy = false;
    render();
    scrollChatLogToBottom();
    streamOpenRun(id);
  } catch (err) {
    state.openRunError = err instanceof Error ? err.message : String(err);
    state.replyBusy = false;
    render();
  }
}

// ---------- Settings ----------

const DEFAULT_SETTINGS_PREVIEW = [
  { group: "AI Models & Providers", label: "OpenAI API Key", envVar: "OPENAI_API_KEY", isSet: true, masked: "sk-••••••••4f29" },
  { group: "AI Models & Providers", label: "Anthropic API Key", envVar: "ANTHROPIC_API_KEY", isSet: true, masked: "sk-ant-•••••••9a11" },
  { group: "AI Models & Providers", label: "Google Gemini API Key", envVar: "GEMINI_API_KEY", isSet: false, masked: "" },
  { group: "Integrations & Tools", label: "GitHub Access Token", envVar: "GITHUB_TOKEN", isSet: true, masked: "ghp_••••••••88cb" },
  { group: "Integrations & Tools", label: "Stripe Secret Key", envVar: "STRIPE_SECRET_KEY", isSet: false, masked: "" },
  { group: "Integrations & Tools", label: "Slack Bot User OAuth Token", envVar: "SLACK_BOT_TOKEN", isSet: true, masked: "xoxb-••••••••2311" },
  { group: "Database & Storage", label: "Supabase Service Role Key", envVar: "SUPABASE_SERVICE_ROLE_KEY", isSet: true, masked: "eyJhbGci••••••••" },
];

async function loadSettings() {
  state.settingsLoading = true;
  state.settingsError = null;
  render();
  try {
    state.settingsFields = await fetchJSON("/api/settings");
  } catch (err) {
    if (String(err).includes("Not signed in") || String(err).includes("401")) {
      state.settingsFields = DEFAULT_SETTINGS_PREVIEW;
      state.settingsError = null;
    } else {
      state.settingsError = err instanceof Error ? err.message : String(err);
    }
  }
  state.settingsLoading = false;
  render();
}

async function saveSettings() {
  const body = {};
  for (const [k, v] of Object.entries(state.settingsEdits)) {
    if (v.trim()) body[k] = v.trim();
  }
  if (!Object.keys(body).length) return;
  state.settingsSaving = true;
  render();
  try {
    state.settingsFields = await fetchJSON("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.settingsEdits = {};
    state.settingsSavedAt = Date.now();
    showToast("Settings saved.");
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
  state.settingsSaving = false;
  render();
}

async function cancelOpenRun(id) {
  state.cancelBusy = true;
  render();
  try {
    await fetchJSON(`/api/runs/${id}/cancel`, { method: "POST" });
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
  state.cancelBusy = false;
  render();
}

// Called explicitly after events that actually add new log content (initial
// open, a streamed event, a reply) — not from the generic render() path,
// which also fires on the unrelated 10s dashboard poll and would otherwise
// yank the log back to the bottom even when nothing in it changed.
function scrollChatLogToBottom() {
  const log = document.getElementById("chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function toggleToolCard(toolUseId) {
  if (state.toolOpen.has(toolUseId)) state.toolOpen.delete(toolUseId);
  else state.toolOpen.add(toolUseId);
  render();
}

async function submitGoal(goal) {
  state.composerBusy = true;
  state.composerError = null;
  render();
  const targetAgent = state.composerTargetAgent;
  const url = targetAgent ? `/api/agents/${targetAgent}/runs` : "/api/runs";
  try {
    const result = await fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, provider: state.composerProvider, attachments: state.composerAttachments }),
    });
    state.composerDraft = "";
    state.composerAttachments = [];
    state.composerTargetAgent = null;
    await loadAll(true);
    if (result?.id) openRun(result.id);
    else showToast("Task started.");
  } catch (err) {
    state.composerError = err instanceof Error ? err.message : String(err);
  }
  state.composerBusy = false;
  render();
}

async function uploadAttachments(files) {
  state.composerUploading = true;
  render();
  for (const file of files) {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Upload failed (${res.status})`);
      const data = await res.json();
      state.composerAttachments.push({ filename: data.filename, text: data.text, truncated: Boolean(data.truncated), path: data.path });
    } catch (err) {
      state.composerError = err instanceof Error ? err.message : String(err);
    }
  }
  state.composerUploading = false;
  render();
}

function markNotifsRead() {
  state.notifLastSeen = Date.now();
  localStorage.setItem(NOTIF_SEEN_KEY, String(state.notifLastSeen));
  render();
}

// Shared by the orbit cards, suggestion chips and Quick Tools grid — each
// just seeds the composer with a starting prompt and (optionally) routes it
// straight to one department instead of the CEO.
function fillComposerAndFocus(prompt, targetAgent = null) {
  state.composerDraft = prompt;
  state.composerTargetAgent = targetAgent;
  render();
  const input = document.getElementById("composer-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ---------- handlers ----------

let flurryTrackingBound = false;

function initFlurryBotInteraction() {
  const bot = document.getElementById("flurry-bot");
  if (!bot) return;

  bot.onclick = () => {
    bot.classList.add("is-winking");
    setTimeout(() => bot.classList.remove("is-winking"), 650);
  };

  if (flurryTrackingBound) return;
  flurryTrackingBound = true;

  window.addEventListener("pointermove", (e) => {
    const curBot = document.getElementById("flurry-bot");
    if (!curBot) return;

    const rect = curBot.getBoundingClientRect();
    const botCenterX = rect.left + rect.width * 0.5;
    const botCenterY = rect.top + rect.height * 0.5;

    const dx = e.clientX - botCenterX;
    const dy = e.clientY - botCenterY;
    const dist = Math.hypot(dx, dy);

    // Activated on hover or proximity (< 360px)
    const isOver = curBot.matches(":hover") || dist < 360;

    if (isOver) {
      curBot.setAttribute("data-mood", "active");
      const angle = Math.atan2(dy, dx);
      const distRatio = Math.min(1.0, Math.max(0.18, dist / 220));
      const eyeX = Math.cos(angle) * 14 * distRatio;
      const eyeY = Math.sin(angle) * 11 * distRatio;

      const tiltX = Math.max(-14, Math.min(14, -dy * 0.05));
      const tiltY = Math.max(-16, Math.min(16, dx * 0.05));

      curBot.style.setProperty("--eye-x", `${eyeX.toFixed(1)}px`);
      curBot.style.setProperty("--eye-y", `${eyeY.toFixed(1)}px`);
      curBot.style.setProperty("--bot-tilt-x", `${tiltX.toFixed(1)}deg`);
      curBot.style.setProperty("--bot-tilt-y", `${tiltY.toFixed(1)}deg`);
    } else {
      if (curBot.getAttribute("data-mood") === "active") {
        curBot.setAttribute("data-mood", "idle");
        curBot.style.removeProperty("--eye-x");
        curBot.style.removeProperty("--eye-y");
        curBot.style.removeProperty("--bot-tilt-x");
        curBot.style.removeProperty("--bot-tilt-y");
      }
    }
  }, { passive: true });
}

function attachHandlers() {
  const botEngine = window.MetallicBot || window.FluffyBot;
  if (botEngine) {
    const slot = document.getElementById("metallic-bot-slot") || document.getElementById("fluffy-bot-slot");
    if (slot) botEngine.mount(slot);
  }
  if (window.Orbit3D) {
    window.Orbit3D.sync();
  }
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.nav));
  });

  document.getElementById("sidebar-toggle")?.addEventListener("click", () => {
    state.sidebarOpen = !state.sidebarOpen;
    render();
  });
  document.getElementById("sidebar-collapse-toggle")?.addEventListener("click", () => {
    if (window.innerWidth <= 880) {
      state.sidebarOpen = false;
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    }
    render();
  });

  // Swipe left on sidebar to dismiss drawer on touch devices
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarEl && window.innerWidth <= 880) {
    let touchStartX = 0;
    let touchStartY = 0;
    sidebarEl.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    sidebarEl.addEventListener("touchend", (e) => {
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const deltaY = e.changedTouches[0].clientY - touchStartY;
      if (deltaX < -45 && Math.abs(deltaY) < 100) {
        state.sidebarOpen = false;
        render();
      }
    }, { passive: true });
  }
  document.getElementById("sidebar-brand-mark")?.addEventListener("click", () => {
    if (state.sidebarCollapsed) {
      state.sidebarCollapsed = false;
      render();
    }
  });
  document.getElementById("sidebar-backdrop")?.addEventListener("click", () => {
    state.sidebarOpen = false;
    render();
  });

  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  document.getElementById("right-bar-toggle")?.addEventListener("click", () => {
    state.rightBarOpen = !state.rightBarOpen;
    render();
  });

  document.getElementById("sidebar-user-menu-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    state.userMenuOpen = !state.userMenuOpen;
    render();
  });
  document.getElementById("logout-btn")?.addEventListener("click", logout);
  document.getElementById("ui-theme-switch")?.addEventListener("click", () => switchUiTheme("ceounik"));

  document.getElementById("topbar-search-toggle")?.addEventListener("click", () => {
    state.searchFocused = true;
    state.notifsOpen = false;
    render();
    document.getElementById("topbar-search-input")?.focus();
  });

  const searchInput = document.getElementById("topbar-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      render();
      document.getElementById("topbar-search-input")?.focus();
      const v = document.getElementById("topbar-search-input");
      if (v) v.setSelectionRange(v.value.length, v.value.length);
    });
    searchInput.addEventListener("focus", () => {
      state.searchFocused = true;
      state.notifsOpen = false;
      render();
      document.getElementById("topbar-search-input")?.focus();
    });
  }

  document.querySelectorAll("[data-open-run]").forEach((btn) => {
    btn.addEventListener("click", () => openRun(btn.dataset.openRun));
  });
  document.querySelectorAll("[data-open-doc]").forEach((btn) => {
    btn.addEventListener("click", () => window.open(`/api/documents/${btn.dataset.openDoc}/download`, "_blank", "noopener"));
  });

  document.querySelectorAll("[data-settings-field]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const fieldKey = input.dataset.settingsField;
      const cursor = e.target.selectionStart;
      state.settingsEdits[fieldKey] = e.target.value;
      render(); // re-rendered (not just state-tracked) so the save-bar's dirty count stays live as you type
      const el = document.querySelector(`[data-settings-field="${fieldKey}"]`);
      if (el) {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      }
    });
  });
  document.getElementById("settings-save-btn")?.addEventListener("click", saveSettings);
  document.getElementById("analytics-connect-btn")?.addEventListener("click", () => switchView("accounts"));

  // Chat navigation & thread actions
  document.querySelectorAll("#chat-back-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeRunEventSource();
      state.openRunId = null;
      state.openRun = null;
      state.chatMobileNew = false;
      render();
    });
  });

  document.querySelectorAll("[data-chat-list-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chatListCollapsed = !state.chatListCollapsed;
      try { localStorage.setItem("chatListCollapsed", state.chatListCollapsed ? "1" : "0"); } catch {}
      render();
    });
  });
  document.getElementById("chat-new-rail-btn")?.addEventListener("click", () => {
    document.getElementById("chat-new-btn")?.click();
  });
  document.getElementById("chat-new-btn")?.addEventListener("click", () => {
    closeRunEventSource();
    state.openRunId = null;
    state.openRun = null;
    state.chatDraftGoal = "";
    state.chatDraftAttachments = [];
    state.chatMobileNew = true;
    render();
    document.getElementById("chat-new-goal-input")?.focus();
  });

  const chatSearchInput = document.getElementById("chat-search-input");
  if (chatSearchInput) {
    chatSearchInput.addEventListener("input", (e) => {
      state.chatSearchQuery = e.target.value;
      const selStart = e.target.selectionStart;
      render();
      const reEl = document.getElementById("chat-search-input");
      if (reEl) {
        reEl.focus();
        reEl.setSelectionRange(selStart, selStart);
      }
    });
  }
  document.getElementById("chat-search-clear")?.addEventListener("click", () => {
    state.chatSearchQuery = "";
    render();
  });

  document.querySelectorAll("[data-chat-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chatFilterStatus = btn.dataset.chatStatus;
      render();
    });
  });

  // Tasks search & filters
  const taskSearchInput = document.getElementById("task-search-input");
  if (taskSearchInput) {
    taskSearchInput.addEventListener("input", (e) => {
      state.taskSearchQuery = e.target.value;
      const selStart = e.target.selectionStart;
      render();
      const reEl = document.getElementById("task-search-input");
      if (reEl) {
        reEl.focus();
        reEl.setSelectionRange(selStart, selStart);
      }
    });
  }
  document.getElementById("task-search-clear")?.addEventListener("click", () => {
    state.taskSearchQuery = "";
    render();
  });
  document.querySelectorAll("[data-task-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.taskFilterStatus = btn.dataset.taskStatus;
      render();
    });
  });

  document.getElementById("chat-filter-agent")?.addEventListener("change", (e) => {
    state.chatFilterAgent = e.target.value;
    render();
  });

  // Conversation 3-dots menus & item actions
  document.querySelectorAll("[data-conv-menu]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const runId = btn.dataset.convMenu;
      state.chatMenuOpenRunId = state.chatMenuOpenRunId === runId ? null : runId;
      render();
    });
  });
  document.querySelectorAll("[data-action-pin]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePinRun(btn.dataset.actionPin);
    });
  });
  document.querySelectorAll("[data-action-archive]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      archiveRunAction(btn.dataset.actionArchive);
    });
  });
  document.querySelectorAll("[data-action-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteRunAction(btn.dataset.actionDelete);
    });
  });
  document.querySelectorAll("[data-action-copy-transcript]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = state.runs.find((x) => x.id === btn.dataset.actionCopyTranscript);
      if (r) copyTranscript(r);
    });
  });

  // Active chat thread actions
  document.getElementById("chat-thread-pin-btn")?.addEventListener("click", () => {
    if (state.openRunId) togglePinRun(state.openRunId);
  });
  document.getElementById("chat-thread-copy-btn")?.addEventListener("click", () => {
    if (state.openRun) copyTranscript(state.openRun);
  });
  document.getElementById("chat-thread-delete-btn")?.addEventListener("click", () => {
    if (state.openRunId) deleteRunAction(state.openRunId);
  });
  document.querySelectorAll("#chat-stop-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.openRunId) cancelOpenRun(state.openRunId);
    });
  });

  // New Chat Studio controls
  document.querySelectorAll("[data-select-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chatDraftAgent = btn.dataset.selectAgent;
      render();
    });
  });
  document.getElementById("chat-new-provider")?.addEventListener("change", (e) => {
    state.chatDraftProvider = e.target.value;
  });
  const chatNewInput = document.getElementById("chat-new-goal-input");
  chatNewInput?.addEventListener("input", (e) => {
    state.chatDraftGoal = e.target.value;
  });
  chatNewInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("chat-new-form")?.requestSubmit();
    }
  });
  document.getElementById("chat-new-attach-btn")?.addEventListener("click", () => {
    document.getElementById("chat-new-file-input")?.click();
  });
  document.getElementById("chat-new-file-input")?.addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    if (files.length) uploadChatAttachments(files);
  });
  document.querySelectorAll("[data-remove-chat-attachment]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chatDraftAttachments.splice(Number(btn.dataset.removeChatAttachment), 1);
      render();
    });
  });
  document.getElementById("chat-new-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-new-goal-input");
    const goal = (input?.value || "").trim();
    if (!goal || state.chatSubmitting) return;
    submitChatGoal(goal, state.chatDraftAgent || "ceo", state.chatDraftProvider || "auto", state.chatDraftAttachments || []);
  });
  document.querySelectorAll("[data-chat-starter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const starterKey = btn.dataset.chatStarter;
      const starters = {
        roadmap: { prompt: "Create a detailed product roadmap for our upcoming release and break it into Linear milestones and user stories.", agent: "manager" },
        competitor: { prompt: "Conduct deep competitive analysis in our product niche, identifying our distinct moats, weaknesses, and key market differentiators.", agent: "analysis" },
        outreach: { prompt: "Draft a personalized high-converting cold outreach sequence for B2B prospects and recommend qualifying criteria.", agent: "sales" },
        seo: { prompt: "Perform keyword research and formulate an SEO & AEO content optimization strategy to gain visibility on Google and Perplexity.", agent: "seo" },
      };
      const chosen = starters[starterKey];
      if (chosen) {
        state.chatDraftGoal = chosen.prompt;
        state.chatDraftAgent = chosen.agent;
        render();
        const inputEl = document.getElementById("chat-new-goal-input");
        if (inputEl) {
          inputEl.focus();
          inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        }
      }
    });
  });

  // Reply form in chat thread
  document.getElementById("chat-reply-input")?.addEventListener("input", (e) => {
    state.chatReplyDraft = e.target.value;
  });
  document.getElementById("chat-reply-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("chat-reply-form")?.requestSubmit();
    }
  });
  document.getElementById("chat-reply-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-reply-input");
    const message = (input?.value || "").trim();
    if (!message || state.replyBusy || !state.openRunId) return;
    state.chatReplyDraft = "";
    sendReply(state.openRunId, message);
  });

  document.querySelectorAll("[data-toggle-tool]").forEach((btn) => {
    btn.addEventListener("click", () => toggleToolCard(btn.dataset.toggleTool));
  });

  // Agents page controls
  const agentSearchInput = document.getElementById("agent-search-input");
  if (agentSearchInput) {
    agentSearchInput.addEventListener("input", (e) => {
      state.agentSearchQuery = e.target.value;
      const selStart = e.target.selectionStart;
      render();
      const reEl = document.getElementById("agent-search-input");
      if (reEl) {
        reEl.focus();
        reEl.setSelectionRange(selStart, selStart);
      }
    });
  }
  document.getElementById("agent-search-clear")?.addEventListener("click", () => {
    state.agentSearchQuery = "";
    render();
  });
  document.getElementById("agent-reset-search-btn")?.addEventListener("click", () => {
    state.agentSearchQuery = "";
    state.agentFilterCategory = "all";
    render();
  });
  document.querySelectorAll("[data-agent-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.agentFilterCategory = btn.dataset.agentCat;
      render();
    });
  });
  document.querySelectorAll("[data-chat-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const agentKey = btn.dataset.chatAgent;
      state.chatDraftAgent = agentKey;
      state.openRunId = null;
      state.openRun = null;
      switchView("chat");
    });
  });
  document.querySelectorAll("[data-inspect-agent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.agentDrawerKey = btn.dataset.inspectAgent;
      state.agentDrawerTab = "overview";
      render();
    });
  });
  document.getElementById("agent-drawer-close-btn")?.addEventListener("click", () => {
    state.agentDrawerKey = null;
    render();
  });
  document.getElementById("agent-drawer-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "agent-drawer-backdrop") {
      state.agentDrawerKey = null;
      render();
    }
  });
  document.querySelectorAll("[data-drawer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.agentDrawerTab = btn.dataset.drawerTab;
      render();
    });
  });
  document.getElementById("agent-drawer-input")?.addEventListener("input", (e) => {
    state.agentDrawerDraft = e.target.value;
  });
  document.getElementById("agent-drawer-provider")?.addEventListener("change", (e) => {
    state.agentDrawerProvider = e.target.value;
  });
  document.getElementById("agent-drawer-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("agent-drawer-input");
    const goal = (input?.value || "").trim();
    if (!goal || state.agentDrawerSubmitting || !state.agentDrawerKey) return;
    submitAgentDrawerGoal(state.agentDrawerKey, goal, state.agentDrawerProvider);
  });

  // Code & JSON copy buttons
  document.querySelectorAll(".code-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rawCode = btn.closest(".code-block-wrapper")?.querySelector("code")?.textContent || "";
      navigator.clipboard.writeText(rawCode).then(() => {
        btn.innerHTML = `${icon("check")} <span>Copied!</span>`;
        if (window.lucide) window.lucide.createIcons();
        setTimeout(() => {
          btn.innerHTML = `${icon("copy")} <span>Copy</span>`;
          if (window.lucide) window.lucide.createIcons();
        }, 2000);
      });
    });
  });
  document.querySelectorAll("[data-copy-json]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const raw = btn.dataset.copyJson || "";
      navigator.clipboard.writeText(raw).then(() => {
        const old = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = old; }, 2000);
      });
    });
  });


  document.getElementById("notif-toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    state.notifsOpen = !state.notifsOpen;
    state.searchFocused = false;
    render();
  });
  document.getElementById("notifs-mark-read")?.addEventListener("click", markNotifsRead);

  const composerInput = document.getElementById("composer-input");
  composerInput?.addEventListener("input", (e) => {
    state.composerDraft = e.target.value; // tracked so background-poll re-renders don't wipe it; deliberately no render() here (would cost focus/cursor position on every keystroke)
    // Typing while dictating: hand control back to the keyboard rather than
    // letting the next speech result overwrite the edit.
    if (voiceRecognition) stopVoiceInput({ discardPending: true });
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  });
  if (composerInput) {
    composerInput.style.height = "auto";
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 120)}px`;
  }
  composerInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("composer-form")?.requestSubmit();
    }
  });

  document.querySelectorAll("[data-quick-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = QUICK_ACTIONS.find((a) => a.key === btn.dataset.quickAction);
      if (action) fillComposerAndFocus(action.prompt, QUICK_ACTION_TARGETS[action.key] ?? null);
    });
  });
  document.querySelectorAll("[data-suggestion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const chip = SUGGESTION_CHIPS.find((c) => c.key === btn.dataset.suggestion);
      if (chip) fillComposerAndFocus(chip.prompt);
    });
  });
  document.getElementById("suggestion-more")?.addEventListener("click", () => {
    document.getElementById("composer-input")?.focus();
  });
  document.querySelectorAll("[data-quick-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = QUICK_TOOLS.find((t) => t.key === btn.dataset.quickTool);
      if (!tool?.prompt) return;
      // Quick Tools now lives in the sidebar (visible on every view), but
      // the composer it fills only exists on Home — switch there first if
      // we're not already on it, or the draft would be set on state with
      // nothing visible to show for it.
      if (state.view !== "home") {
        switchView("home");
      } else if (window.innerWidth <= 880) {
        state.sidebarOpen = false;
        render();
      }
      fillComposerAndFocus(tool.prompt);
    });
  });
  document.getElementById("promo-focus-btn")?.addEventListener("click", () => {
    const input = document.getElementById("composer-input");
    input?.scrollIntoView({ behavior: "smooth", block: "center" });
    input?.focus();
  });
  document.getElementById("composer-target-clear")?.addEventListener("click", () => {
    state.composerTargetAgent = null;
    render();
  });

  document.getElementById("composer-mic-btn")?.addEventListener("click", () => {
    if (voiceRecognition) stopVoiceInput();
    else startVoiceInput();
  });

  document.getElementById("composer-attach-btn")?.addEventListener("click", () => {
    document.getElementById("composer-file-input")?.click();
  });
  document.getElementById("composer-file-input")?.addEventListener("change", (e) => {
    const files = [...(e.target.files || [])];
    if (files.length) uploadAttachments(files);
  });
  document.querySelectorAll("[data-remove-attachment]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.composerAttachments.splice(Number(btn.dataset.removeAttachment), 1);
      render();
    });
  });

  const providerSelect = document.getElementById("composer-provider");
  providerSelect?.addEventListener("change", (e) => {
    state.composerProvider = e.target.value;
  });

  const form = document.getElementById("composer-form");
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("composer-input");
    const goal = (input?.value || "").trim();
    if (!goal || state.composerBusy) return;
    stopVoiceInput({ discardPending: true });
    submitGoal(goal);
  });

  document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.getElementById("modal-card")?.addEventListener("click", (e) => e.stopPropagation());
  modalAttach?.();

  for (const attach of VIEW_ATTACHERS) attach();
}

// Closes search results / notifications when clicking elsewhere. Attached
// once at init (not inside attachHandlers(), which reruns on every render —
// including the background poll's — since a plain addEventListener there
// would stack up a fresh listener each time instead of replacing one).
function attachOutsideClickHandler() {
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".topbar-search") && state.searchFocused) {
      state.searchFocused = false;
      render();
    }
    if (!e.target.closest(".topbar-notifs") && !e.target.closest("#notif-toggle") && state.notifsOpen) {
      state.notifsOpen = false;
      render();
    }
    if (!e.target.closest(".sidebar-user") && state.userMenuOpen) {
      state.userMenuOpen = false;
      render();
    }
  });
}

function attachGlobalKeyboardShortcut() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.view !== "home") {
        state.view = "home";
        render();
      }
      document.getElementById("topbar-search-input")?.focus();
    }
  });
}

// ---------- init ----------

initTheme();
attachOutsideClickHandler();
attachGlobalKeyboardShortcut();
loadAll();
setInterval(() => loadAll(true), POLL_MS);
setInterval(() => {
  if (!state.loading) render();
}, 60000); // keep the topbar clock honest even with no other state change
