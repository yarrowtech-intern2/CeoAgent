import "dotenv/config";
import express from "express";
import { z } from "zod";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import ExcelJS from "exceljs";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSettingsIntoEnv, getMaskedSettings, updateSettings, getEnvValue } from "./settings.js";
import {
  clearSessionCookie,
  completeErpSignIn,
  createOAuthStateToken,
  findTenantByErpOrgId,
  findTenantByOrganizationId,
  getPublicAuthConfig,
  isSupabaseAuthConfigured,
  readRequestTenant,
  requireAuth,
  requireAutomationTenant,
  restoreTenant,
  resolveAuthFlowTenant,
  setErpSessionCookie,
  setSessionCookie,
  verifyErpHandoff,
  getUiTheme,
  setUiTheme,
  UI_THEMES,
  type UiTheme,
} from "./auth.js";
import { getBaseDir, getTenantContext, runWithTenant } from "../paths.js";
import { DEPARTMENTS, buildAgentsRegistry } from "../agents.js";
import { listDocuments, getDocument } from "../tools/documents.js";
import { parseAttachment } from "../tools/attachments.js";
import { resolveVirtualPath, saveUpload } from "./files.js";
import { promises as fsPromises } from "node:fs";
import { getAnalytics } from "./analytics.js";
import { listSentEmails, type SentEmailQuery } from "../sentEmails.js";
import { getExternalAnalytics, getExternalAnalyticsDashboard, isExternalAnalyticsConfigured } from "./externalAnalytics.js";
import { runCeoAgentWithFallback, runSpecialistAgentWithFallback, isValidProviderChoice, type LlmProviderChoice } from "../providers/llmFallback.js";
import { mountCodexMcpBridge } from "../providers/codexToolBridge.js";
import { LimitExceededError, readAuditLog, getDailyUsage, limits as guardrailLimits } from "../guardrails.js";
import { initStorage, closeStorage } from "../storage.js";
import { enforceRunLimits, startCeoRun as runRunnerStartCeoRun, startSpecialistRun as runRunnerStartSpecialistRun, startRun } from "./runRunner.js";
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  initScheduler,
  type Recurrence,
} from "../scheduler.js";
import {
  createLead,
  listLeads,
  updateLead,
  addLeadActivity,
  deleteLead,
  LEAD_STAGES,
  type LeadStage,
} from "../crm.js";
import {
  listPlaybookItems,
  updatePlaybookItem,
  deletePlaybookItem,
  PLAYBOOK_TABS,
  PLAYBOOK_ITEM_TYPES,
  type PlaybookTab,
  type PlaybookItemType,
} from "../playbook.js";
import {
  createProject as createPortfolioProject,
  listProjects as listPortfolioProjects,
  renameProject as renamePortfolioProject,
  deleteProject as deletePortfolioProject,
  createEntry as createPortfolioEntry,
  listEntries as listPortfolioEntries,
  updateEntry as updatePortfolioEntry,
  deleteEntry as deletePortfolioEntry,
  createNote as createPortfolioNote,
  listNotes as listPortfolioNotes,
  updateNote as updatePortfolioNote,
  deleteNote as deletePortfolioNote,
  PORTFOLIO_CATEGORIES,
  PORTFOLIO_ENTRY_STATUSES,
  PORTFOLIO_NOTE_TABS,
  type PortfolioCategory,
  type PortfolioEntryStatus,
  type PortfolioNoteTab,
} from "../portfolio.js";
import {
  createMemoryEntry,
  listMemoryEntries,
  updateMemoryEntry,
  deleteMemoryEntry,
} from "../memory.js";
import {
  getGmailAuthUrl,
  handleGmailCallback,
  isGmailConnected,
  disconnectGmail,
} from "../tools/gmail.js";
import {
  getInstagramAuthUrl,
  handleInstagramCallback,
  isInstagramConnected,
  disconnectInstagram,
} from "../tools/instagram.js";
import {
  getLinkedinAuthUrl,
  handleLinkedinCallback,
  isLinkedinConnected,
  disconnectLinkedin,
} from "../tools/linkedin.js";
import {
  getFacebookAuthUrl,
  handleFacebookCallback,
  isFacebookConnected,
  disconnectFacebook,
} from "../tools/facebook.js";
import { isZernioConnected } from "../tools/zernio.js";
import { isPostizConnected } from "../tools/postiz.js";
import { isScrapegraphConnected } from "../tools/scrapegraph.js";
import { isHunterConnected } from "../tools/hunter.js";
import { saveConnection, deleteConnection, describeConnections, testConnection, refreshRemoteTools } from "../tools/remoteMcp.js";
import {
  getCanvaAuthUrl,
  handleCanvaCallback,
  isCanvaConnected,
  disconnectCanva,
} from "../tools/canva.js";
import { getToolsCatalog } from "./toolsCatalog.js";
import { isImageGenConfigured } from "../tools/image-gen.js";
import { getPostImagesDir } from "../tools/post-images.js";
import { isWhatsappConnected } from "../tools/whatsapp.js";
import { isWhatsappWebhookConfigured, markMessageSeen, handleIncomingWhatsappMessage, verifyWhatsappSignature } from "../tools/whatsapp-autoreply.js";
import { isRedditConnected } from "../tools/reddit.js";
import { filesRouter } from "./filesRoutes.js";
import {
  appendEvent,
  reopenRun,
  getRun,
  listRuns,
  listRunsFor,
  archiveRun,
  unarchiveRun,
  pinRun,
  unpinRun,
  deleteRun,
  cancelRun,
  subscribe,
  flushRunStores,
} from "./store.js";

// Packaged installs ship with no .env file — this fills process.env from the
// Settings screen's persisted values (data/settings.json) instead. A dev
// .env (already loaded above via dotenv/config) always takes priority.
// Also supports a .env placed in the packaged app's writable app-data folder,
// which is useful before Supabase auth is configured and Settings is gated.
function loadAppDataEnv() {
  const envFile = join(getBaseDir(), ".env");
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: false });
}

loadAppDataEnv();
loadSettingsIntoEnv();

function monitorElectronParent() {
  if (process.env.CEO_AGENT_SERVER_CHILD !== "1") return;
  const parentPid = Number(process.env.CEO_AGENT_PARENT_PID);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;

  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      flushRunStores();
      closeStorage().finally(() => process.exit(0));
    }
  }, 5000);
  timer.unref();
}

monitorElectronParent();

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_KEYS = new Set(Object.keys(buildAgentsRegistry()));

function defaultPort(): number {
  return process.env.PORT ? Number(process.env.PORT) : 3000;
}

