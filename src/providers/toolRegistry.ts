import type { ToolDef } from "./toolAdapter.js";
import { LINEAR_TOOL_DEFS } from "../tools/linear.js";
import { SCHEDULER_TOOL_DEFS } from "../tools/scheduler.js";
import { CRM_TOOL_DEFS } from "../tools/crm.js";
import { PLAYBOOK_TOOL_DEFS } from "../tools/playbook.js";
import { PORTFOLIO_TOOL_DEFS } from "../tools/portfolio.js";
import { MEMORY_TOOL_DEFS } from "../tools/memory.js";
import { GMAIL_TOOL_DEFS, isGmailConnected } from "../tools/gmail.js";
import { SES_TOOL_DEFS, isSesConnected } from "../tools/ses.js";
import { INSTAGRAM_TOOL_DEFS, isInstagramConnected } from "../tools/instagram.js";
import { LINKEDIN_TOOL_DEFS, isLinkedinConnected } from "../tools/linkedin.js";
import { FACEBOOK_TOOL_DEFS, isFacebookConnected } from "../tools/facebook.js";
import { ZERNIO_TOOL_DEFS, isZernioConnected } from "../tools/zernio.js";
import { POSTIZ_TOOL_DEFS, isPostizConnected } from "../tools/postiz.js";
import { SCRAPEGRAPH_TOOL_DEFS, isScrapegraphConnected } from "../tools/scrapegraph.js";
import { HUNTER_TOOL_DEFS, isHunterConnected } from "../tools/hunter.js";
import { CANVA_TOOL_DEFS, isCanvaConnected } from "../tools/canva.js";
import { WHATSAPP_TOOL_DEFS, isWhatsappConnected } from "../tools/whatsapp.js";
import { N8N_TOOL_DEFS, isN8nConnected } from "../tools/n8n.js";
import { IMAGE_GEN_TOOL_DEFS, isImageGenAvailable } from "../tools/image-gen.js";
import { VIDEO_GEN_TOOL_DEFS, isHiggsfieldConfigured } from "../tools/higgsfield.js";
import { POST_IMAGES_TOOL_DEFS } from "../tools/post-images.js";
import { REDDIT_TOOL_DEFS, isRedditConnected } from "../tools/reddit.js";
import { remoteToolGroups } from "../tools/remoteMcp.js";
import { documentToolDefs } from "../agents.js";

/**
 * Claude Agent SDK built-ins with no adapter target — implemented inside the
 * SDK's own subprocess (sandboxed fs/shell, hosted web search), not as an
 * MCP tool this repo defines. Per the "degrade honestly" decision: the
 * fallback loop omits these from a specialist's tool set rather than faking
 * them, and the specialist's prompt gets one line telling it to say so
 * plainly when a task needs one of these and can't proceed.
 */
export const UNAVAILABLE_BUILTIN_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
]);

/**
 * Maps every MCP tool name (e.g. "mcp__linear__create_linear_task") to its
 * provider-agnostic descriptor, across every tool file — mirrors
 * buildMcpServers() in orchestrator.ts exactly (same servers, same
 * isXConnected() gating), so a specialist's `tools` array (a flat list of
 * MCP + built-in names from agents.ts) can be resolved into AI SDK tools for
 * the fallback loop the same way it resolves into MCP servers for Claude.
 * Rebuilt per call (like buildMcpServers()) so connection-gated tools
 * reflect current state.
 */
export function buildToolDefRegistry(): Map<string, ToolDef> {
  const groups: Array<{ server: string; defs: ToolDef[] }> = [
    { server: "linear", defs: LINEAR_TOOL_DEFS },
    { server: "documents", defs: documentToolDefs },
    { server: "scheduler", defs: SCHEDULER_TOOL_DEFS },
    { server: "crm", defs: CRM_TOOL_DEFS },
    { server: "playbook", defs: PLAYBOOK_TOOL_DEFS },
    { server: "portfolio", defs: PORTFOLIO_TOOL_DEFS },
    { server: "memory", defs: MEMORY_TOOL_DEFS },
    ...(isGmailConnected() ? [{ server: "gmail", defs: GMAIL_TOOL_DEFS }] : []),
    ...(isSesConnected() ? [{ server: "ses", defs: SES_TOOL_DEFS }] : []),
    ...(isInstagramConnected() ? [{ server: "instagram", defs: INSTAGRAM_TOOL_DEFS }] : []),
    ...(isLinkedinConnected() ? [{ server: "linkedin", defs: LINKEDIN_TOOL_DEFS }] : []),
    ...(isFacebookConnected() ? [{ server: "facebook", defs: FACEBOOK_TOOL_DEFS }] : []),
    ...(isZernioConnected() ? [{ server: "zernio", defs: ZERNIO_TOOL_DEFS }] : []),
    ...(isPostizConnected() ? [{ server: "postiz", defs: POSTIZ_TOOL_DEFS }] : []),
    ...(isScrapegraphConnected() ? [{ server: "scrapegraph", defs: SCRAPEGRAPH_TOOL_DEFS }] : []),
    ...(isHunterConnected() ? [{ server: "hunter", defs: HUNTER_TOOL_DEFS }] : []),
    ...(isCanvaConnected() ? [{ server: "canva", defs: CANVA_TOOL_DEFS }] : []),
    ...(isWhatsappConnected() ? [{ server: "whatsapp", defs: WHATSAPP_TOOL_DEFS }] : []),
    ...(isN8nConnected() ? [{ server: "n8n", defs: N8N_TOOL_DEFS }] : []),
    ...(isImageGenAvailable() ? [{ server: "image_gen", defs: IMAGE_GEN_TOOL_DEFS }] : []),
    ...(isHiggsfieldConfigured() ? [{ server: "video_gen", defs: VIDEO_GEN_TOOL_DEFS }] : []),
    ...(isZernioConnected() ? [{ server: "post_images", defs: POST_IMAGES_TOOL_DEFS }] : []),
    ...(isRedditConnected() ? [{ server: "reddit", defs: REDDIT_TOOL_DEFS }] : []),
    ...remoteToolGroups(),
  ];

  const registry = new Map<string, ToolDef>();
  for (const { server, defs } of groups) {
    for (const def of defs) registry.set(`mcp__${server}__${def.name}`, def);
  }
  return registry;
}

/**
 * Resolves a specialist's (or the CEO's) flat `tools` name list — a mix of
 * MCP names and Claude built-ins — into AI SDK tool descriptors, dropping
 * unavailable built-ins (see UNAVAILABLE_BUILTIN_TOOLS) and any name that
 * doesn't resolve (e.g. the SDK-native "Agent" tool, replaced by
 * fallbackAgent.ts's own delegate_to_specialist). Returns which built-ins
 * had to be dropped so the caller can tell the model about the gap.
 */
export function resolveToolDefs(
  toolNames: string[],
  registry: Map<string, ToolDef>,
): { defs: ToolDef[]; droppedBuiltins: string[] } {
  const defs: ToolDef[] = [];
  const droppedBuiltins: string[] = [];
  for (const name of toolNames) {
    if (UNAVAILABLE_BUILTIN_TOOLS.has(name)) {
      droppedBuiltins.push(name);
      continue;
    }
    const def = registry.get(name);
    if (def) defs.push(def);
  }
  return { defs, droppedBuiltins };
}
