import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent, LinearTaskRef } from "../orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const DATA_FILE = join(DATA_DIR, "runs.json");

export interface RunRecord {
  id: string;
  goal: string;
  /** "ceo" for a run through the CEO overview (which may delegate to any number of
   * specialists), or a specific department key for a direct "ask this agent" run. */
  agentKey: string;
  status: "running" | "success" | "error";
  createdAt: string;
  finishedAt?: string;
  costUsd?: number;
  summary?: string;
  events: RunEvent[];
  linearTasks: LinearTaskRef[];
  /** Claude Agent SDK session ID, once known — lets a finished run be
   * resumed later via a reply instead of starting a fresh, context-less run. */
  sessionId?: string;
}

const runs = new Map<string, RunRecord>();
const emitters = new Map<string, EventEmitter>();

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify([...runs.values()], null, 2));
}

function load() {
  if (!existsSync(DATA_FILE)) return;
  const raw: RunRecord[] = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  for (const r of raw) {
    // Any run still "running" when the server last stopped never finished.
    if (r.status === "running") r.status = "error";
    runs.set(r.id, r);
  }
}
load();

export function createRun(goal: string, agentKey: string): RunRecord {
  const record: RunRecord = {
    id: randomUUID(),
    goal,
    agentKey,
    status: "running",
    createdAt: new Date().toISOString(),
    events: [],
    linearTasks: [],
  };
  runs.set(record.id, record);
  emitters.set(record.id, new EventEmitter().setMaxListeners(50));
  persist();
  return record;
}

/**
 * Records a message from the agent run and notifies live subscribers.
 *
 * IMPORTANT: a "done" event marks the end of one agentic *turn*, not
 * necessarily the end of the run — the CEO agent can end its turn while a
 * subagent it spawned (e.g. the manager) keeps working in the background and
 * reports back later, producing a further "done" once that settles. Do not
 * treat "done" as run-terminal here; that's what `finishRun` is for, called
 * only once the orchestrator's async generator has fully drained.
 */
export function appendEvent(id: string, event: RunEvent) {
  const record = runs.get(id);
  if (!record) return;
  record.events.push(event);
  persist();
  emitters.get(id)?.emit("event", event);
}

/**
 * Marks a run as truly finished — call this only after runCeoAgent's promise
 * resolves (or rejects), i.e. the whole run including any backgrounded
 * subagent work has settled. Derives final status/summary from the last
 * "done" event recorded (cost is summed across ALL "done" events, so a
 * run that's been continued via replies reports its true total rather than
 * just the latest turn), and closes out any live SSE subscribers.
 */
export function finishRun(id: string) {
  const record = runs.get(id);
  if (!record) return;
  const doneEvents = record.events.filter((e): e is Extract<RunEvent, { type: "done" }> => e.type === "done");
  const lastDone = doneEvents[doneEvents.length - 1];
  if (lastDone) {
    record.status = lastDone.status;
    record.finishedAt = lastDone.ts;
    record.costUsd = doneEvents.reduce((sum, e) => sum + e.costUsd, 0);
    record.summary = lastDone.status === "success" ? lastDone.summary : lastDone.error;
  } else {
    record.status = "error";
    record.finishedAt = new Date().toISOString();
    record.summary = "Run ended without a result.";
  }
  persist();
  emitters.get(id)?.emit("close", record);
  emitters.delete(id);
}

export function setLinearTasks(id: string, tasks: LinearTaskRef[]) {
  const record = runs.get(id);
  if (!record) return;
  record.linearTasks = tasks;
  persist();
}

export function setSessionId(id: string, sessionId: string | undefined) {
  if (!sessionId) return;
  const record = runs.get(id);
  if (!record) return;
  record.sessionId = sessionId;
  persist();
}

/**
 * Re-opens an already-finished run so a reply can continue it in place —
 * same run record, same id, same event log, just resumed rather than
 * starting a fresh context-less run. Recreates the emitter finishRun tore
 * down, so the run can stream and be finished again normally.
 */
export function reopenRun(id: string): boolean {
  const record = runs.get(id);
  if (!record) return false;
  record.status = "running";
  emitters.set(id, new EventEmitter().setMaxListeners(50));
  persist();
  return true;
}

export function getRun(id: string): RunRecord | undefined {
  return runs.get(id);
}

export function listRuns(): RunRecord[] {
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Runs relevant to one department: either run directly against it, or a CEO
 * run that delegated to it at some point (detected from event sources).
 */
export function listRunsFor(agentKey: string): RunRecord[] {
  return listRuns().filter(
    (r) => r.agentKey === agentKey || r.events.some((e) => "source" in e && e.source === agentKey),
  );
}

export function subscribe(
  id: string,
  onEvent: (e: RunEvent) => void,
  onClose: (finalRecord: RunRecord) => void,
) {
  const emitter = emitters.get(id);
  if (!emitter) return () => {};
  emitter.on("event", onEvent);
  emitter.on("close", onClose);
  return () => {
    emitter.off("event", onEvent);
    emitter.off("close", onClose);
  };
}
