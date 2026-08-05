import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const LINEAR_API_URL = "https://api.linear.app/graphql";

async function linearRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set");
  }

  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data as T;
}

const createLinearTask = tool(
  "create_linear_task",
  "Create a task (issue) in Linear and assign it. Use this to hand work to a human or team.",
  {
    title: z.string().describe("Short task title"),
    description: z.string().optional().describe("Task details, acceptance criteria, context"),
    teamId: z
      .string()
      .optional()
      .describe("Linear team ID. Defaults to LINEAR_TEAM_ID env var if omitted."),
    assigneeId: z.string().optional().describe("Linear user ID to assign the task to"),
  },
  async ({ title, description, teamId, assigneeId }) => {
    const resolvedTeamId = teamId ?? process.env.LINEAR_TEAM_ID;
    if (!resolvedTeamId) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: no teamId provided and LINEAR_TEAM_ID is not set.",
          },
        ],
        isError: true,
      };
    }

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url }
        }
      }
    `;

    const data = await linearRequest<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; title: string; url: string } };
    }>(mutation, {
      input: { title, description, teamId: resolvedTeamId, assigneeId },
    });

    const issue = data.issueCreate.issue;
    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${issue.identifier}: ${issue.title}\n${issue.url}`,
        },
      ],
    };
  },
);

const listLinearTasks = tool(
  "list_linear_tasks",
  "List recent tasks (issues) in Linear, optionally filtered by team.",
  {
    teamId: z.string().optional().describe("Linear team ID. Defaults to LINEAR_TEAM_ID env var."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max number of tasks to return"),
  },
  async ({ teamId, limit }) => {
    const resolvedTeamId = teamId ?? process.env.LINEAR_TEAM_ID;

    const query = `
      query ListIssues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first, orderBy: updatedAt) {
          nodes { identifier title state { name } url }
        }
      }
    `;

    const data = await linearRequest<{
      issues: { nodes: Array<{ identifier: string; title: string; state: { name: string }; url: string }> };
    }>(query, {
      filter: resolvedTeamId ? { team: { id: { eq: resolvedTeamId } } } : undefined,
      first: limit,
    });

    const lines = data.issues.nodes.map(
      (n) => `- ${n.identifier} [${n.state.name}] ${n.title} (${n.url})`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: lines.length ? lines.join("\n") : "No tasks found.",
        },
      ],
    };
  },
);

export const linearServer = createSdkMcpServer({
  name: "linear",
  version: "1.0.0",
  instructions: "Tools for creating and listing tasks in Linear, the team's task tracker.",
  tools: [createLinearTask, listLinearTasks],
});

export const LINEAR_TOOLS = ["mcp__linear__create_linear_task", "mcp__linear__list_linear_tasks"];
