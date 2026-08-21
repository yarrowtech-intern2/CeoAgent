import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  getSchedule,
  type Recurrence,
} from "../scheduler.js";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeRecurrence(r: Recurrence): string {
  if (r.type === "once") return `once, on ${r.date}`;
  if (r.type === "daily") return `daily, ${r.startDate}${r.endDate ? ` through ${r.endDate}` : " onward"}`;
  const days = r.weekdays.map((d) => WEEKDAY_NAMES[d] ?? String(d)).join("/");
  return `weekly on ${days}, ${r.startDate}${r.endDate ? ` through ${r.endDate}` : " onward"}`;
}

interface RecurrenceInput {
  recurrenceType: "once" | "daily" | "weekly";
  date?: string;
  startDate?: string;
  endDate?: string;
  weekdays?: number[];
}

function buildRecurrence(input: RecurrenceInput): Recurrence | { error: string } {
  if (input.recurrenceType === "once") {
    if (!input.date) return { error: 'recurrenceType "once" requires date (YYYY-MM-DD)' };
    return { type: "once", date: input.date };
  }
  if (input.recurrenceType === "daily") {
    if (!input.startDate) return { error: 'recurrenceType "daily" requires startDate (YYYY-MM-DD)' };
    return { type: "daily", startDate: input.startDate, endDate: input.endDate };
  }
  if (!input.startDate) return { error: 'recurrenceType "weekly" requires startDate (YYYY-MM-DD)' };
  if (!input.weekdays?.length) return { error: 'recurrenceType "weekly" requires weekdays (0=Sunday..6=Saturday)' };
  return { type: "weekly", weekdays: input.weekdays, startDate: input.startDate, endDate: input.endDate };
}

const AGENT_KEY_HINT =
  '"ceo", or one of: manager, hr, developer, analysis, sales, finance, seo, emails, pr, calendar';

const recurrenceShape = {
  recurrenceType: z.enum(["once", "daily", "weekly"]).describe("How often this fires"),
  date: z.string().optional().describe('Required when recurrenceType is "once" — YYYY-MM-DD'),
  startDate: z.string().optional().describe('Required when recurrenceType is "daily" or "weekly" — YYYY-MM-DD'),
  endDate: z.string().optional().describe("Optional inclusive end date, YYYY-MM-DD — omit for no end"),
  weekdays: z
    .array(z.number().min(0).max(6))
    .optional()
    .describe('Required when recurrenceType is "weekly" — 0=Sunday..6=Saturday'),
};

