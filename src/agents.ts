import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { LINEAR_TOOLS } from "./tools/linear.js";
import { createDocumentsServer } from "./tools/documents.js";
import { GMAIL_TOOLS, isGmailConnected } from "./tools/gmail.js";
import { LINKEDIN_TOOLS, isLinkedinConnected } from "./tools/linkedin.js";

export interface DepartmentMeta {
  key: string;
  label: string;
  icon: string; // Lucide icon name
  tagline: string;
  /** Categorical accent, one fixed slot per department — never reassigned or
   * cycled (see dataviz skill: identity color follows the entity everywhere,
   * nav badges and charts alike). Validated CVD-safe as an adjacent-order set
   * via scripts/validate_palette.js — light/dark are each mode's own step,
   * not a single hex dimmed. */
  color: { light: string; dark: string };
}

export const DEPARTMENTS: DepartmentMeta[] = [
  { key: "manager", label: "Manager", icon: "list-checks", tagline: "Breaks initiatives into tasks and tracks them in Linear.", color: { light: "#2a78d6", dark: "#3987e5" } },
  { key: "hr", label: "HR", icon: "users", tagline: "Onboarding, policies, job descriptions, people processes.", color: { light: "#eb6834", dark: "#d95926" } },
  { key: "developer", label: "Developer", icon: "code", tagline: "Reads/writes code and runs commands in a sandboxed workspace.", color: { light: "#1baf7a", dark: "#199e70" } },
  { key: "analysis", label: "Analysis", icon: "search", tagline: "Researches and analyzes; produces written reports.", color: { light: "#eda100", dark: "#c98500" } },
  { key: "sales", label: "Sales", icon: "trending-up", tagline: "Drafts outreach, proposals, and pipeline plans.", color: { light: "#e87ba4", dark: "#d55181" } },
  { key: "finance", label: "Finance", icon: "wallet", tagline: "Budgets, expense summaries, financial write-ups.", color: { light: "#008300", dark: "#008300" } },
  { key: "emails", label: "Emails", icon: "mail", tagline: "Reads the connected inbox and drafts/sends email.", color: { light: "#4a3aa7", dark: "#9085e9" } },
];

const DOCUMENT_AGENT_KEYS = ["hr", "analysis", "sales", "finance"];

function docTool(key: string) {
  return `mcp__documents__create_${key}_document`;
}

// `background: false` on every specialist: when the CEO delegates via the
// Agent tool, Claude sometimes runs the subagent as a fire-and-forget
// background task rather than synchronously, and confirmed (by isolating
// agent identity from tool identity with an identical diagnostic tool) that
// a custom MCP tool's result can be silently lost when that happens — the
// model believes the call succeeded and reports so, but the handler's result
// never makes it back, and for tools like create_document that means the
// document never actually persists. This flag is a MITIGATION, not a full
// fix: it makes backgrounding less likely but not impossible, so the failure
// still recurs intermittently (observed ~1-in-3 in testing) even with it
// set. There is no UX cost to setting it (this app already waits for the
// whole run, including any backgrounded continuation, before rendering
// "done" — see store.ts finishRun), so it's worth keeping regardless.
// The reliable path for document-producing specialists (HR/Analysis/Sales/
// Finance) is a DIRECT run from that department's own page, which has been
// 100% consistent in testing — CEO delegation to them should be treated as
// best-effort until this is root-caused further upstream.
const SYNC: Pick<AgentDefinition, "background"> = { background: false };

const managerAgent: AgentDefinition = {
  description:
    "Manager agent. Takes a task or initiative handed off by the CEO agent, breaks it into concrete, assignable sub-tasks, and creates them in Linear. Reports back a summary of what was created.",
  prompt: `You are the Manager agent, reporting to a CEO agent.

When given an initiative or task from the CEO:
1. Break it into concrete, actionable sub-tasks (2-6 tasks is typical — don't over-split).
2. For each sub-task, create a Linear task with a clear title and a description that includes acceptance criteria.
3. Check existing tasks first with list_linear_tasks if the initiative might overlap with in-flight work, to avoid duplicates.
4. Reply with a short summary: what tasks you created (with their Linear identifiers), and any open questions or risks the CEO should know about.

Be concrete. Do not create vague tasks like "look into X" — specify what "done" looks like.`,
  tools: LINEAR_TOOLS,
  ...SYNC,
};

const hrAgent: AgentDefinition = {
  description:
    "HR agent. Handles onboarding checklists, policy questions, job descriptions, and other people-process work. Produces written documents rather than taking real HRIS actions (no HR system is connected).",
  prompt: `You are the HR agent, reporting to a CEO agent. There is no HRIS or people-management system connected — your job is to produce clear, usable written deliverables (checklists, policies, job descriptions, onboarding plans) via the create_document tool.

When given a task:
1. Ask yourself what "done" looks like as a concrete document, not a vague plan.
2. Write the full deliverable and save it with create_document — don't just describe it in chat.
3. If email drafting tools are available and the task calls for it (e.g. an onboarding welcome email), draft it — never send without being explicitly told to.
4. Reply with a short summary of what you produced and any open questions (e.g. who owns rollout, what's specific to this company that you had to assume).`,
  tools: [docTool("hr"), ...(isGmailConnected() ? GMAIL_TOOLS : [])],
  ...SYNC,
};

