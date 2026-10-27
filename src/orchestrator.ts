import { query, type HookCallback, type HookCallbackMatcher, type HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { linearServer, LINEAR_TOOLS } from "./tools/linear.js";
import { gmailServer, GMAIL_TOOLS, isGmailConnected } from "./tools/gmail.js";
import { sesServer, SES_TOOLS, isSesConnected } from "./tools/ses.js";
import { instagramServer, INSTAGRAM_TOOLS, isInstagramConnected } from "./tools/instagram.js";
import { linkedinServer, LINKEDIN_TOOLS, isLinkedinConnected } from "./tools/linkedin.js";
import { facebookServer, FACEBOOK_TOOLS, isFacebookConnected } from "./tools/facebook.js";
import { zernioServer, ZERNIO_TOOLS, isZernioConnected } from "./tools/zernio.js";
import { postizServer, POSTIZ_TOOLS, isPostizConnected } from "./tools/postiz.js";
import { scrapegraphServer, SCRAPEGRAPH_TOOLS, isScrapegraphConnected } from "./tools/scrapegraph.js";
import { hunterServer, HUNTER_TOOLS, isHunterConnected } from "./tools/hunter.js";
import { canvaServer, CANVA_TOOLS, isCanvaConnected } from "./tools/canva.js";
import { whatsappServer, WHATSAPP_TOOLS, isWhatsappConnected } from "./tools/whatsapp.js";
import { n8nServer, N8N_TOOLS, isN8nConnected } from "./tools/n8n.js";
import { imageGenServer, IMAGE_GEN_TOOLS, isImageGenAvailable } from "./tools/image-gen.js";
import { videoGenServer, VIDEO_GEN_TOOLS, isHiggsfieldConfigured } from "./tools/higgsfield.js";
import { postImagesServer, POST_IMAGES_TOOLS } from "./tools/post-images.js";
import { schedulerServer } from "./tools/scheduler.js";
import { redditServer, REDDIT_TOOLS, isRedditConnected } from "./tools/reddit.js";
import { crmServer } from "./tools/crm.js";
import { playbookServer } from "./tools/playbook.js";
import { portfolioServer } from "./tools/portfolio.js";
import { memoryServer } from "./tools/memory.js";
import { DEPARTMENTS, buildAgentsRegistry, documentsServer, allSpecialistToolNames } from "./agents.js";
import { getWorkspaceDir } from "./workspace.js";
import { DEVELOPER_INFO_BLOCK } from "./developer/index.js";
import { workspaceGuardHook } from "./agentSandbox.js";
import { getEnvValue } from "./server/settings.js";

export { getWorkspaceDir };

function rosterDescription(): string {
  return DEPARTMENTS.map((d) => `- ${d.key} (${d.label}): ${d.tagline}`).join("\n");
}

// The Agent tool's `run_in_background` defaults to true in the SDK. Every
// traced instance of a delegated specialist's tool results silently coming
// back empty (see CEO_SYSTEM_PROMPT rules 9/10) turned out to share one
// cause: the delegating call omitted run_in_background: false, so the SDK
// backgrounded it — and this app has no reliable way to recover a
// backgrounded subagent's own nested MCP tool results, only its final
// summary (if that even arrives before the parent turn moves on). The CEO's
// prompt already asks it to always pass false, but that's prose competing
// with a long system prompt, and it's already been observed to get dropped
// under load. Enforcing it structurally here — rewriting the tool call
// before it runs — is the only version of this that actually holds every
// time, regardless of what the model remembers to type.
const forceSynchronousDelegation: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Agent") return {};
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  if (toolInput.run_in_background === false) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, run_in_background: false },
    },
  };
};

// Built per run so the workspace guard is bound to this run's tenant
// workspace (see agentSandbox.ts for why `cwd` alone isn't a sandbox).
function agentHooks(workspaceDir: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [workspaceGuardHook(workspaceDir), forceSynchronousDelegation] }],
  };
}

