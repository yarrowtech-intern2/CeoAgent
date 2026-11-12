import { runCeoAgent, runSpecialistAgent, type RunEvent, type RunSource } from "../orchestrator.js";
import { runCeoAgentFallback, runSpecialistAgentFallback, isFallbackProviderConfigured, type FallbackRunResult } from "./fallbackAgent.js";
import { runCeoAgentCodex, runSpecialistAgentCodex } from "./codexAgent.js";
import {
  isClaudeExhaustionThrow,
  isClaudeExhaustionResult,
  isOpenAiExhaustionError,
  isDeepSeekExhaustionError,
  isOllamaExhaustionError,
  isCodexExhaustionError,
} from "./exhaustionClassifier.js";
import { parseSessionId, type FallbackProviderName } from "./sessionStore.js";
import { isAgentShellAllowed } from "../agentSandbox.js";
import { refreshRemoteTools } from "../tools/remoteMcp.js";

export type ProviderName = "claude" | FallbackProviderName;
/** "auto" = today's cascade behavior; anything else is a manual, no-fallback pin to that one provider. */
export type LlmProviderChoice = "auto" | ProviderName;

// Codex sits right after Claude: like Claude, it's a full agentic CLI that
// can run from local CLI login alone (no API key required), unlike the
// openai/deepseek/ollama links below it, which are plain chat-completion
// fallbacks that always need an explicit key/URL.
export const PROVIDER_ORDER: ProviderName[] = ["claude", "codex", "openai", "deepseek", "ollama"];
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  ollama: "Ollama (local)",
};

export function isValidProviderChoice(value: string): value is LlmProviderChoice {
  return value === "auto" || PROVIDER_ORDER.includes(value as ProviderName);
}

function isExhaustionError(provider: ProviderName, err: unknown): boolean {
  if (provider === "claude") return isClaudeExhaustionThrow(err);
  if (provider === "codex") return isCodexExhaustionError(err);
  if (provider === "openai") return isOpenAiExhaustionError(err);
  if (provider === "deepseek") return isDeepSeekExhaustionError(err);
  return isOllamaExhaustionError(err);
}

// Codex, like Claude, can work from local CLI login alone — never gated on
// an explicit key being present the way the plain chat-completion fallbacks
// below it are (see isFallbackProviderConfigured).
// Codex's CLI always has a shell that can read outside its workspace, so on
// servers without ALLOW_AGENT_SHELL it's treated as unavailable (see
// agentSandbox.ts) — the cascade skips straight to the next provider.
function isConfigured(provider: ProviderName): boolean {
  if (provider === "codex") return isAgentShellAllowed();
  return provider === "claude" || isFallbackProviderConfigured(provider);
}

interface RunWithFallbackOpts {
  source: RunSource;
  resumeSessionId?: string;
  onEvent: (event: RunEvent) => void;
  run: (provider: ProviderName, resumeSessionId?: string) => Promise<FallbackRunResult>;
  /** A specific provider the user picked from the model dropdown — no cascade, no fallback if it fails. Omit/undefined for today's automatic cascade. */
  forcedProvider?: ProviderName;
  /** When the user clicks Stop mid-run, cascading to the next provider would be exactly wrong — a deliberate cancellation must surface as cancelled, not as "that provider was unavailable, trying another one." */
  abortController?: AbortController;
}

/**
 * Tries Claude -> OpenAI -> DeepSeek -> Ollama in order, cascading to the
 * next provider only on a classified exhaustion error (rate limit, quota,
 * billing, auth failure, overload) — a non-exhaustion error (a malformed
 * request, an unsupported model) is surfaced immediately instead of being
 * masked by a confusing provider switch. Stateless: every fresh run starts
 * back at Claude, so the app self-heals once Claude recovers rather than
 * needing a manual reset. Resuming an existing fallback-provider session
 * (sessionId prefixed "fallback:<provider>:") skips straight to that one
 * provider — cross-provider context transplant isn't attempted, so a
 * mid-conversation cascade means a reply starts a fresh conversation on
 * whichever provider picks it up.
 *
 * When `forcedProvider` is set (the user picked a specific model from the
 * dropdown instead of "Auto"), all of that is bypassed: only that one
 * provider is tried, and any failure — exhaustion or not — surfaces
 * directly, since a deliberate model pick shouldn't silently run on a
 * different model than the one chosen.
 */