const createScheduledAutomation = tool(
  "create_scheduled_automation",
  `Schedule an automation: at a given time of day, a chosen agent (or the CEO) runs with a given goal, either once or on a recurring basis. Recurrence is structured (once/daily/weekly), not cron syntax. agentKey must be ${AGENT_KEY_HINT}. Check list_scheduled_automations first to avoid creating a duplicate of something that already exists.`,
  {
    label: z.string().describe("Short human-readable title, shown on the calendar and task list"),
    goal: z.string().describe("The goal/prompt the agent receives when this fires"),
    agentKey: z.string().describe(`Which agent receives the goal: ${AGENT_KEY_HINT}`),
    time: z.string().describe('Time of day to fire, 24h "HH:MM", server-local'),
    ...recurrenceShape,
  },
  async (input) => {
    const recurrence = buildRecurrence(input);
    if ("error" in recurrence) {
      return { content: [{ type: "text" as const, text: `Error: ${recurrence.error}` }], isError: true };
    }
    if (!/^\d{2}:\d{2}$/.test(input.time)) {
      return { content: [{ type: "text" as const, text: 'Error: time must be 24h "HH:MM"' }], isError: true };
    }
    const record = createSchedule({
      label: input.label,
      goal: input.goal,
      agentKey: input.agentKey,
      recurrence,
      time: input.time,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Created schedule "${record.label}" (id ${record.id}) — ${record.agentKey} runs "${record.goal}" at ${record.time}, ${describeRecurrence(record.recurrence)}.`,
        },
      ],
    };
  },
);

const listScheduledAutomations = tool(
  "list_scheduled_automations",
  "List all scheduled automations, including disabled ones, with their id, label, target agent, recurrence, and last-fired date.",
  {},
  async () => {
    const all = listSchedules();
    if (!all.length) return { content: [{ type: "text" as const, text: "No scheduled automations yet." }] };
    const lines = all.map(
      (s) =>
        `- [${s.id}] ${s.label} — ${s.enabled ? "enabled" : "disabled"} — ${s.agentKey} at ${s.time}, ${describeRecurrence(s.recurrence)}${s.lastFiredDate ? ` — last fired ${s.lastFiredDate}` : ""}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const updateScheduledAutomation = tool(
  "update_scheduled_automation",
  "Edit an existing scheduled automation by id — any of label, goal, agentKey, time, enabled, or its recurrence (pass recurrenceType plus the matching date fields to change recurrence; omit to leave recurrence unchanged).",
  {
    id: z.string().describe("Schedule id, from list_scheduled_automations"),
    label: z.string().optional(),
    goal: z.string().optional(),
    agentKey: z.string().optional().describe(AGENT_KEY_HINT),
    time: z.string().optional().describe('24h "HH:MM"'),
    enabled: z.boolean().optional(),
    recurrenceType: z.enum(["once", "daily", "weekly"]).optional(),
    date: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    weekdays: z.array(z.number().min(0).max(6)).optional(),
  },
  async (input) => {
    const existing = getSchedule(input.id);
    if (!existing) {
      return { content: [{ type: "text" as const, text: `Error: no schedule with id ${input.id}` }], isError: true };
    }
    if (input.time && !/^\d{2}:\d{2}$/.test(input.time)) {
      return { content: [{ type: "text" as const, text: 'Error: time must be 24h "HH:MM"' }], isError: true };
    }
    let recurrence: Recurrence | undefined;
    if (input.recurrenceType) {
      const built = buildRecurrence(input as RecurrenceInput);
      if ("error" in built) {
        return { content: [{ type: "text" as const, text: `Error: ${built.error}` }], isError: true };
      }
      recurrence = built;
    }
    const record = updateSchedule(input.id, {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.agentKey !== undefined ? { agentKey: input.agentKey } : {}),
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(recurrence ? { recurrence } : {}),
    });
    if (!record) {
      return { content: [{ type: "text" as const, text: `Error: no schedule with id ${input.id}` }], isError: true };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Updated "${record.label}" (id ${record.id}) — ${record.enabled ? "enabled" : "disabled"} — ${record.agentKey} at ${record.time}, ${describeRecurrence(record.recurrence)}.`,
        },
      ],
    };
  },
);

const cancelScheduledAutomation = tool(
  "cancel_scheduled_automation",
  "Cancel a scheduled automation by id — this disables it (reversible via update_scheduled_automation with enabled:true), it does not erase its history.",
  { id: z.string().describe("Schedule id, from list_scheduled_automations") },
  async ({ id }) => {
    const record = updateSchedule(id, { enabled: false });
    if (!record) {
      return { content: [{ type: "text" as const, text: `Error: no schedule with id ${id}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Cancelled "${record.label}" (id ${record.id}).` }] };
  },
);

export const SCHEDULER_TOOLS = [
  "mcp__scheduler__create_scheduled_automation",
  "mcp__scheduler__list_scheduled_automations",
  "mcp__scheduler__update_scheduled_automation",
  "mcp__scheduler__cancel_scheduled_automation",
];

export const schedulerServer = createSdkMcpServer({
  name: "scheduler",
  version: "1.0.0",
  instructions:
    "Tools for scheduling other agents' work (one-time or recurring) so it runs automatically at a future date/time. list_scheduled_automations first to see what already exists before creating overlapping schedules.",
  tools: [createScheduledAutomation, listScheduledAutomations, updateScheduledAutomation, cancelScheduledAutomation],
});
