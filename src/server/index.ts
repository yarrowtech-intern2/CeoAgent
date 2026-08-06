import "dotenv/config";
import express from "express";
import multer from "multer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCeoAgent, runSpecialistAgent, type LinearTaskRef } from "../orchestrator.js";
import { DEPARTMENTS, buildAgentsRegistry } from "../agents.js";
import { listDocuments, getDocument } from "../tools/documents.js";
import { parseAttachment } from "../tools/attachments.js";
import { getAnalytics } from "./analytics.js";
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
  createRun,
  appendEvent,
  setLinearTasks,
  setSessionId,
  finishRun,
  reopenRun,
  getRun,
  listRuns,
  listRunsFor,
  subscribe,
} from "./store.js";

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

function startRun(
  record: { id: string },
  run: () => Promise<{ linearTasks: LinearTaskRef[]; sessionId?: string }>,
) {
  run()
    .then((result) => {
      setLinearTasks(record.id, result.linearTasks);
      setSessionId(record.id, result.sessionId);
    })
    .catch((err) => {
      appendEvent(record.id, {
        type: "done",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        ts: new Date().toISOString(),
      });
    })
    .finally(() => finishRun(record.id));
}

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

app.post("/api/runs", (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) {
    res.status(400).json({ error: "goal is required" });
    return;
  }
  const attachment = readAttachment(req.body);

  const record = createRun(goal, "ceo");
  res.status(201).json({ id: record.id });
  startRun(record, () => runCeoAgent(buildPrompt(goal, attachment), (event) => appendEvent(record.id, event)));
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
  const attachment = readAttachment(req.body);

  const record = createRun(goal, key);
  res.status(201).json({ id: record.id });
  startRun(record, () =>
    runSpecialistAgent(key, buildPrompt(goal, attachment), (event) => appendEvent(record.id, event)),
  );
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

app.get("/api/runs", (req, res) => {
  const agentKey = typeof req.query.agentKey === "string" ? req.query.agentKey : undefined;
  const runs = (agentKey ? listRunsFor(agentKey) : listRuns()).map((r) => ({
    id: r.id,
    goal: r.goal,
    agentKey: r.agentKey,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    costUsd: r.costUsd,
    summary: r.summary,
    linearTasks: r.linearTasks,
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

// --- Account connections ---

app.get("/api/accounts", (_req, res) => {
  res.json([
    { key: "gmail", label: "Gmail", connected: isGmailConnected(), connectUrl: "/auth/gmail" },
    { key: "instagram", label: "Instagram", connected: isInstagramConnected(), connectUrl: "/auth/instagram" },
    { key: "linkedin", label: "LinkedIn", connected: isLinkedinConnected(), connectUrl: "/auth/linkedin" },
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
  try {
    if (!code) throw new Error("Missing authorization code");
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

app.listen(PORT, () => {
  console.log(`CEO Agent OS running at http://localhost:${PORT}`);
});