async function runWithFallback(opts: RunWithFallbackOpts): Promise<FallbackRunResult> {
  // Every provider path builds its tool list synchronously, so the connected
  // remote (MCP) systems' tools are discovered once here, before any of them.
  await refreshRemoteTools();

  if (opts.forcedProvider) {
    if (!isConfigured(opts.forcedProvider)) {
      if (opts.forcedProvider === "codex") {
        throw new Error("Codex is disabled on this server (it needs shell access, which ALLOW_AGENT_SHELL turns on for trusted single-user installs).");
      }
      throw new Error(`${PROVIDER_LABELS[opts.forcedProvider]} is not configured.`);
    }
    return opts.run(opts.forcedProvider, opts.resumeSessionId);
  }

  const resumedProvider = opts.resumeSessionId ? parseSessionId(opts.resumeSessionId)?.provider : undefined;
  const order: ProviderName[] = resumedProvider ? [resumedProvider] : PROVIDER_ORDER;

  const emitSwitch = (provider: ProviderName, message: string) => {
    const next = PROVIDER_ORDER[PROVIDER_ORDER.indexOf(provider) + 1];
    if (next && !resumedProvider) {
      opts.onEvent({
        type: "text",
        source: opts.source,
        text: `${PROVIDER_LABELS[provider]} is unavailable right now (${message}) — switching to ${PROVIDER_LABELS[next]}.`,
        ts: new Date().toISOString(),
      });
    }
  };

  const errors: string[] = [];
  for (const provider of order) {
    if (!isConfigured(provider)) {
      errors.push(`${PROVIDER_LABELS[provider]}: not configured`);
      continue;
    }
    try {
      const result = await opts.run(provider, opts.resumeSessionId);
      // Claude's SDK can end a stream with a graceful `result: error` message
      // (drainQuery returns it, doesn't throw) — e.g. a mid-stream rate-limit
      // or billing failure that isn't a pre-stream rejection. Without this
      // check, that case would return an unrecovered failure straight to the
      // caller instead of cascading, even though it's exactly the kind of
      // exhaustion the chain exists to route around. Fallback providers
      // (OpenAI/DeepSeek/Ollama) never return gracefully on error — see
      // fallbackAgent.ts, they always throw — so this only applies to Claude.
      if (provider === "claude" && result.status === "error" && isClaudeExhaustionResult([result.summary ?? ""])) {
        const message = result.summary ?? "unknown error";
        errors.push(`${PROVIDER_LABELS[provider]}: ${message}`);
        emitSwitch(provider, message);
        continue;
      }
      return result;
    } catch (err) {
      if (opts.abortController?.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isExhaustionError(provider, err)) throw err;
      errors.push(`${PROVIDER_LABELS[provider]}: ${message}`);
      emitSwitch(provider, message);
    }
  }
  throw new Error(`All LLM providers are currently unavailable:\n${errors.join("\n")}`);
}

export function runCeoAgentWithFallback(
  goal: string,
  onEvent: (event: RunEvent) => void,
  resumeSessionId?: string,
  provider: LlmProviderChoice = "auto",
  abortController?: AbortController,
): Promise<FallbackRunResult> {
  return runWithFallback({
    source: "ceo",
    resumeSessionId,
    onEvent,
    abortController,
    forcedProvider: provider === "auto" ? undefined : provider,
    run: (p, resume) => {
      if (p === "claude") return runCeoAgent(goal, onEvent, resume, abortController);
      if (p === "codex") return runCeoAgentCodex(goal, onEvent, resume, abortController);
      return runCeoAgentFallback(p, goal, onEvent, resume, abortController);
    },
  });
}

export function runSpecialistAgentWithFallback(
  agentKey: string,
  goal: string,
  onEvent: (event: RunEvent) => void,
  resumeSessionId?: string,
  provider: LlmProviderChoice = "auto",
  abortController?: AbortController,
): Promise<FallbackRunResult> {
  return runWithFallback({
    source: agentKey,
    resumeSessionId,
    onEvent,
    abortController,
    forcedProvider: provider === "auto" ? undefined : provider,
    run: (p, resume) => {
      if (p === "claude") return runSpecialistAgent(agentKey, goal, onEvent, resume, abortController);
      if (p === "codex") return runSpecialistAgentCodex(agentKey, goal, onEvent, resume, abortController);
      return runSpecialistAgentFallback(p, agentKey, goal, onEvent, resume, abortController);
    },
  });
}
