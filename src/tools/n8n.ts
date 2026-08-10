import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Deliberately NOT "call any URL the model gives you" — that would make this
// tool an open SSRF vector for whatever an agent gets talked into (a
// prompt-injected email body, a hostile document, etc.) to hit. Instead the
// set of callable workflows is a fixed, admin-configured allowlist: N8N_WORKFLOWS
// in .env maps a short name to a webhook URL, and the tool only ever accepts
// one of those names — never a raw URL — as input.
function loadWorkflows(): Record<string, string> {
  const raw = process.env.N8N_WORKFLOWS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function isN8nConnected(): boolean {
  return Object.keys(loadWorkflows()).length > 0;
}

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 2000;

async function postToN8n(url: string, payload: Record<string, unknown>): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    const truncated =
      bodyText.length > MAX_RESPONSE_CHARS ? `${bodyText.slice(0, MAX_RESPONSE_CHARS)}... (truncated)` : bodyText;
    if (!res.ok) {
      throw new Error(`n8n webhook returned ${res.status}: ${truncated || "(empty body)"}`);
    }
    return truncated || "(empty response body)";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`n8n workflow did not respond within ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

const listN8nWorkflows = tool(
  "list_n8n_workflows",
  "List the n8n workflows available to trigger, by name. Use this first to see valid names for trigger_n8n_workflow — the tool only accepts names from this list, not arbitrary URLs.",
  {},
  async () => {
    const names = Object.keys(loadWorkflows());
    if (!names.length) {
      return {
        content: [{ type: "text" as const, text: "No n8n workflows configured — set N8N_WORKFLOWS in .env." }],
      };
    }
    return { content: [{ type: "text" as const, text: names.map((n) => `- ${n}`).join("\n") }] };
  },
);

const triggerN8nWorkflow = tool(
  "trigger_n8n_workflow",
  "Trigger a pre-configured n8n workflow by name, with a JSON payload the workflow can use. Only names from list_n8n_workflows are valid — this cannot call arbitrary URLs. Use for cross-cutting automations (notifications, CRM/sheet updates, etc.) that live in n8n rather than as a tool here.",
  {
    workflow: z.string().describe("Workflow name, from list_n8n_workflows"),
    payload: z.record(z.string(), z.unknown()).optional().describe("JSON payload to send to the workflow"),
  },
  async ({ workflow, payload }) => {
    const workflows = loadWorkflows();
    const url = workflows[workflow];
    if (!url) {
      const available = Object.keys(workflows);
      return {
        content: [
          {
            type: "text" as const,
            text: available.length
              ? `Error: no n8n workflow named "${workflow}". Available: ${available.join(", ")}`
              : `Error: no n8n workflow named "${workflow}", and none are configured (set N8N_WORKFLOWS in .env).`,
          },
        ],
        isError: true,
      };
    }

    try {
      const responseText = await postToN8n(url, payload ?? {});
      return {
        content: [{ type: "text" as const, text: `Triggered "${workflow}". Response: ${responseText}` }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `Error triggering "${workflow}": ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  },
);

export const N8N_TOOLS = ["mcp__n8n__list_n8n_workflows", "mcp__n8n__trigger_n8n_workflow"];

export const n8nServer = createSdkMcpServer({
  name: "n8n",
  version: "1.0.0",
  instructions:
    "Tools for triggering pre-configured n8n automations by name. list_n8n_workflows first to see what's available — trigger_n8n_workflow only accepts those names, never a raw URL.",
  tools: [listN8nWorkflows, triggerN8nWorkflow],
});
