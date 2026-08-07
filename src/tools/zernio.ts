import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Zernio is a unified API for posting/messaging across many social and
// messaging platforms (X, Instagram, Facebook, LinkedIn, TikTok, YouTube,
// etc.) — one API key stands in for OAuth apps we'd otherwise have to build
// per platform (see gmail.ts/instagram.ts/linkedin.ts for that pattern).
// Unlike those, platform accounts are linked through Zernio's own hosted
// dashboard, not a callback route on this server — this app only needs the
// API key to see what's connected and act through it.
const API_BASE = "https://zernio.com/api/v1";

function getApiKey(): string {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) throw new Error("ZERNIO_API_KEY is not set");
  return key;
}

export function isZernioConnected(): boolean {
  return !!process.env.ZERNIO_API_KEY;
}

function zernioHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}

interface ZernioAccount {
  _id: string;
  platform: string;
}

async function fetchAccounts(): Promise<ZernioAccount[]> {
  const res = await fetch(`${API_BASE}/accounts`, { headers: zernioHeaders() });
  if (!res.ok) throw new Error(`Zernio error listing accounts: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { accounts?: ZernioAccount[] };
  return json.accounts ?? [];
}

const listZernioAccounts = tool(
  "list_zernio_accounts",
  "List the social/messaging accounts connected through Zernio, with their platform and account ID. Use this first to find the accountId values create_zernio_post needs — accounts themselves are linked via Zernio's own dashboard, not from here.",
  {},
  async () => {
    const accounts = await fetchAccounts();
    if (!accounts.length) {
      return { content: [{ type: "text" as const, text: "No accounts connected in Zernio yet — link some from the Zernio dashboard first." }] };
    }
    const lines = accounts.map((a) => `- ${a.platform}: ${a._id}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const createZernioPost = tool(
  "create_zernio_post",
  "Publish a post to one or more connected platforms via Zernio. Irreversible and immediately public once sent — describe the draft back to the user and only call this when explicitly told to post (not just draft). Look up accountId values with list_zernio_accounts first.",
  {
    content: z.string().describe("Post body text"),
    platforms: z
      .array(
        z.object({
          platform: z.string().describe("e.g. twitter, instagram, facebook, linkedin, tiktok, threads"),
          accountId: z.string().describe("Account ID from list_zernio_accounts"),
        }),
      )
      .min(1),
  },
  async ({ content, platforms }) => {
    const res = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: zernioHeaders(),
      body: JSON.stringify({ content, platforms, publishNow: true }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { content: [{ type: "text" as const, text: `Error posting via Zernio: ${res.status} ${errText}` }], isError: true };
    }
    const json = (await res.json()) as { post?: { _id: string; status: string } };
    return {
      content: [
        {
          type: "text" as const,
          text: `Posted via Zernio to ${platforms.map((p) => p.platform).join(", ")} (post id: ${json.post?._id ?? "unknown"}, status: ${json.post?.status ?? "unknown"}).`,
        },
      ],
    };
  },
);

const listZernioConversations = tool(
  "list_zernio_conversations",
  "List recent DM/message conversations across connected Zernio accounts, for context before replying.",
  {},
  async () => {
    const res = await fetch(`${API_BASE}/inbox/conversations`, { headers: zernioHeaders() });
    if (!res.ok) {
      const errText = await res.text();
      return { content: [{ type: "text" as const, text: `Error: ${res.status} ${errText}` }], isError: true };
    }
    const json = (await res.json()) as { conversations?: Array<{ _id: string; platform?: string; lastMessage?: string }> };
    const conversations = json.conversations ?? [];
    if (!conversations.length) {
      return { content: [{ type: "text" as const, text: "No conversations found." }] };
    }
    const lines = conversations.map((c) => `- [${c._id}] ${c.platform ?? ""}: ${(c.lastMessage ?? "").slice(0, 140)}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const sendZernioMessage = tool(
  "send_zernio_message",
  "Send a DM reply in an existing Zernio conversation. Irreversible once sent — only call this when explicitly told to send (not just draft). Find conversationId via list_zernio_conversations.",
  {
    conversationId: z.string(),
    accountId: z.string().describe("The connected account sending the message (from list_zernio_accounts)"),
    message: z.string(),
  },
  async ({ conversationId, accountId, message }) => {
    const res = await fetch(`${API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      headers: zernioHeaders(),
      body: JSON.stringify({ accountId, message }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { content: [{ type: "text" as const, text: `Error sending message via Zernio: ${res.status} ${errText}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: `Message sent in conversation ${conversationId}.` }] };
  },
);

export const ZERNIO_TOOLS = [
  "mcp__zernio__list_zernio_accounts",
  "mcp__zernio__create_zernio_post",
  "mcp__zernio__list_zernio_conversations",
  "mcp__zernio__send_zernio_message",
];

export const zernioServer = createSdkMcpServer({
  name: "zernio",
  version: "1.0.0",
  instructions:
    "Tools for posting and messaging across connected social/messaging platforms via Zernio. Default to describing the draft back to the user before posting or sending a message; only act directly when explicitly told to.",
  tools: [listZernioAccounts, createZernioPost, listZernioConversations, sendZernioMessage],
});