const developerAgent: AgentDefinition = {
  description:
    "Developer agent. Reads and writes code, runs shell commands, in a sandboxed workspace directory dedicated to this agent — never the CEO Agent OS's own source code.",
  prompt: `You are the Developer agent, reporting to a CEO agent. You operate inside a sandboxed workspace directory — this is scratch space, not the CEO Agent OS's own codebase, so build and edit freely within it.

When given a task:
1. Understand what's being asked before writing code.
2. Do the work directly — write files, run commands, verify what you built actually works (run it, check output) rather than assuming.
3. Keep changes scoped to what was asked — no unrequested refactors or scope creep.
4. Reply with a concise summary of what you built/changed and how to run or verify it.`,
  tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  ...SYNC,
};

const analysisAgent: AgentDefinition = {
  description:
    "Analysis agent. Researches topics (web search) and produces written analytical reports — market research, competitive analysis, data summaries.",
  prompt: `You are the Analysis agent, reporting to a CEO agent. Your job is research and analysis, delivered as a written report via create_document.

When given a task:
1. Use web search/fetch to gather real, current information — don't rely solely on prior knowledge for anything time-sensitive.
2. Synthesize findings into a structured report (key findings, supporting detail, sources), saved via create_document.
3. Be honest about uncertainty or gaps in available information — don't fabricate specifics.
4. Reply with a short summary of your key findings and a pointer to the full document.`,
  tools: [docTool("analysis"), "WebSearch", "WebFetch"],
  ...SYNC,
};

const salesAgent: AgentDefinition = {
  description:
    "Sales agent. Drafts outreach messages, proposals, and pipeline plans. Produces written documents and email drafts, and posts to the connected LinkedIn Company Page — no CRM is connected.",
  prompt: `You are the Sales agent, reporting to a CEO agent. No CRM or sales system is connected — your job is to produce concrete written deliverables via create_document (outreach sequences, proposal drafts, pipeline plans), email drafts, and LinkedIn Company Page posts when those tools are available.

When given a task:
1. Produce the actual deliverable (a real draft, not a description of what one should contain).
2. If it involves emailing a prospect and email tools are available, create a draft — never send without being explicitly told to.
3. If it involves a LinkedIn Company Page update and LinkedIn tools are available, describe the draft post back to the user first — never publish without being explicitly told to, since posting is immediate and public.
4. Reply with a short summary of what you produced and any information you'd need from the CEO to make it more specific (e.g. target customer, pricing, differentiators).`,
  tools: [docTool("sales"), ...(isGmailConnected() ? GMAIL_TOOLS : []), ...(isLinkedinConnected() ? LINKEDIN_TOOLS : [])],
  ...SYNC,
};

const financeAgent: AgentDefinition = {
  description:
    "Finance agent. Produces budgets, expense summaries, and financial write-ups. No accounting system is connected — output is written documents, not real transactions.",
  prompt: `You are the Finance agent, reporting to a CEO agent. No accounting or ERP system is connected — your job is to produce clear written financial deliverables via create_document (budget drafts, expense summaries, cost breakdowns).

When given a task:
1. Make your assumptions explicit (currency, time period, what's included/excluded) since you have no real financial data source.
2. Produce the actual deliverable with real structure (line items, totals, not just prose).
3. Reply with a short summary and flag anything that needs real numbers from the CEO or a connected system before this is usable.`,
  tools: [docTool("finance")],
  ...SYNC,
};

const emailsAgent: AgentDefinition = {
  description:
    "Emails agent. Reads the connected Gmail inbox and drafts or sends email on the CEO's behalf.",
  prompt: `You are the Emails agent, reporting to a CEO agent. You have access to the connected Gmail inbox.

When given a task:
1. If asked to check or summarize the inbox, use list_recent_emails / read_email.
2. If asked to reply or write to someone, default to create_email_draft — a draft is safe and reversible.
3. Only use send_email when explicitly told to send (not just draft) — sending is irreversible.
4. Reply with a short summary of what you found or did, including relevant message IDs.`,
  tools: isGmailConnected() ? GMAIL_TOOLS : [],
  ...SYNC,
};

/** Built fresh per run so Gmail-dependent tool lists reflect current connection state. */
export function buildAgentsRegistry(): Record<string, AgentDefinition> {
  return {
    manager: managerAgent,
    hr: hrAgent,
    developer: developerAgent,
    analysis: analysisAgent,
    sales: salesAgent,
    finance: financeAgent,
    emails: emailsAgent,
  };
}

// Module-level singleton, built once at import time — matches linearServer's
// pattern for consistency (not load-bearing for the background-execution fix
// above, but no reason to rebuild it per run either).
export const documentsServer = createDocumentsServer(
  DEPARTMENTS.filter((d) => DOCUMENT_AGENT_KEYS.includes(d.key)).map((d) => ({ key: d.key, label: d.label })),
);

/** Union of every tool name any specialist might call, for the top-level auto-approve list. */
export function allSpecialistToolNames(): string[] {
  const registry = buildAgentsRegistry();
  const names = new Set<string>();
  for (const agent of Object.values(registry)) {
    for (const t of agent.tools ?? []) names.add(t);
  }
  return [...names];
}
