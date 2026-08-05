import { query } from "@anthropic-ai/claude-agent-sdk";
import { linearServer, LINEAR_TOOLS } from "./tools/linear.js";
import { gmailServer, GMAIL_TOOLS, isGmailConnected } from "./tools/gmail.js";
import { instagramServer, INSTAGRAM_TOOLS, isInstagramConnected } from "./tools/instagram.js";
import { DEPARTMENTS, buildAgentsRegistry, documentsServer, allSpecialistToolNames } from "./agents.js";
import { WORKSPACE_DIR } from "./workspace.js";

export { WORKSPACE_DIR };

function rosterDescription(): string {
  return DEPARTMENTS.map((d) => `- ${d.key} (${d.label}): ${d.tagline}`).join("\n");
}

const CEO_SYSTEM_PROMPT = `You are the CEO agent of a small automated organization.

You receive a goal or signal (from an email, a request, or a direct instruction) and your job is to:
1. Analyze it: understand what outcome is actually needed.
2. Decide whether it needs delegation, and to whom. You can delegate to any of these specialists via the Agent tool (subagent_type):
${rosterDescription()}
3. Give whoever you delegate to a clear, concrete brief — not a vague summary. You can delegate to more than one specialist for a single goal if it genuinely spans departments.
4. Do not do specialists' work yourself (don't create Linear tasks, don't write code, don't draft documents) — that's what delegation is for. Your job is analysis, delegation, and reporting.
5. After delegating, summarize back to the user: what was decided, who you delegated to, and what they reported. If a specialist hit a blocker (e.g. a tool isn't configured), say so honestly rather than claiming success.

Be decisive. Do not ask clarifying questions unless the goal is genuinely ambiguous about scope or priority.`;

function buildMcpServers() {
  return {
    linear: linearServer,
    documents: documentsServer,
    ...(isGmailConnected() ? { gmail: gmailServer } : {}),
    ...(isInstagramConnected() ? { instagram: instagramServer } : {}),
  };
}

function allToolNames(): string[] {
  const names = new Set<string>(["Agent", ...LINEAR_TOOLS, ...allSpecialistToolNames()]);
  if (isGmailConnected()) for (const t of GMAIL_TOOLS) names.add(t);
  if (isInstagramConnected()) for (const t of INSTAGRAM_TOOLS) names.add(t);
  return [...names];
}

/**
 * The `tools` option is a session-wide ceiling on *built-in* tool
 * availability — not just for the main thread, but for every subagent too,
 * regardless of what that subagent's own AgentDefinition.tools lists. MCP
 * tools (prefixed "mcp__") are a separate namespace, gated only by
 * mcpServers registration, so they're excluded here (session-wide
 * availability doesn't need to name them).
 */
function builtinToolNames(): string[] {
  return [...new Set(["Agent", ...allSpecialistToolNames()])].filter((t) => !t.startsWith("mcp__"));
}

export type RunSource = string;

export type RunEvent =
  | { type: "text"; source: RunSource; text: string; ts: string }
  | { type: "tool_use"; source: RunSource; name: string; input: unknown; toolUseId: string; ts: string }
  | { type: "tool_result"; toolUseId: string; text: string; isError: boolean; ts: string }
  | { type: "done"; status: "success" | "error"; summary?: string; error?: string; costUsd: number; ts: string };

export interface LinearTaskRef {
  identifier: string;
  title: string;
  url: string;
}

function extractLinearTask(text: string): LinearTaskRef | null {
  const match = text.match(/^Created (\S+): (.+?)\n(https?:\/\/\S+)/);
  if (!match) return null;
  return { identifier: match[1], title: match[2], url: match[3] };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

async function drainQuery(
  stream: AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKMessage>,
  defaultSource: RunSource,
  onEvent: (event: RunEvent) => void,
): Promise<{
  status: "success" | "error";
  summary?: string;
  costUsd: number;
  linearTasks: LinearTaskRef[];
  sessionId?: string;
}> {
  const linearTasks: LinearTaskRef[] = [];
  let finalCost = 0;
  let finalStatus: "success" | "error" = "success";
  let finalSummary: string | undefined;
  let sessionId: string | undefined;

  for await (const message of stream) {
    const ts = new Date().toISOString();
    if (!sessionId && "session_id" in message && typeof message.session_id === "string") {
      sessionId = message.session_id;
    }

    if (message.type === "assistant") {
      const source: RunSource = message.subagent_type ?? defaultSource;
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          onEvent({ type: "text", source, text: block.text, ts });
        } else if (block.type === "tool_use") {
          onEvent({ type: "tool_use", source, name: block.name, input: block.input, toolUseId: block.id, ts });
        }
      }
    } else if (message.type === "user") {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const text = toolResultText(block.content);
            const isError = block.is_error ?? false;
            onEvent({ type: "tool_result", toolUseId: block.tool_use_id, text, isError, ts });
            if (!isError) {
              const task = extractLinearTask(text);
              if (task) linearTasks.push(task);
            }
          }
        }
      }
    } else if (message.type === "result") {
      finalCost = message.total_cost_usd;
      if (message.subtype === "success") {
        finalStatus = "success";
        finalSummary = message.result;
      } else {
        finalStatus = "error";
        finalSummary = message.errors.join("; ");
      }
      onEvent({
        type: "done",
        status: finalStatus,
        summary: finalStatus === "success" ? finalSummary : undefined,
        error: finalStatus === "error" ? finalSummary : undefined,
        costUsd: finalCost,
        ts,
      });
    }
  }

  return { status: finalStatus, summary: finalSummary, costUsd: finalCost, linearTasks, sessionId };
}

/**
 * Runs the CEO agent, which analyzes the goal and delegates to whichever
 * specialists fit. Pass `resumeSessionId` (from a prior run's returned
 * `sessionId`) to continue that same conversation — e.g. when the CEO asked
 * a clarifying question and the user is now answering it — rather than
 * starting fresh with no memory of the earlier exchange.
 */
export async function runCeoAgent(goal: string, onEvent: (event: RunEvent) => void, resumeSessionId?: string) {
  const stream = query({
    prompt: goal,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: CEO_SYSTEM_PROMPT },
      cwd: WORKSPACE_DIR,
      mcpServers: buildMcpServers(),
      agents: buildAgentsRegistry(),
      // `tools` is a session-wide ceiling, not just the CEO's own toolset — it
      // has to include every built-in a subagent might need (Bash, WebSearch,
      // etc.) or delegated work silently loses access to them. The CEO itself
      // is kept off them by its system prompt, not tool availability; the real
      // backstop is `cwd: WORKSPACE_DIR` above, which confines any file/shell
      // access — CEO's own or a subagent's — to a throwaway sandbox, never
      // this app's own source.
      tools: builtinToolNames(),
      allowedTools: allToolNames(),
      permissionMode: "dontAsk",
      maxTurns: 20,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  return drainQuery(stream, "ceo", onEvent);
}

/** Runs one specialist directly (bypassing the CEO), for department-page "ask this agent" input. */
export async function runSpecialistAgent(
  agentKey: string,
  goal: string,
  onEvent: (event: RunEvent) => void,
  resumeSessionId?: string,
) {
  const registry = buildAgentsRegistry();
  const agent = registry[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const stream = query({
    prompt: goal,
    options: {
      agent: agentKey,
      cwd: WORKSPACE_DIR,
      mcpServers: buildMcpServers(),
      agents: registry,
      tools: agent.tools ?? [],
      allowedTools: agent.tools ?? [],
      permissionMode: "dontAsk",
      maxTurns: 20,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  return drainQuery(stream, agentKey, onEvent);
}
