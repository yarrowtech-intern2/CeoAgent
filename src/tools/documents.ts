import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_DIR } from "../workspace.js";

// Must live inside WORKSPACE_DIR, not the top-level data/ directory — file
// writes outside the agent session's cwd silently no-op when made by a
// CEO-delegated (async/background) subagent. See workspace.ts for the full
// story; this was hard-won by elimination against a working comparison
// (Developer's built-in Write tool, which writes inside cwd and works fine
// via delegation) and a non-filesystem comparison (Linear, a network call,
// also fine via delegation).
const DOCS_DIR = join(WORKSPACE_DIR, ".documents");
const INDEX_FILE = join(DOCS_DIR, "index.json");

export interface DocumentRecord {
  id: string;
  title: string;
  agentKey: string;
  createdAt: string;
  content: string;
}

// Sync fs is fine for these — only called from Express route handlers, never
// from inside a tool call. Tool handlers use the async versions below;
// blocking the event loop from inside a CEO-delegated (async/background)
// subagent's tool call was suspected of interfering with whatever channel
// that subagent uses to report back to the parent process.
function ensureDirSync() {
  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
}

function loadIndexSync(): DocumentRecord[] {
  ensureDirSync();
  if (!existsSync(INDEX_FILE)) return [];
  return JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
}

async function loadIndexAsync(): Promise<DocumentRecord[]> {
  await mkdir(DOCS_DIR, { recursive: true });
  try {
    return JSON.parse(await readFile(INDEX_FILE, "utf-8"));
  } catch {
    return [];
  }
}

async function saveIndexAsync(docs: DocumentRecord[]) {
  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify(docs, null, 2));
}

export function listDocuments(agentKey?: string): DocumentRecord[] {
  const docs = loadIndexSync();
  return (agentKey ? docs.filter((d) => d.agentKey === agentKey) : docs).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export function getDocument(id: string): DocumentRecord | undefined {
  return loadIndexSync().find((d) => d.id === id);
}

async function addDocument(agentKey: string, title: string, content: string): Promise<DocumentRecord> {
  const docs = await loadIndexAsync();
  const record: DocumentRecord = {
    id: randomUUID(),
    title,
    agentKey,
    createdAt: new Date().toISOString(),
    content,
  };
  docs.push(record);
  await saveIndexAsync(docs);
  return record;
}

export interface DocumentAgentMeta {
  key: string;
  label: string;
}

/**
 * ONE MCP server exposing one document-creation tool per department. The
 * model can't mix up departments because each tool is separately named
 * (create_hr_document, create_analysis_document, ...) and bound to its own
 * agentKey via closure — it never has to self-report which department it's
 * acting as.
 */
export function createDocumentsServer(agents: DocumentAgentMeta[]) {
  const tools = agents.map(({ key, label }) =>
    tool(
      `create_${key}_document`,
      `Create a persisted document (markdown) as a deliverable from the ${label} agent — reports, plans, drafts, summaries. Use this for any written output that should be saved and shown on the dashboard, instead of only replying in chat.`,
      {
        title: z.string().describe("Short, descriptive document title"),
        body: z.string().describe("Full document content, in markdown"),
      },
      async ({ title, body }) => {
        const record = await addDocument(key, title, body);
        return {
          content: [
            { type: "text" as const, text: `Document created: "${record.title}" (id: ${record.id})` },
          ],
        };
      },
    ),
  );

  return createSdkMcpServer({
    name: "documents",
    version: "1.0.0",
    instructions: "Tools for persisting written deliverables from each specialist agent.",
    tools,
  });
}