const app = express();
// Behind Nginx (see DEPLOYMENT.md) the client IP arrives in X-Forwarded-For;
// without this every request looks like it came from 127.0.0.1 and the rate
// limiters below would throttle all users as one. Set TRUST_PROXY=1 (number
// of proxy hops) when running behind a reverse proxy.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable("x-powered-by");
// Standard security headers. CSP is left off for now: the UI relies on
// inline scripts/styles and CDN assets, and a wrong policy silently breaks
// pages — tighten this once the UI's asset origins are pinned down.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Rate limits, per client IP. Generous for normal UI use (polling, streams),
// tight where a request costs money (agent runs) or guards login.
const limitHandler = (_req: express.Request, res: express.Response) => {
  res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
};
const apiLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_API_PER_MIN) || 600, standardHeaders: "draft-7", legacyHeaders: false, handler: limitHandler });
const runLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_RUNS_PER_MIN) || 20, standardHeaders: "draft-7", legacyHeaders: false, handler: limitHandler });
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: "draft-7", legacyHeaders: false, handler: limitHandler });
app.use(["/api", "/webhook", "/auth", "/sso"], apiLimiter);
app.use("/api/auth/session", authLimiter);
app.post(["/api/runs", "/api/agents/:key/runs", "/api/automation/runs", "/api/automation/agents/:key/runs", "/api/runs/:id/reply"], runLimiter);
// Generous headroom for bulk attachments: each parsed file caps at 50,000
// chars (see attachments.ts's MAX_CHARS) and JSON-escaping can inflate that
// somewhat, so a handful of files easily blew past the old 256kb default.
app.use(
  express.json({
    limit: "8mb",
    // Webhook signatures (WhatsApp's X-Hub-Signature-256) are computed over
    // the exact bytes sent, which re-serializing req.body wouldn't reproduce.
    verify: (req, _res, buf) => {
      if ((req as express.Request).originalUrl?.startsWith("/webhook/")) (req as express.Request).rawBody = buf;
    },
  }),
);
// The preview dashboard (/preview) is actively being iterated on in place —
// files change under the same URL from one minute to the next, and the
// browser treating that as cacheable has already caused a "my changes
// aren't showing up" confusion once. Disable caching for just that
// subtree; every other static asset keeps express.static's normal
// (conditional-GET-friendly) behavior.
app.use("/preview", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
// `/` serves whichever UI design the signed-in user picked — ceopro (the
// /preview dashboard, default) or ceounik (public/index.html). The URL never
// changes between them. Signed-out visitors always get ceounik's page since
// it's the one with the login screen; ceopro has none of its own.
app.get(["/", "/index.html"], async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store"); // response varies per user
  let tenant;
  if (isSupabaseAuthConfigured()) {
    try {
      tenant = await readRequestTenant(req);
    } catch {
      next();
      return;
    }
  }
  if (getUiTheme(tenant) === "ceopro") {
    res.sendFile(join(__dirname, "public", "preview", "index.html"));
    return;
  }
  next();
});
app.use(express.static(join(__dirname, "public")));


// Loopback-only, bearer-token-authenticated — not a Supabase-auth'd /api
// route. This is how the locally-spawned `codex` CLI subprocess (see
// providers/codexAgent.ts) reaches this app's own tools (gmail/linear/crm/
// etc.) as an MCP client; no browser ever calls it.
mountCodexMcpBridge(app);

const upload = multer({
  storage: multer.memoryStorage(), // parsed in-memory and discarded — never written to disk
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

app.get("/api/auth/config", (_req, res) => {
  res.json(getPublicAuthConfig());
});

app.post("/api/auth/session", (req, res) => {
  const accessToken = typeof req.body?.access_token === "string" ? req.body.access_token : "";
  if (!accessToken) {
    res.status(400).json({ error: "access_token is required" });
    return;
  }
  setSessionCookie(res, accessToken);
  res.status(204).end();
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/auth/me", (req, res) => {
  readRequestTenant(req)
    .then((tenant) => res.json(tenant))
    .catch(() => res.status(401).json({ error: "authentication required" }));
});

// Entry point for the ERP's "open in CEO Agent" button: the ERP's backend
// (never its frontend) signs a short-lived handoff token with the shared
// ERP_SSO_SECRET and redirects the browser here. No Supabase credentials
// are involved — see the ERP SSO bridge comment in auth.ts. GET renders a
// consent prompt (first-time: "create and link your org"; returning: "sign
// in"); only the POST from clicking Allow actually provisions/links the org
// and signs the browser in, so the ERP can never silently create accounts.
app.use("/sso", express.urlencoded({ extended: false }));

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ssoErrorPage(res: express.Response, message: string) {
  res.status(401).send(`<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:10vh auto;text-align:center">
    <h2>Sign-in link invalid</h2><p>${escapeHtmlAttr(message)}</p><p>Go back to the ERP and click the button again.</p>
  </body></html>`);
}

app.get("/sso/erp", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    ssoErrorPage(res, "Missing token.");
    return;
  }
  let claims;
  try {
    claims = verifyErpHandoff(token);
  } catch (err) {
    ssoErrorPage(res, err instanceof Error ? err.message : "Invalid SSO token");
    return;
  }
  const existingOrg = findTenantByErpOrgId(claims.erpOrgId);
  const heading = existingOrg
    ? `Sign in to CEO Agent as ${escapeHtmlAttr(claims.email ?? claims.name ?? "this account")}?`
    : `Create a CEO Agent organization for ${escapeHtmlAttr(claims.orgName ?? "your company")}?`;
  const body = existingOrg
    ? `You'll be signed in to the CEO Agent org already linked to this account.`
    : `This creates a new CEO Agent org linked to this ERP account. CEO Agent will have access to the data and tools you connect to it (CRM, email, marketing channels, analytics) to automate marketing and other tasks on your behalf.`;
  res.send(`<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:10vh auto;text-align:center">
    <h2>${heading}</h2>
    <p>${body}</p>
    <form method="POST" action="/sso/erp" style="display:inline-block;margin-right:8px">
      <input type="hidden" name="token" value="${escapeHtmlAttr(token)}" />
      <button type="submit" style="padding:10px 20px;font-size:1rem">Allow</button>
    </form>
    <a href="javascript:window.close()||history.back()" style="padding:10px 20px;font-size:1rem">Cancel</a>
  </body></html>`);
});

app.post("/sso/erp", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) {
    ssoErrorPage(res, "Missing token.");
    return;
  }
  try {
    const claims = verifyErpHandoff(token);
    const tenant = completeErpSignIn(claims);
    setErpSessionCookie(res, tenant.organizationId);
    res.redirect("/");
  } catch (err) {
    ssoErrorPage(res, err instanceof Error ? err.message : "Invalid SSO token");
  }
});

app.use("/api/automation", requireAutomationTenant);
app.use("/api", requireAuth);

app.get("/api/ui-theme", (req, res) => {
  res.json({ uiTheme: getUiTheme(req.tenant), themes: UI_THEMES });
});

app.post("/api/ui-theme", (req, res) => {
  const uiTheme = req.body?.uiTheme as UiTheme;
  if (!UI_THEMES.includes(uiTheme)) {
    res.status(400).json({ error: `uiTheme must be one of: ${UI_THEMES.join(", ")}` });
    return;
  }
  setUiTheme(req.tenant, uiTheme);
  res.json({ uiTheme });
});

// --- Uploads: extracts text from an uploaded file for the client to attach
// to a goal, rather than the app storing it or an agent needing a file tool.

