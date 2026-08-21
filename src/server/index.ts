import "dotenv/config";
import express from "express";
import multer from "multer";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSettingsIntoEnv, getMaskedSettings, updateSettings } from "./settings.js";
import { DEPARTMENTS, buildAgentsRegistry } from "../agents.js";
import { listDocuments, getDocument } from "../tools/documents.js";
import { parseAttachment } from "../tools/attachments.js";
import { getAnalytics } from "./analytics.js";
import { runCeoAgent, runSpecialistAgent } from "../orchestrator.js";
import { startCeoRun as runRunnerStartCeoRun, startSpecialistRun as runRunnerStartSpecialistRun, startRun } from "./runRunner.js";
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  initScheduler,
  type Recurrence,
} from "../scheduler.js";
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
import { isZernioConnected } from "../tools/zernio.js";
import { isImageGenConfigured } from "../tools/image-gen.js";
import { POST_IMAGES_DIR } from "../tools/post-images.js";
import { isWhatsappConnected } from "../tools/whatsapp.js";
import { filesRouter } from "./filesRoutes.js";
import {
  appendEvent,
  reopenRun,
  getRun,
  listRuns,
  listRunsFor,
  archiveRun,
  unarchiveRun,
  deleteRun,
  subscribe,
} from "./store.js";

// Packaged installs ship with no .env file — this fills process.env from the
// Settings screen's persisted values (data/settings.json) instead. A dev
// .env (already loaded above via dotenv/config) always takes priority.
loadSettingsIntoEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const AGENT_KEYS = new Set(Object.keys(buildAgentsRegistry()));

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(), // parsed in-memory and discarded — never written to disk
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// --- Uploads: extracts text from an uploaded file for the client to attach
// to a goal, rather than the app storing it or an agent needing a file tool.

