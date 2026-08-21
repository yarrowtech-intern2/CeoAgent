import { runCeoAgent, runSpecialistAgent, type LinearTaskRef } from "../orchestrator.js";
import { createRun, appendEvent, setLinearTasks, setSessionId, finishRun, getRun } from "./store.js";

// Fires a POST to WEBHOOK_URL (if configured) with the finished run's result,
// so n8n/Zapier can react without polling. Fire-and-forget: a webhook
// receiver being down must never affect the run itself, which has already
// finished by the time this is called.
export function notifyWebhook(record: {
  id: string;
  agentKey: string;
  status: string;
  summary?: string;
  costUsd?: number;
  linearTasks: LinearTaskRef[];
}) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId: record.id,
      agentKey: record.agentKey,
      status: record.status,
      summary: record.summary,
      costUsd: record.costUsd,
      linearTasks: record.linearTasks,
    }),
  }).catch((err) => {
    console.error(`webhook delivery failed for run ${record.id}:`, err instanceof Error ? err.message : err);
  });
}

/**
 * Drives a run to completion against an already-existing record — used both
 * by startCeoRun/startSpecialistRun below (a freshly created record) and by
 * the HTTP layer's reply endpoint (a reopened, already-existing record being
 * resumed via the SDK's session `resume` option, which this module doesn't
 * otherwise need to know about).
 */
export function startRun(record: { id: string }, run: () => Promise<{ linearTasks: LinearTaskRef[]; sessionId?: string }>) {
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
    .finally(() => {
      finishRun(record.id);
      const finished = getRun(record.id);
      if (finished) notifyWebhook(finished);
    });
}

/**
 * Starts a CEO run and returns immediately with the (still-running) record —
 * the run itself continues asynchronously via `startRun` above, updating the
 * record's events/status in the store as it goes. `displayGoal` is what's
 * shown in the UI (run header, history list); `promptText` is what the agent
 * actually receives, which may carry more than the display goal (e.g. an
 * attachment's text, appended by the HTTP layer's `buildPrompt`).
 */
export function startCeoRun(displayGoal: string, promptText: string) {
  const record = createRun(displayGoal, "ceo");
  startRun(record, () => runCeoAgent(promptText, (event) => appendEvent(record.id, event)));
  return record;
}

/** Same as `startCeoRun`, but runs one specialist directly, bypassing the CEO. */
export function startSpecialistRun(agentKey: string, displayGoal: string, promptText: string) {
  const record = createRun(displayGoal, agentKey);
  startRun(record, () => runSpecialistAgent(agentKey, promptText, (event) => appendEvent(record.id, event)));
  return record;
}