app.post("/api/uploads", upload.single("file"), restoreTenant, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  try {
    const { text, truncated } = await parseAttachment(req.file.buffer, req.file.originalname);
    // HTML templates are the one attachment type an agent later needs to
    // reproduce byte-for-byte (to save/send as a designed email) rather than
    // just read — retyping one through the model's own generation is where
    // long templates silently lose their later sections. Persisting the raw
    // file under workspace/ lets import_email_template_from_file (gmail.ts)
    // read it straight off disk instead, bypassing that failure mode.
    let path: string | undefined;
    const ext = req.file.originalname.toLowerCase().split(".").pop();
    if (ext === "html" || ext === "htm") {
      const uploadsDir = resolveVirtualPath("workspace/uploads");
      await fsPromises.mkdir(uploadsDir.absPath, { recursive: true });
      const entry = await saveUpload("workspace/uploads", req.file.originalname, req.file.buffer);
      path = entry.path;
    }
    res.json({ filename: req.file.originalname, text, truncated, path });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface AttachmentInput {
  filename: string;
  text: string;
  truncated?: boolean;
  path?: string;
}

function parseOneAttachment(a: unknown): AttachmentInput | undefined {
  if (!a || typeof a !== "object") return undefined;
  const { filename, text, truncated, path } = a as Record<string, unknown>;
  if (typeof filename !== "string" || typeof text !== "string") return undefined;
  return { filename, text, truncated: truncated === true, path: typeof path === "string" ? path : undefined };
}

// Accepts both the current plural `attachments` array (bulk upload) and the
// older singular `attachment` field, so existing automation callers (n8n,
// Zapier) that only ever sent one file keep working unchanged.
function readAttachments(body: unknown): AttachmentInput[] {
  const b = body as { attachment?: unknown; attachments?: unknown };
  const list = Array.isArray(b?.attachments) ? b.attachments.map(parseOneAttachment).filter((a): a is AttachmentInput => !!a) : [];
  const single = parseOneAttachment(b?.attachment);
  return single ? [single, ...list] : list;
}

// The goal stored on the run record (shown in the UI — history list, run
// header) stays short; the agent gets that same text plus every attachment
// appended, so a 50,000-character file dump never has to render as a page
// heading.
function buildPrompt(goal: string, attachments: AttachmentInput[]): string {
  if (!attachments.length) return goal;
  const blocks = attachments.map((a) => {
    const note = a.truncated ? " (truncated)" : "";
    const pathNote = a.path
      ? ` (path: ${a.path} — an HTML template: if saving/sending this design, use import_email_template_from_file with this exact path instead of retyping the markup below into create_email_template, which corrupts long HTML)`
      : "";
    return `--- Attached file: ${a.filename}${note}${pathNote} ---\n${a.text}\n--- end of attachment ---`;
  });
  return `${goal}\n\n${blocks.join("\n\n")}`;
}

// --- Runs: CEO overview (delegates to whichever specialists fit) ---

// "provider" lets the caller pin a run to one specific model (from the
// dashboard's model dropdown) instead of the default Claude -> OpenAI ->
// DeepSeek -> Ollama auto-cascade — invalid/omitted values fall back to
// "auto" rather than rejecting the request, since this is an enhancement,
// not a required field for any existing caller (automation/n8n included).
function parseProviderChoice(body: unknown): LlmProviderChoice {
  const value = (body as { provider?: unknown })?.provider;
  return typeof value === "string" && isValidProviderChoice(value) ? value : "auto";
}

function startCeoRun(goal: string, attachments: AttachmentInput[], provider: LlmProviderChoice) {
  return runRunnerStartCeoRun(goal, buildPrompt(goal, attachments), provider);
}

function startSpecialistRun(key: string, goal: string, attachments: AttachmentInput[], provider: LlmProviderChoice) {
  return runRunnerStartSpecialistRun(key, goal, buildPrompt(goal, attachments), provider);
}

app.post("/api/runs", (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startCeoRun(goal, readAttachments(req.body), parseProviderChoice(req.body));
  res.status(201).json({ id: record.id });
});

// --- Runs: direct to one specialist, bypassing the CEO ---

app.post("/api/agents/:key/runs", (req, res) => {
  const { key } = req.params;
  if (!AGENT_KEYS.has(key)) {
    res.status(404).json({ error: `unknown agent: ${key}` });
    return;
  }
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startSpecialistRun(key, goal, readAttachments(req.body), parseProviderChoice(req.body));
  res.status(201).json({ id: record.id });
});

// --- Automation: same run-creation, gated by a shared API key instead of
// being reachable by anyone loading the page. This is the surface external
// automation tools (n8n, Zapier) call — kept separate from /api/runs and
// /api/agents/:key/runs above so the browser UI never needs to carry a
// secret client-side.

app.post("/api/automation/runs", (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startCeoRun(goal, readAttachments(req.body), parseProviderChoice(req.body));
  res.status(201).json({ id: record.id });
});

app.post("/api/automation/agents/:key/runs", (req, res) => {
  const { key } = req.params;
  if (!AGENT_KEYS.has(key)) {
    res.status(404).json({ error: `unknown agent: ${key}` });
    return;
  }
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startSpecialistRun(key, goal, readAttachments(req.body), parseProviderChoice(req.body));
  res.status(201).json({ id: record.id });
});

// --- Reply: continue a finished run's same agent conversation, instead of
// starting a fresh one with no memory of what was already said. ---

app.post("/api/runs/:id/reply", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (record.status === "running") {
    res.status(409).json({ error: "this run is still in progress" });
    return;
  }
  if (!record.sessionId) {
    res.status(409).json({ error: "this run can't be continued (no session was captured for it)" });
    return;
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  enforceRunLimits();
  reopenRun(record.id);
  appendEvent(record.id, { type: "text", source: "user", text: message, ts: new Date().toISOString() });
  res.status(202).json({ id: record.id });

  const resumeSessionId = record.sessionId;
  const agentKey = record.agentKey;
  const provider = record.provider ?? "auto";
  startRun(record, (abortController) =>
    agentKey === "ceo"
      ? runCeoAgentWithFallback(message, (event) => appendEvent(record.id, event), resumeSessionId, provider, abortController)
      : runSpecialistAgentWithFallback(agentKey, message, (event) => appendEvent(record.id, event), resumeSessionId, provider, abortController),
  );
});

function parseSentEmailQuery(q: express.Request["query"]): SentEmailQuery {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const channel = str(q.channel);
  const status = str(q.status);
  const limit = Number(q.limit);
  return {
    since: str(q.since),
    channel: channel === "gmail" || channel === "ses" ? channel : undefined,
    status: status === "sent" || status === "failed" ? status : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

// Log of every email this app sent (Gmail + SES), newest first.
// Query: ?since=<ISO date>&channel=gmail|ses&status=sent|failed&limit=1..1000
// /api/sent-emails is for this app's own UI (session auth);
// /api/automation/sent-emails is for external systems (X-API-Key + X-Organization-Id).
app.get("/api/sent-emails", (req, res) => {
  res.json({ emails: listSentEmails(parseSentEmailQuery(req.query)) });
});

app.get("/api/automation/sent-emails", (req, res) => {
  res.json({ emails: listSentEmails(parseSentEmailQuery(req.query)) });
});

// --- Guardrails: today's usage against the configured caps, and the outbound-action audit trail ---

app.get("/api/guardrails", (_req, res) => {
  res.json({ limits: guardrailLimits(), usageToday: getDailyUsage() });
});

app.get("/api/audit-log", (req, res) => {
  res.json(readAuditLog(Number(req.query.limit) || 200));
});

app.get("/api/departments", (_req, res) => {
  res.json(DEPARTMENTS);
});

app.get("/api/analytics", (_req, res) => {
  res.json(getAnalytics());
});

app.get("/api/analytics/external", async (_req, res) => {
  res.json(await getExternalAnalytics());
});

app.get("/api/analytics/external/dashboard", async (req, res) => {
  const range = typeof req.query.range === "string" ? req.query.range : "7d";
  res.json(await getExternalAnalyticsDashboard(range));
});

// --- Schedules: the Calendar department's "click a date/range" automations.
// Structured recurrence (never a raw cron string) parsed from the request
// body — same "read this file's routes, this is the deterministic surface;
// the Calendar agent's MCP tools in tools/scheduler.ts are the natural-
// language surface" split as the rest of this app's tool-vs-route pattern.

function parseRecurrence(body: unknown): Recurrence | { error: string } {
  const r = (body as { recurrence?: unknown })?.recurrence;
  if (!r || typeof r !== "object") return { error: "recurrence is required" };
  const { type, date, startDate, endDate, weekdays } = r as Record<string, unknown>;
  if (type === "once") {
    if (typeof date !== "string" || !date) return { error: "recurrence.date is required for type=once" };
    return { type: "once", date };
  }
  if (type === "daily") {
    if (typeof startDate !== "string" || !startDate) return { error: "recurrence.startDate is required for type=daily" };
    return { type: "daily", startDate, endDate: typeof endDate === "string" ? endDate : undefined };
  }
  if (type === "weekly") {
    if (typeof startDate !== "string" || !startDate) return { error: "recurrence.startDate is required for type=weekly" };
    if (!Array.isArray(weekdays) || !weekdays.every((d) => typeof d === "number" && d >= 0 && d <= 6) || weekdays.length === 0) {
      return { error: "recurrence.weekdays must be a non-empty array of numbers 0-6 for type=weekly" };
    }
    return { type: "weekly", weekdays, startDate, endDate: typeof endDate === "string" ? endDate : undefined };
  }
  return { error: 'recurrence.type must be "once", "daily", or "weekly"' };
}

app.get("/api/schedule", (_req, res) => {
  res.json(listSchedules());
});

app.post("/api/schedule", (req, res) => {
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  const agentKey = typeof req.body?.agentKey === "string" ? req.body.agentKey : "";
  const time = typeof req.body?.time === "string" ? req.body.time : "";
  if (!label) {
    res.status(400).json({ error: "label is required" });
    return;
  }
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  if (agentKey !== "ceo" && !AGENT_KEYS.has(agentKey)) {
    res.status(404).json({ error: `unknown agent: ${agentKey}` });
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    res.status(400).json({ error: 'time must be 24h "HH:MM"' });
    return;
  }
  const recurrence = parseRecurrence(req.body);
  if ("error" in recurrence) {
    res.status(400).json({ error: recurrence.error });
    return;
  }
  const record = createSchedule({ label, goal, agentKey, recurrence, time });
  res.status(201).json(record);
});

app.patch("/api/schedule/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.label === "string") patch.label = req.body.label.trim();
  if (typeof req.body?.goal === "string") patch.goal = req.body.goal.trim();
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if (typeof req.body?.time === "string") {
    if (!/^\d{2}:\d{2}$/.test(req.body.time)) {
      res.status(400).json({ error: 'time must be 24h "HH:MM"' });
      return;
    }
    patch.time = req.body.time;
  }
  if (typeof req.body?.agentKey === "string") {
    if (req.body.agentKey !== "ceo" && !AGENT_KEYS.has(req.body.agentKey)) {
      res.status(404).json({ error: `unknown agent: ${req.body.agentKey}` });
      return;
    }
    patch.agentKey = req.body.agentKey;
  }
  if (req.body?.recurrence !== undefined) {
    const recurrence = parseRecurrence(req.body);
    if ("error" in recurrence) {
      res.status(400).json({ error: recurrence.error });
      return;
    }
    patch.recurrence = recurrence;
  }
  const record = updateSchedule(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/schedule/:id", (req, res) => {
  const ok = deleteSchedule(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Leads: the CRM department's pipeline. Same "deterministic REST route
// for the UI, natural-language MCP tools (tools/crm.ts) for the agent" split
// as schedules above.

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

app.get("/api/leads", (req, res) => {
  const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
  const includeArchived = req.query.archived === "true";
  let leads = listLeads();
  if (!includeArchived) leads = leads.filter((l) => !l.archived);
  if (stage) leads = leads.filter((l) => l.stage === stage);
  res.json(leads);
});

app.post("/api/leads", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!source) {
    res.status(400).json({ error: "source is required" });
    return;
  }
  if (req.body?.stage !== undefined && !LEAD_STAGES.includes(req.body.stage)) {
    res.status(400).json({ error: `stage must be one of: ${LEAD_STAGES.join(", ")}` });
    return;
  }
  const record = createLead({
    name,
    source,
    company: typeof req.body?.company === "string" ? req.body.company : undefined,
    email: typeof req.body?.email === "string" ? req.body.email : undefined,
    phone: typeof req.body?.phone === "string" ? req.body.phone : undefined,
    title: typeof req.body?.title === "string" ? req.body.title : undefined,
    stage: req.body?.stage as LeadStage | undefined,
    value: typeof req.body?.value === "number" ? req.body.value : undefined,
    currency: typeof req.body?.currency === "string" ? req.body.currency : undefined,
    owner: typeof req.body?.owner === "string" ? req.body.owner : undefined,
    tags: isStringArray(req.body?.tags) ? req.body.tags : undefined,
    followUpAt: typeof req.body?.followUpAt === "string" ? req.body.followUpAt : undefined,
    notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
  });
  res.status(201).json(record);
});

app.patch("/api/leads/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of ["name", "company", "email", "phone", "title", "source", "owner", "followUpAt", "currency", "notes"] as const) {
    if (typeof req.body?.[field] === "string") patch[field] = req.body[field];
  }
  if (req.body?.stage !== undefined) {
    if (!LEAD_STAGES.includes(req.body.stage)) {
      res.status(400).json({ error: `stage must be one of: ${LEAD_STAGES.join(", ")}` });
      return;
    }
    patch.stage = req.body.stage;
  }
  if (typeof req.body?.value === "number") patch.value = req.body.value;
  if (isStringArray(req.body?.tags)) patch.tags = req.body.tags;
  if (typeof req.body?.archived === "boolean") patch.archived = req.body.archived;
  const record = updateLead(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.post("/api/leads/:id/activity", (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!note) {
    res.status(400).json({ error: "note is required" });
    return;
  }
  const record = addLeadActivity(req.params.id, note);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/leads/:id", (req, res) => {
  const ok = deleteLead(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Playbook: Sales/Marketing checklists of agent-produced deliverables
// (AI-generated copy, images, videos, email/script drafts). Rows are
// created by the specialist agents (tools/playbook.ts) — this REST surface
// only reads, and lets a human edit fields or toggle done/delete a row.

app.get("/api/playbook", (req, res) => {
  const tab = typeof req.query.tab === "string" ? req.query.tab : undefined;
  if (tab !== undefined && !PLAYBOOK_TABS.includes(tab as PlaybookTab)) {
    res.status(400).json({ error: `tab must be one of: ${PLAYBOOK_TABS.join(", ")}` });
    return;
  }
  res.json(listPlaybookItems(tab as PlaybookTab | undefined));
});

app.patch("/api/playbook/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of ["platform", "link", "details", "notes"] as const) {
    if (typeof req.body?.[field] === "string") patch[field] = req.body[field];
  }
  if (req.body?.type !== undefined) {
    if (!PLAYBOOK_ITEM_TYPES.includes(req.body.type as PlaybookItemType)) {
      res.status(400).json({ error: `type must be one of: ${PLAYBOOK_ITEM_TYPES.join(", ")}` });
      return;
    }
    patch.type = req.body.type;
  }
  if (typeof req.body?.done === "boolean") patch.done = req.body.done;
  const record = updatePlaybookItem(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/playbook/:id", (req, res) => {
  const ok = deletePlaybookItem(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Portfolio: editable project/product tabs, each holding entries across
// five fixed categories (blog/article/collab/pr-post/email), plus freeform
// markdown notes under "project-details"/"database" tabs — durable project
// memory (tech stack, credentials locations, config values) agents read for
// context. Same REST-for-UI, MCP-tools-for-agent split as leads/playbook
// above.

app.get("/api/portfolio/projects", (_req, res) => {
  res.json(listPortfolioProjects());
});

app.post("/api/portfolio/projects", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.status(201).json(createPortfolioProject(name));
});

app.patch("/api/portfolio/projects/:id", (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const record = renamePortfolioProject(req.params.id, name);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/portfolio/projects/:id", (req, res) => {
  const ok = deletePortfolioProject(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/portfolio/entries", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  if (category !== undefined && !PORTFOLIO_CATEGORIES.includes(category as PortfolioCategory)) {
    res.status(400).json({ error: `category must be one of: ${PORTFOLIO_CATEGORIES.join(", ")}` });
    return;
  }
  res.json(listPortfolioEntries({ projectId, category: category as PortfolioCategory | undefined }));
});

app.post("/api/portfolio/entries", (req, res) => {
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!PORTFOLIO_CATEGORIES.includes(req.body?.category as PortfolioCategory)) {
    res.status(400).json({ error: `category must be one of: ${PORTFOLIO_CATEGORIES.join(", ")}` });
    return;
  }
  if (req.body?.status !== undefined && !PORTFOLIO_ENTRY_STATUSES.includes(req.body.status as PortfolioEntryStatus)) {
    res.status(400).json({ error: `status must be one of: ${PORTFOLIO_ENTRY_STATUSES.join(", ")}` });
    return;
  }
  const record = createPortfolioEntry({
    projectId,
    title,
    category: req.body.category as PortfolioCategory,
    status: req.body?.status as PortfolioEntryStatus | undefined,
    link: typeof req.body?.link === "string" ? req.body.link : undefined,
    date: typeof req.body?.date === "string" ? req.body.date : undefined,
    notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
    recipient: typeof req.body?.recipient === "string" ? req.body.recipient : undefined,
    subject: typeof req.body?.subject === "string" ? req.body.subject : undefined,
    messageId: typeof req.body?.messageId === "string" ? req.body.messageId : undefined,
    owner: "manual",
  });
  res.status(201).json(record);
});

app.patch("/api/portfolio/entries/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of ["projectId", "title", "link", "date", "notes", "recipient", "subject", "messageId"] as const) {
    if (typeof req.body?.[field] === "string") patch[field] = req.body[field];
  }
  if (req.body?.category !== undefined) {
    if (!PORTFOLIO_CATEGORIES.includes(req.body.category as PortfolioCategory)) {
      res.status(400).json({ error: `category must be one of: ${PORTFOLIO_CATEGORIES.join(", ")}` });
      return;
    }
    patch.category = req.body.category;
  }
  if (req.body?.status !== undefined) {
    if (!PORTFOLIO_ENTRY_STATUSES.includes(req.body.status as PortfolioEntryStatus)) {
      res.status(400).json({ error: `status must be one of: ${PORTFOLIO_ENTRY_STATUSES.join(", ")}` });
      return;
    }
    patch.status = req.body.status;
  }
  const record = updatePortfolioEntry(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/portfolio/entries/:id", (req, res) => {
  const ok = deletePortfolioEntry(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/portfolio/notes", (req, res) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const tab = typeof req.query.tab === "string" ? req.query.tab : undefined;
  if (tab !== undefined && !PORTFOLIO_NOTE_TABS.includes(tab as PortfolioNoteTab)) {
    res.status(400).json({ error: `tab must be one of: ${PORTFOLIO_NOTE_TABS.join(", ")}` });
    return;
  }
  res.json(listPortfolioNotes({ projectId, tab: tab as PortfolioNoteTab | undefined }));
});

app.post("/api/portfolio/notes", (req, res) => {
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!PORTFOLIO_NOTE_TABS.includes(req.body?.tab as PortfolioNoteTab)) {
    res.status(400).json({ error: `tab must be one of: ${PORTFOLIO_NOTE_TABS.join(", ")}` });
    return;
  }
  const record = createPortfolioNote({
    projectId,
    title,
    tab: req.body.tab as PortfolioNoteTab,
    content: typeof req.body?.content === "string" ? req.body.content : undefined,
    owner: "manual",
  });
  res.status(201).json(record);
});

app.patch("/api/portfolio/notes/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of ["title", "content"] as const) {
    if (typeof req.body?.[field] === "string") patch[field] = req.body[field];
  }
  const record = updatePortfolioNote(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/portfolio/notes/:id", (req, res) => {
  const ok = deletePortfolioNote(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// --- Memory: the system's permanent, cross-agent knowledge base. Entries
// are normally fed in via the Memory department's chat (see agents.ts/
// tools/memory.ts — a real agent decides how to structure what's said into
// entries), but can also be added/edited directly here for pasting in a
// document without a conversation. No agent tool can delete an entry —
// deletion only exists here, for the Browse view's guarded (typed-
// confirmation) delete flow.

app.get("/api/memory", (req, res) => {
  const query = typeof req.query.query === "string" ? req.query.query : undefined;
  res.json(listMemoryEntries({ query }));
});

app.post("/api/memory", (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const record = createMemoryEntry({ title, content, owner: "manual", source: "manual" });
  res.status(201).json(record);
});

app.patch("/api/memory/:id", (req, res) => {
  const patch: Record<string, unknown> = {};
  for (const field of ["title", "content"] as const) {
    if (typeof req.body?.[field] === "string") patch[field] = req.body[field];
  }
  const record = updateMemoryEntry(req.params.id, patch);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

app.delete("/api/memory/:id", (req, res) => {
  const ok = deleteMemoryEntry(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/runs", (req, res) => {
  const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : undefined;
  const showArchived = req.query.archived === "true";
  const runs = (agentKey ? listRunsFor(agentKey) : listRuns())
    .filter((r) => Boolean(r.archived) === showArchived)
    .map((r) => ({
      id: r.id,
      goal: r.goal,
      agentKey: r.agentKey,
      status: r.status,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      costUsd: r.costUsd,
      summary: r.summary,
      linearTasks: r.linearTasks,
      archived: Boolean(r.archived),
      pinned: Boolean(r.pinned),
    }));
  res.json(runs);
});

app.get("/api/runs/:id", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(record);
});

// --- Archive/delete: archive is reversible (hides a run from the default
// list without losing its transcript); delete is permanent, so it's blocked
// on running (in case an emitter is still live) and expected to be
// confirmed client-side before this ever gets called. ---

app.post("/api/runs/:id/archive", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (record.status === "running") {
    res.status(409).json({ error: "can't archive a run in progress" });
    return;
  }
  archiveRun(record.id);
  res.json({ ok: true });
});

app.post("/api/runs/:id/unarchive", (req, res) => {
  const ok = unarchiveRun(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/runs/:id/pin", (req, res) => {
  const ok = pinRun(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/runs/:id/unpin", (req, res) => {
  const ok = unpinRun(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/runs/:id/cancel", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (record.status !== "running") {
    res.status(409).json({ error: "this run isn't in progress" });
    return;
  }
  cancelRun(record.id);
  res.json({ ok: true });
});

app.delete("/api/runs/:id", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (record.status === "running") {
    res.status(409).json({ error: "can't delete a run in progress" });
    return;
  }
  deleteRun(record.id);
  res.json({ ok: true });
});

app.get("/api/runs/:id/stream", (req, res) => {
  const record = getRun(req.params.id);
  if (!record) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay everything already recorded, so a client that connects mid-run
  // (or after it finished) still sees the full transcript. Skipped when
  // reconnecting after a reply (?replay=0) — the client already has that
  // history from the original connection and only wants what's new.
  if (req.query.replay !== "0") {
    for (const event of record.events) send(event);
  }

  if (record.status !== "running") {
    send({
      type: "run_finished",
      status: record.status,
      summary: record.summary,
      costUsd: record.costUsd,
      linearTasks: record.linearTasks,
      sessionId: record.sessionId,
    });
    res.end();
    return;
  }

  const unsubscribe = subscribe(
    record.id,
    (event) => send(event),
    (finalRecord) => {
      send({
        type: "run_finished",
        status: finalRecord.status,
        summary: finalRecord.summary,
        costUsd: finalRecord.costUsd,
        linearTasks: finalRecord.linearTasks,
        sessionId: finalRecord.sessionId,
      });
      res.end();
    },
  );

  req.on("close", unsubscribe);
});

// --- Documents (deliverables produced by HR/Finance/Sales/Analysis) ---

app.get("/api/documents", (req, res) => {
  const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : undefined;
  res.json(listDocuments(agentKey));
});

app.get("/api/documents/:id", (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(doc);
});

function escapeHtmlForDownload(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadFileName(title: string, ext: string): string {
  const base = title
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "document";
  return `${base}.${ext}`;
}

function documentHtml(title: string, content: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtmlForDownload(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.5; color: #111827; }
    pre { white-space: pre-wrap; font-family: Arial, sans-serif; }
  </style>
</head>
<body>
  <h1>${escapeHtmlForDownload(title)}</h1>
  <pre>${escapeHtmlForDownload(content)}</pre>
</body>
</html>`;
}

function parseMarkdownTables(markdown: string): string[][][] {
  const lines = markdown.split(/\r?\n/);
  const tables: string[][][] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = lines[i].trim();
    const separator = lines[i + 1].trim();
    if (!header.includes("|") || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator)) continue;
    const rows: string[][] = [];
    const splitRow = (line: string) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());
    rows.push(splitRow(header));
    i += 2;
    while (i < lines.length && lines[i].trim().includes("|")) {
      rows.push(splitRow(lines[i]));
      i += 1;
    }
    i -= 1;
    tables.push(rows);
  }
  return tables;
}

async function documentXlsxBuffer(title: string, content: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CEO Agent OS";
  workbook.created = new Date();
  const tables = parseMarkdownTables(content);

  if (tables.length) {
    tables.forEach((table, index) => {
      const worksheet = workbook.addWorksheet(tables.length === 1 ? "Document Data" : `Table ${index + 1}`);
      table.forEach((row) => worksheet.addRow(row));
      worksheet.getRow(1).font = { bold: true };
      table[0]?.forEach((_, columnIndex) => {
        const max = table.reduce((width, row) => Math.max(width, String(row[columnIndex] ?? "").length), 10);
        worksheet.getColumn(columnIndex + 1).width = Math.min(max + 2, 60);
      });
    });
  } else {
    const worksheet = workbook.addWorksheet("Document");
    worksheet.columns = [{ header: "Content", key: "content", width: 100 }];
    content.split(/\r?\n/).forEach((line) => worksheet.addRow({ content: line }));
    worksheet.getRow(1).font = { bold: true };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

app.get("/api/documents/:id/download", async (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "not found" });
    return;
  }

  const format = typeof req.query.format === "string" ? req.query.format.toLowerCase() : "doc";
  if (format === "xlsx") {
    const buffer = await documentXlsxBuffer(doc.title, doc.content);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(doc.title, "xlsx")}"`);
    res.send(buffer);
    return;
  }

  if (format === "doc") {
    res.setHeader("Content-Type", "application/msword; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName(doc.title, "doc")}"`);
    res.send(documentHtml(doc.title, doc.content));
    return;
  }

  res.status(400).json({ error: "unsupported format" });
});

// --- Websites: building happens in a separate project. The sidebar's
// Websites item opens this route in a new tab, and it redirects there.
// Fixed address — not configurable per-deployment via Settings/.env. ---

const WEBSITE_BUILDER_URL = "https://webagent-16ul.onrender.com";

app.get("/api/website-builder", (_req, res) => {
  res.redirect(302, WEBSITE_BUILDER_URL);
});

// --- Files: the human-facing folder browser (data/, deliverables/,
// workspace/) — separate from the /api/documents deliverable feed above. ---

app.use("/api/files", filesRouter);

// --- Settings: API keys/credentials, replacing hand-edited .env for
// packaged installs. Values are never echoed back — only a masked
// placeholder plus whether each field is currently set. ---

app.get("/api/settings", (_req, res) => {
  res.json(getMaskedSettings());
});

app.post("/api/settings", (req, res) => {
  res.json(updateSettings(req.body ?? {}));
});

// --- Remote MCP connections: external systems (the ERPs) whose read-only
// data tools agents can call. One entry per system, per organization; the
// key is write-only here, like Settings — responses carry a mask, never it.
// See tools/remoteMcp.ts. ---

const remoteMcpBody = z.object({
  name: z.string().trim().min(1).max(40),
  url: z.string().trim().min(1).max(500),
  key: z.string().max(500).optional(),
  headerName: z.union([z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, "must be a valid header name"), z.literal("")]).optional(),
  agents: z.array(z.string()).max(20).optional(),
});

app.get("/api/remote-mcp", async (_req, res) => {
  // Statuses come from the discovery cache; give a cold one a moment to fill
  // in without making the page wait on a slow or unreachable server.
  await refreshRemoteTools({ maxWaitMs: 3000 });
  res.json(describeConnections());
});

app.post("/api/remote-mcp", async (req, res) => {
  const parsed = remoteMcpBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    return;
  }
  const unknownAgent = parsed.data.agents?.find((a) => !AGENT_KEYS.has(a));
  if (unknownAgent) {
    res.status(400).json({ error: `Unknown agent: ${unknownAgent}` });
    return;
  }
  try {
    const conn = await saveConnection(parsed.data);
    // Saved either way; the result says whether it could actually connect, so a
    // wrong key shows up now rather than at the first agent run.
    res.json(await testConnection(conn.id));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/remote-mcp/:id/test", async (req, res) => {
  const status = await testConnection(req.params.id);
  if (!status) {
    res.status(404).json({ error: "No such connection." });
    return;
  }
  res.json(status);
});

app.delete("/api/remote-mcp/:id", (req, res) => {
  if (!deleteConnection(req.params.id)) {
    res.status(404).json({ error: "No such connection." });
    return;
  }
  res.json({ ok: true });
});

// --- Account connections ---

// The connect links below are opened in the user's real OS browser (see the
// OAuth-state-token comment in auth.ts), which doesn't carry this request's
// session cookie — so the tenant has to be encoded into the link itself.
function oauthConnectUrl(path: string): string {
  if (!isSupabaseAuthConfigured()) return path;
  const tenant = getTenantContext();
  if (!tenant) return path;
  return `${path}?state=${encodeURIComponent(createOAuthStateToken(tenant))}`;
}

app.get("/api/accounts", (_req, res) => {
  res.json([
    { key: "gmail", label: "Gmail", connected: isGmailConnected(), connectUrl: oauthConnectUrl("/auth/gmail") },
    { key: "instagram", label: "Instagram", connected: isInstagramConnected(), connectUrl: oauthConnectUrl("/auth/instagram") },
    { key: "linkedin", label: "LinkedIn", connected: isLinkedinConnected(), connectUrl: oauthConnectUrl("/auth/linkedin") },
    { key: "facebook", label: "Facebook", connected: isFacebookConnected(), connectUrl: oauthConnectUrl("/auth/facebook") },
    {
      key: "zernio",
      label: "Zernio (social & messaging)",
      connected: isZernioConnected(),
      configOnly: true,
      configHint: "Set your Zernio API key in the Settings screen. Get a key at zernio.com → Settings → API Keys, and link platform accounts from Zernio's own dashboard.",
      signupUrl: "https://zernio.com",
    },
    {
      key: "postiz",
      label: "Postiz (social scheduling)",
      connected: isPostizConnected(),
      configOnly: true,
      configHint: "Set your Postiz API key in the Settings screen. Get one at your Postiz dashboard → Settings → Developers → Apps, and link platform accounts (X, LinkedIn, Facebook, TikTok, YouTube, Threads, etc.) from Postiz's own dashboard. Leave the base URL blank to use Postiz's cloud API, or set it if you're self-hosting Postiz.",
      signupUrl: "https://postiz.com",
    },
    {
      key: "scrapegraph",
      label: "ScrapeGraphAI (structured web extraction)",
      connected: isScrapegraphConnected(),
      configOnly: true,
      configHint: "Set your ScrapeGraphAI API key in the Settings screen. Get one at your ScrapeGraphAI dashboard. Used by the Analysis, SEO, AEO, and CRM agents to pull reliably-shaped data (pricing, specs, contact details, existing schema markup) from pages instead of just free-text summaries.",
      signupUrl: "https://scrapegraphai.com",
    },
    {
      key: "whatsapp",
      label: "WhatsApp (direct)",
      connected: isWhatsappConnected(),
      configOnly: true,
      configHint: "Set your WhatsApp access token, phone number ID, business account ID, webhook verify token, OpenAI API key, and WhatsApp AI handoff settings in the Settings screen. Generate a permanent System User token for the WABA in Meta Business Suite -> Business Settings -> System Users.",
      signupUrl: "https://business.facebook.com/settings",
    },
    {
      key: "image_gen",
      label: "AI image generation (OpenAI / Hugging Face / free fallback)",
      connected: isImageGenConfigured(),
      configOnly: true,
      configHint: `Works out of the box with no key at all, via a free public fallback (Pollinations) — "connected" here just means a paid/higher-quality provider is configured. Set an OpenAI API key for the best quality, and/or a Hugging Face API key (free tier) as a second choice; generation automatically tries OpenAI first, then Hugging Face, then the free fallback, whichever succeeds. Also requires a Zernio API key, since generated images are posted through Zernio. To post your own images instead of generating them, just drop .jpg/.jpeg/.png files in ${getPostImagesDir()} — no extra config needed.`,
      signupUrl: "https://platform.openai.com/api-keys",
    },
    {
      key: "reddit",
      label: "Reddit (SEO/AEO blog posting)",
      connected: isRedditConnected(),
      configOnly: true,
      configHint: "Set your Reddit client ID/secret, account username/password, and allowed subreddits (comma-separated) in the Settings screen. Create a \"script\" type app at reddit.com/prefs/apps to get a client ID/secret. The posting account must NOT have 2FA enabled — this auth method can't complete a 2FA challenge. The SEO and AEO agents can post to any subreddit in your allowed list without asking first, so only add subreddits you're comfortable with that.",
      signupUrl: "https://www.reddit.com/prefs/apps",
    },
    {
      key: "hunter",
      label: "Hunter.io (email finder)",
      connected: isHunterConnected(),
      configOnly: true,
      configHint: "Set your Hunter.io API key in the Settings screen. Get one free at hunter.io (50 free credits/month) — used by the CRM agent to find real, verified contact emails at a prospect's domain instead of guessing.",
      signupUrl: "https://hunter.io/users/sign_up?from=api",
    },
    {
      key: "canva",
      label: "Canva (design)",
      connected: isCanvaConnected(),
      connectUrl: oauthConnectUrl("/auth/canva"),
    },
    {
      key: "analytics_source",
      label: "Analytics Source (your own product's Supabase project)",
      connected: isExternalAnalyticsConfigured(),
      configOnly: true,
      configHint: "Connect any Supabase-backed project so its real-time stats (signups, logins, unique visitors) show up in the Analytics tab here. Set the project URL and a service role key (Project Settings → API in that project's Supabase dashboard — keep this secret, it's used server-side only) in the Settings screen. Reads straight from that project's analytics_events table (or another table name you set) — no changes needed on that project's side.",
    },
  ]);
});

// --- Tools: what each connected integration can actually do, with an
// example prompt — same connection data as /api/accounts, described from a
// "what can I ask for" angle instead of a connect/disconnect one. ---

app.get("/api/tools", (_req, res) => {
  res.json(getToolsCatalog());
});

// WhatsApp Cloud API webhook — inbound messages. Unsigned or mis-signed
// requests are rejected (see verifyWhatsappSignature); with no
// WHATSAPP_APP_SECRET configured, inbound messages are ignored.
function handleWhatsappMessages(req: express.Request, res: express.Response) {
  if (!verifyWhatsappSignature(req.rawBody, req.header("x-hub-signature-256"), getEnvValue("WHATSAPP_APP_SECRET"))) {
    if (!getEnvValue("WHATSAPP_APP_SECRET")) {
      console.warn("[webhook/whatsapp] WHATSAPP_APP_SECRET is not set — ignoring inbound message (set it in Settings to enable auto-reply).");
    }
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);
  if (!isWhatsappConnected() || !isWhatsappWebhookConfigured()) return;
  const entries = req.body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const contacts = change.value?.contacts ?? [];
      for (const message of change.value?.messages ?? []) {
        if (message.type !== "text" || !message.text?.body) continue;
        if (!markMessageSeen(message.id)) continue;
        const contact = contacts.find((c: { wa_id?: string; profile?: { name?: string } }) => c.wa_id === message.from);
        const profileName = contact?.profile?.name;
        handleIncomingWhatsappMessage(message.from, message.text.body, {
          messageId: message.id,
          profileName: typeof profileName === "string" ? profileName : undefined,
        }).catch((err) =>
          console.error("[webhook/whatsapp] auto-reply failed:", err),
        );
      }
    }
  }
}

app.get("/webhook/whatsapp/:organizationId", (req, res) => {
  const tenant = findTenantByOrganizationId(req.params.organizationId);
  if (!tenant) {
    res.sendStatus(404);
    return;
  }
  runWithTenant(tenant, () => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === getEnvValue("WHATSAPP_WEBHOOK_VERIFY_TOKEN")) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });
});

app.post("/webhook/whatsapp/:organizationId", (req, res) => {
  const tenant = findTenantByOrganizationId(req.params.organizationId);
  if (!tenant) {
    res.sendStatus(404);
    return;
  }
  runWithTenant(tenant, () => handleWhatsappMessages(req, res));
});

// The un-scoped /webhook/whatsapp routes run on the server-wide credentials,
// which only makes sense for a single-tenant install. With Supabase auth on,
// each org must use its own /webhook/whatsapp/:organizationId URL.
app.use("/webhook/whatsapp", (req, res, next) => {
  if (req.path === "/" && isSupabaseAuthConfigured()) {
    res.sendStatus(404);
    return;
  }
  next();
});

app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === getEnvValue("WHATSAPP_WEBHOOK_VERIFY_TOKEN")) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// WhatsApp Cloud API webhook — inbound messages. Acks Meta with 200
// immediately (Meta retries/duplicates on anything else), then handles the
// auto-reply asynchronously so the client still gets a near-instant answer
// without holding the webhook connection open.
app.post("/webhook/whatsapp", (req, res) => {
  handleWhatsappMessages(req, res);
});

// No requireAuth here: these routes are opened in the user's real OS
// browser (see below), which doesn't carry this app's session cookie. Each
// handler instead resolves its tenant from the signed `state` token that
// oauthConnectUrl() embedded in the link — see resolveAuthFlowTenant in
// auth.ts for why.

// OAuth connect links open with target="_blank" so Electron's main process
// (setWindowOpenHandler in electron/main.cjs) can route them to the user's
// real OS browser instead of its embedded webview, which Google and others
// block sign-in from. That means the callback lands in a separate browser
// tab/process from the app window — redirecting it back to "/" would just
// open a confusing second copy of the whole app in that tab, so it gets a
// small standalone success page instead. The app window itself picks up the
// new connection via polling (see startAccountConnectPoll in app.js).
function oauthSuccessPage(label: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${label} connected</title>
    <style>
      html, body { height: 100%; margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f4; color: #1f2428; }
      body { display: grid; place-items: center; }
      main { width: min(420px, calc(100vw - 48px)); text-align: center; }
      h1 { margin: 0 0 10px; font-size: 22px; font-weight: 650; }
      p { margin: 0; color: #5d656b; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${label} connected</h1>
      <p>You can close this tab and return to CEO Agent OS.</p>
    </main>
    <script>try { window.close(); } catch {}</script>
  </body>
</html>`;
}

// The state token is threaded through as the OAuth `state` param so the
// provider echoes it back on the callback request below, letting that
// request resolve the same tenant with no cookie involved.
async function runInAuthFlowTenant<T>(req: express.Request, fn: () => T | Promise<T>): Promise<T> {
  const tenant = await resolveAuthFlowTenant(req);
  return tenant ? runWithTenant(tenant, fn) : fn();
}

function stateParam(req: express.Request): string | undefined {
  return typeof req.query.state === "string" ? req.query.state : undefined;
}

app.get("/auth/gmail", async (req, res) => {
  try {
    const url = await runInAuthFlowTenant(req, () => getGmailAuthUrl(stateParam(req)));
    res.redirect(url);
  } catch (err) {
    res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/gmail/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  try {
    if (!code) throw new Error("Missing authorization code");
    await runInAuthFlowTenant(req, () => handleGmailCallback(code));
    res.send(oauthSuccessPage("Gmail"));
  } catch (err) {
    res.status(500).type("text/plain").send(`Gmail connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/gmail/disconnect", (_req, res) => {
  disconnectGmail();
  res.status(204).end();
});

app.get("/auth/instagram", async (req, res) => {
  try {
    const url = await runInAuthFlowTenant(req, () => getInstagramAuthUrl(stateParam(req)));
    res.redirect(url);
  } catch (err) {
    res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/instagram/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  try {
    if (!code) throw new Error("Missing authorization code");
    await runInAuthFlowTenant(req, () => handleInstagramCallback(code));
    res.send(oauthSuccessPage("Instagram"));
  } catch (err) {
    res.status(500).type("text/plain").send(`Instagram connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/instagram/disconnect", (_req, res) => {
  disconnectInstagram();
  res.status(204).end();
});

app.get("/auth/linkedin", async (req, res) => {
  try {
    const url = await runInAuthFlowTenant(req, () => getLinkedinAuthUrl(stateParam(req)));
    res.redirect(url);
  } catch (err) {
    res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/linkedin/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  const oauthErrorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";
  try {
    if (oauthError) throw new Error(`${oauthError}${oauthErrorDescription ? `: ${oauthErrorDescription}` : ""}`);
    // A bare redirect with neither `code` nor `error` (LinkedIn's own hosted
    // error page redirecting here after showing the user a generic failure,
    // rather than LinkedIn passing the reason through) usually means the
    // redirect_uri LinkedIn was sent doesn't exactly match an entry in the
    // app's "Authorized redirect URLs for your app" list — check that first.
    if (!code) throw new Error("Missing authorization code — LinkedIn didn't report a reason. Check that this app's Authorized redirect URLs (LinkedIn Developer Portal → Auth) includes exactly this URL, and that the Community Management API product is approved.");
    await runInAuthFlowTenant(req, () => handleLinkedinCallback(code));
    res.send(oauthSuccessPage("LinkedIn"));
  } catch (err) {
    res.status(500).type("text/plain").send(`LinkedIn connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/linkedin/disconnect", (_req, res) => {
  disconnectLinkedin();
  res.status(204).end();
});

app.get("/auth/facebook", async (req, res) => {
  try {
    const url = await runInAuthFlowTenant(req, () => getFacebookAuthUrl(stateParam(req)));
    res.redirect(url);
  } catch (err) {
    res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/facebook/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  const oauthErrorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";
  try {
    if (oauthError) throw new Error(`${oauthError}${oauthErrorDescription ? `: ${oauthErrorDescription}` : ""}`);
    if (!code) throw new Error("Missing authorization code — check that this app's Valid OAuth Redirect URIs (Meta App Dashboard → Facebook Login → Settings) includes exactly this URL.");
    await runInAuthFlowTenant(req, () => handleFacebookCallback(code));
    res.send(oauthSuccessPage("Facebook"));
  } catch (err) {
    res.status(500).type("text/plain").send(`Facebook connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/facebook/disconnect", (_req, res) => {
  disconnectFacebook();
  res.status(204).end();
});

app.get("/auth/canva", async (req, res) => {
  try {
    const url = await runInAuthFlowTenant(req, () => getCanvaAuthUrl(stateParam(req)));
    res.redirect(url);
  } catch (err) {
    res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/canva/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";
  const oauthErrorDescription = typeof req.query.error_description === "string" ? req.query.error_description : "";
  try {
    if (oauthError) throw new Error(`${oauthError}${oauthErrorDescription ? `: ${oauthErrorDescription}` : ""}`);
    if (!code) throw new Error("Missing authorization code");
    await runInAuthFlowTenant(req, () => handleCanvaCallback(code));
    res.send(oauthSuccessPage("Canva"));
  } catch (err) {
    res.status(500).type("text/plain").send(`Canva connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/canva/disconnect", (_req, res) => {
  disconnectCanva();
  res.status(204).end();
});

// Catches multer errors (oversized file, etc.) as clean JSON instead of
// falling through to Express's default HTML error page.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof LimitExceededError) {
    res.status(429).json({ error: err.message });
    return;
  }
  if (res.headersSent) {
    next(err);
    return;
  }
  // Log the details server-side; never leak stack traces to the client.
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

let shutdownHooked = false;
function hookGracefulShutdown(server: import("node:http").Server) {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, flushing storage and shutting down`);
    server.close();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    flushRunStores();
    closeStorage()
      .catch((err) => console.error("[server] storage flush failed during shutdown:", err))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

export async function startServer(port = defaultPort()): Promise<number> {
  // Must run before anything reads tenant data: in database mode this loads
  // every stored document into memory. Settings are re-applied afterwards
  // since the first, module-load-time pass could only see files on disk.
  await initStorage();
  loadSettingsIntoEnv();
  return new Promise((resolve, reject) => {
    initScheduler({ startCeoRun: runRunnerStartCeoRun, startSpecialistRun: runRunnerStartSpecialistRun });
    const server = app.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      process.env.PORT = String(actualPort);
      console.log(`CEO Agent OS running at http://localhost:${actualPort}`);
      hookGracefulShutdown(server);
      resolve(actualPort);
    });
    server.once("error", reject);
  });
}

// Auto-start only when this file is the process entry point (`tsx
// src/server/index.ts`, i.e. dev/`npm start`) — not when Electron's main
// process imports startServer() itself to control startup order (settings
// must load into process.env before the server binds).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch((err) => {
    console.error("[server] failed to start:", err);
    process.exit(1);
  });
}