const CEO_SYSTEM_PROMPT = `You are the CEO agent of a small automated organization.

You receive a goal or signal (from an email, a request, or a direct instruction) and your job is to:
1. Analyze it: understand what outcome is actually needed.
2. Check the system's permanent memory (list_memory_entries, optionally filtered by a query matching the goal's topic — get_memory_entry for the full text of anything relevant) for established context that bears on this goal: standing instructions, policies, key contacts, prior decisions, anything that shouldn't need repeating. Fold whatever's relevant into your own analysis and into the brief you hand off in step 4, rather than making a specialist rediscover it or you proceeding without it. Skip only when the goal is obviously self-contained and unlikely to depend on anything durable.
3. Decide whether it needs delegation, and to whom. You can delegate to any of these specialists via the Agent tool (subagent_type):
${rosterDescription()}
4. Give whoever you delegate to a clear, concrete brief — not a vague summary. You can delegate to more than one specialist for a single goal if it genuinely spans departments.
5. Do not do specialists' work yourself (don't create Linear tasks, don't write code, don't draft documents) — that's what delegation is for. Your job is analysis, delegation, and reporting. (Exception: rule 10.)
6. Always call the Agent tool with run_in_background: false. Backgrounding a delegation doesn't save any time here — this app already waits for the full run before reporting back — and specialists' tool calls (Linear, documents, etc.) are unreliable when run in the background, silently returning empty results even though nothing actually failed. Only synchronous delegation gets a trustworthy result.
7. If n8n workflow tools are available, you (not a specialist) are the one who triggers cross-cutting automations (e.g. notifying a channel, updating an external system) once delegated work is done — check list_n8n_workflows for what's available before assuming one exists. Don't invent a workflow name; only ever trigger ones that tool actually lists.
8. After delegating (and triggering any relevant automation), summarize back to the user: what was decided, who you delegated to, and what they reported. If a specialist hit a blocker (e.g. a tool isn't configured), say so honestly rather than claiming success.
9. When a specialist reports having sent, posted, or messaged something, only relay that as confirmed if their report cites a concrete identifier (a message ID, post ID) — a report of success with no identifier is not confirmed, and you must say so plainly (e.g. "reported as sent, but I can't confirm — no message ID came back") rather than repeating the claim as fact. This app has a known issue where a delegated specialist's tool result can go missing in transit, causing it to report success it never actually verified.
10. If a delegated specialist's tool calls come back completely empty ("completed with no output") for more than one call in a row — especially if any of those calls needed no external service at all (e.g. a local list/read tool, not just an integration like Gmail) — that pattern is rule 9's known result-loss bug, not a real integration failure. In that case: do NOT conclude the integration/credentials are broken, do NOT tell the user to disconnect/reconnect an account that was working before, and do NOT keep retrying via delegation. Instead call the same tool(s) yourself directly — you have the same MCP tools the specialist does, and your own direct calls aren't subject to this bug. Only report a real blocker (and only then suggest reconnecting) if your own direct call fails with an actual error message, not just empty output.

Be decisive. Do not ask clarifying questions unless the goal is genuinely ambiguous about scope or priority.

${DEVELOPER_INFO_BLOCK}`;

function buildMcpServers() {
  return {
    linear: linearServer,
    documents: documentsServer,
    scheduler: schedulerServer,
    crm: crmServer,
    playbook: playbookServer,
    portfolio: portfolioServer,
    memory: memoryServer,
    ...(isGmailConnected() ? { gmail: gmailServer } : {}),
    ...(isSesConnected() ? { ses: sesServer } : {}),
    ...(isInstagramConnected() ? { instagram: instagramServer } : {}),
    ...(isLinkedinConnected() ? { linkedin: linkedinServer } : {}),
    ...(isFacebookConnected() ? { facebook: facebookServer } : {}),
    ...(isZernioConnected() ? { zernio: zernioServer } : {}),
    ...(isPostizConnected() ? { postiz: postizServer } : {}),
    ...(isScrapegraphConnected() ? { scrapegraph: scrapegraphServer } : {}),
    ...(isHunterConnected() ? { hunter: hunterServer } : {}),
    ...(isCanvaConnected() ? { canva: canvaServer } : {}),
    ...(isWhatsappConnected() ? { whatsapp: whatsappServer } : {}),
    ...(isN8nConnected() ? { n8n: n8nServer } : {}),
    ...(isImageGenAvailable() ? { image_gen: imageGenServer } : {}),
    ...(isHiggsfieldConfigured() ? { video_gen: videoGenServer } : {}),
    ...(isZernioConnected() ? { post_images: postImagesServer } : {}),
    ...(isRedditConnected() ? { reddit: redditServer } : {}),
  };
}