app.post("/api/uploads", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  try {
    const { text, truncated } = await parseAttachment(req.file.buffer, req.file.originalname);
    res.json({ filename: req.file.originalname, text, truncated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface AttachmentInput {
  filename: string;
  text: string;
  truncated?: boolean;
}

function readAttachment(body: unknown): AttachmentInput | undefined {
  const a = (body as { attachment?: unknown })?.attachment;
  if (!a || typeof a !== "object") return undefined;
  const { filename, text, truncated } = a as Record<string, unknown>;
  if (typeof filename !== "string" || typeof text !== "string") return undefined;
  return { filename, text, truncated: truncated === true };
}

// The goal stored on the run record (shown in the UI — history list, run
// header) stays short; the agent gets that same text plus the attachment
// appended, so a 50,000-character file dump never has to render as a page
// heading.
function buildPrompt(goal: string, attachment: AttachmentInput | undefined): string {
  if (!attachment) return goal;
  const note = attachment.truncated ? " (truncated)" : "";
  return `${goal}\n\n--- Attached file: ${attachment.filename}${note} ---\n${attachment.text}\n--- end of attachment ---`;
}

// --- Runs: CEO overview (delegates to whichever specialists fit) ---

function startCeoRun(goal: string, attachment: AttachmentInput | undefined) {
  return runRunnerStartCeoRun(goal, buildPrompt(goal, attachment));
}

function startSpecialistRun(key: string, goal: string, attachment: AttachmentInput | undefined) {
  return runRunnerStartSpecialistRun(key, goal, buildPrompt(goal, attachment));
}

app.post("/api/runs", (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startCeoRun(goal, readAttachment(req.body));
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
  const record = startSpecialistRun(key, goal, readAttachment(req.body));
  res.status(201).json({ id: record.id });
});

// --- Automation: same run-creation, gated by a shared API key instead of
// being reachable by anyone loading the page. This is the surface external
// automation tools (n8n, Zapier) call — kept separate from /api/runs and
// /api/agents/:key/runs above so the browser UI never needs to carry a
// secret client-side.

function requireAutomationKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const configuredKey = process.env.AUTOMATION_API_KEY;
  if (!configuredKey) {
    res.status(503).json({ error: "AUTOMATION_API_KEY is not configured on this server" });
    return;
  }
  if (req.header("X-API-Key") !== configuredKey) {
    res.status(401).json({ error: "invalid or missing X-API-Key header" });
    return;
  }
  next();
}

app.post("/api/automation/runs", requireAutomationKey, (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const record = startCeoRun(goal, readAttachment(req.body));
  res.status(201).json({ id: record.id });
});

app.post("/api/automation/agents/:key/runs", requireAutomationKey, (req, res) => {
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
  const record = startSpecialistRun(key, goal, readAttachment(req.body));
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

  reopenRun(record.id);
  res.status(202).json({ id: record.id });

  const resumeSessionId = record.sessionId;
  const agentKey = record.agentKey;
  startRun(record, () =>
    agentKey === "ceo"
      ? runCeoAgent(message, (event) => appendEvent(record.id, event), resumeSessionId)
      : runSpecialistAgent(agentKey, message, (event) => appendEvent(record.id, event), resumeSessionId),
  );
});

app.get("/api/departments", (_req, res) => {
  res.json(DEPARTMENTS);
});

app.get("/api/analytics", (_req, res) => {
  res.json(getAnalytics());
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

// --- Account connections ---

app.get("/api/accounts", (_req, res) => {
  res.json([
    { key: "gmail", label: "Gmail", connected: isGmailConnected(), connectUrl: "/auth/gmail" },
    { key: "instagram", label: "Instagram", connected: isInstagramConnected(), connectUrl: "/auth/instagram" },
    { key: "linkedin", label: "LinkedIn", connected: isLinkedinConnected(), connectUrl: "/auth/linkedin" },
    {
      key: "zernio",
      label: "Zernio (social & messaging)",
      connected: isZernioConnected(),
      configOnly: true,
      configHint: "Set your Zernio API key in the Settings screen. Get a key at zernio.com → Settings → API Keys, and link platform accounts from Zernio's own dashboard.",
      signupUrl: "https://zernio.com",
    },
    {
      key: "whatsapp",
      label: "WhatsApp (direct)",
      connected: isWhatsappConnected(),
      configOnly: true,
      configHint: "Set your WhatsApp access token, phone number ID, and business account ID in the Settings screen. Generate a permanent System User token for the WABA in Meta Business Suite → Business Settings → System Users.",
      signupUrl: "https://business.facebook.com/settings",
    },
    {
      key: "image_gen",
      label: "AI image generation (OpenAI)",
      connected: isImageGenConfigured(),
      configOnly: true,
      configHint: `Set your OpenAI API key in the Settings screen. Also requires a Zernio API key, since generated images are posted through Zernio. To post your own images instead of generating them, just drop .jpg/.jpeg/.png files in ${POST_IMAGES_DIR} — no extra config needed.`,
      signupUrl: "https://platform.openai.com/api-keys",
    },
  ]);
});

app.get("/auth/gmail", (_req, res) => {
  try {
    res.redirect(getGmailAuthUrl());
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/gmail/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  try {
    if (!code) throw new Error("Missing authorization code");
    await handleGmailCallback(code);
    res.redirect("/?connected=gmail");
  } catch (err) {
    res.status(500).send(`Gmail connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/gmail/disconnect", (_req, res) => {
  disconnectGmail();
  res.status(204).end();
});

app.get("/auth/instagram", (_req, res) => {
  try {
    res.redirect(getInstagramAuthUrl());
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
  }
});

app.get("/auth/instagram/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  try {
    if (!code) throw new Error("Missing authorization code");
    await handleInstagramCallback(code);
    res.redirect("/?connected=instagram");
  } catch (err) {
    res.status(500).send(`Instagram connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/instagram/disconnect", (_req, res) => {
  disconnectInstagram();
  res.status(204).end();
});

app.get("/auth/linkedin", (_req, res) => {
  try {
    res.redirect(getLinkedinAuthUrl());
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
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
    await handleLinkedinCallback(code);
    res.redirect("/?connected=linkedin");
  } catch (err) {
    res.status(500).send(`LinkedIn connection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post("/api/accounts/linkedin/disconnect", (_req, res) => {
  disconnectLinkedin();
  res.status(204).end();
});

// Catches multer errors (oversized file, etc.) as clean JSON instead of
// falling through to Express's default HTML error page.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
});

export function startServer(): Promise<void> {
  return new Promise((resolve) => {
    initScheduler({ startCeoRun: runRunnerStartCeoRun, startSpecialistRun: runRunnerStartSpecialistRun });
    app.listen(PORT, () => {
      console.log(`CEO Agent OS running at http://localhost:${PORT}`);
      resolve();
    });
  });
}

// Auto-start only when this file is the process entry point (`tsx
// src/server/index.ts`, i.e. dev/`npm start`) — not when Electron's main
// process imports startServer() itself to control startup order (settings
// must load into process.env before the server binds).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