function allToolNames(): string[] {
  const names = new Set<string>(["Agent", ...LINEAR_TOOLS, ...allSpecialistToolNames()]);
  if (isGmailConnected()) for (const t of GMAIL_TOOLS) names.add(t);
  if (isSesConnected()) for (const t of SES_TOOLS) names.add(t);
  if (isInstagramConnected()) for (const t of INSTAGRAM_TOOLS) names.add(t);
  if (isLinkedinConnected()) for (const t of LINKEDIN_TOOLS) names.add(t);
  if (isFacebookConnected()) for (const t of FACEBOOK_TOOLS) names.add(t);
  if (isZernioConnected()) for (const t of ZERNIO_TOOLS) names.add(t);
  if (isPostizConnected()) for (const t of POSTIZ_TOOLS) names.add(t);
  if (isScrapegraphConnected()) for (const t of SCRAPEGRAPH_TOOLS) names.add(t);
  if (isHunterConnected()) for (const t of HUNTER_TOOLS) names.add(t);
  if (isCanvaConnected()) for (const t of CANVA_TOOLS) names.add(t);
  if (isWhatsappConnected()) for (const t of WHATSAPP_TOOLS) names.add(t);
  if (isN8nConnected()) for (const t of N8N_TOOLS) names.add(t);
  if (isImageGenAvailable()) for (const t of IMAGE_GEN_TOOLS) names.add(t);
  if (isHiggsfieldConfigured()) for (const t of VIDEO_GEN_TOOLS) names.add(t);
  if (isZernioConnected()) for (const t of POST_IMAGES_TOOLS) names.add(t);
  if (isRedditConnected()) for (const t of REDDIT_TOOLS) names.add(t);
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

export function extractLinearTask(text: string): LinearTaskRef | null {
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
  // task_id -> subagent_type, from 'task_started' — lets a later
  // 'task_notification' attribute its summary to the right department
  // instead of falling back to defaultSource (usually "ceo").
  const taskSources = new Map<string, string>();

  for await (const message of stream) {
    const ts = new Date().toISOString();
    if (!sessionId && "session_id" in message && typeof message.session_id === "string") {
      sessionId = message.session_id;
    }

    if (message.type === "system" && message.subtype === "task_started") {
      if (message.subagent_type) taskSources.set(message.task_id, message.subagent_type);
    } else if (message.type === "system" && message.subtype === "task_notification") {
      // The SDK can silently background a subagent/tool call: the caller gets
      // an immediate "running in the background" placeholder instead of the
      // real result, and the actual outcome only ever arrives as this event.
      // Without handling it, that outcome — including any Linear tasks a
      // backgrounded Manager run actually created — is lost for good, even
      // though the model believes (and reports) that the call succeeded.
      const source: RunSource = taskSources.get(message.task_id) ?? defaultSource;
      const prefix = message.status === "completed" ? "" : `[background task ${message.status}] `;
      onEvent({ type: "text", source, text: `${prefix}${message.summary}`, ts });
      const task = extractLinearTask(message.summary);
      if (task) linearTasks.push(task);
    } else if (message.type === "assistant") {
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
 * Env for the Claude Code subprocess. It authenticates with ANTHROPIC_API_KEY
 * when set (the deployed server has no `claude login`); resolving it through
 * getEnvValue also honours a key the org saved in Settings.
 */
// Pinned so the deployed server bills Sonnet rates, not whatever Claude Code defaults to.
const AGENT_MODEL = process.env.CEO_AGENT_MODEL?.trim() || "claude-sonnet-5-5";

function claudeSubprocessEnv(): Record<string, string | undefined> {
  const apiKey = getEnvValue("ANTHROPIC_API_KEY")?.trim();
  return apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : { ...process.env };
}

/**
 * Runs the CEO agent, which analyzes the goal and delegates to whichever
 * specialists fit. Pass `resumeSessionId` (from a prior run's returned
 * `sessionId`) to continue that same conversation — e.g. when the CEO asked
 * a clarifying question and the user is now answering it — rather than
 * starting fresh with no memory of the earlier exchange.
 */
export async function runCeoAgent(
  goal: string,
  onEvent: (event: RunEvent) => void,
  resumeSessionId?: string,
  abortController?: AbortController,
) {
  const workspaceDir = getWorkspaceDir();
  const stream = query({
    prompt: goal,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: CEO_SYSTEM_PROMPT },
      cwd: workspaceDir,
      env: claudeSubprocessEnv(),
      model: AGENT_MODEL,
      mcpServers: buildMcpServers(),
      agents: buildAgentsRegistry(),
      // `tools` is a session-wide ceiling, not just the CEO's own toolset — it
      // has to include every built-in a subagent might need (Bash, WebSearch,
      // etc.) or delegated work silently loses access to them. The CEO itself
      // is kept off them by its system prompt, not tool availability. `cwd`
      // is NOT a sandbox on its own — agentHooks' workspace guard is what
      // keeps file tools inside it, and Bash is only in this list at all
      // when ALLOW_AGENT_SHELL=true (see agentSandbox.ts).
      tools: builtinToolNames(),
      allowedTools: allToolNames(),
      permissionMode: "dontAsk",
      maxTurns: 20,
      hooks: agentHooks(workspaceDir),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(abortController ? { abortController } : {}),
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
  abortController?: AbortController,
) {
  const registry = buildAgentsRegistry();
  const agent = registry[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const workspaceDir = getWorkspaceDir();
  const stream = query({
    prompt: goal,
    options: {
      agent: agentKey,
      cwd: workspaceDir,
      env: claudeSubprocessEnv(),
      model: AGENT_MODEL,
      mcpServers: buildMcpServers(),
      agents: registry,
      tools: agent.tools ?? [],
      allowedTools: agent.tools ?? [],
      permissionMode: "dontAsk",
      maxTurns: 20,
      hooks: agentHooks(workspaceDir),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(abortController ? { abortController } : {}),
    },
  });

  return drainQuery(stream, agentKey, onEvent);
}
