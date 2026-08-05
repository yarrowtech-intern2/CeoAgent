import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const TOKEN_FILE = join(DATA_DIR, "instagram-token.json");

const GRAPH_API = "https://graph.facebook.com/v21.0";

interface InstagramConnection {
  pageId: string;
  pageAccessToken: string;
  igBusinessAccountId: string;
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri =
    process.env.META_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 3000}/auth/instagram/callback`;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID / META_APP_SECRET are not set");
  }
  return { appId, appSecret, redirectUri };
}

export function isInstagramConnected(): boolean {
  return existsSync(TOKEN_FILE);
}

export function disconnectInstagram() {
  if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
}

export function getInstagramAuthUrl(): string {
  const { appId, redirectUri } = getConfig();
  const scope = [
    "pages_show_list",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
    "pages_messaging",
  ].join(",");
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope,
    response_type: "code",
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

/**
 * Requires an Instagram Business or Creator account linked to a Facebook
 * Page, and a Meta app with the scopes above approved (development-mode
 * testers are sufficient for personal use — full App Review is only needed
 * to grant access beyond accounts you own/administer).
 */
export async function handleInstagramCallback(code: string): Promise<void> {
  const { appId, appSecret, redirectUri } = getConfig();

  const tokenRes = await fetch(
    `${GRAPH_API}/oauth/access_token?` +
      new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, client_secret: appSecret, code }),
  );
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: { message: string } };
  if (!tokenJson.access_token) throw new Error(tokenJson.error?.message ?? "Failed to exchange code for token");

  const longLivedRes = await fetch(
    `${GRAPH_API}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: tokenJson.access_token,
      }),
  );
  const longLivedJson = (await longLivedRes.json()) as { access_token?: string; error?: { message: string } };
  const userToken = longLivedJson.access_token ?? tokenJson.access_token;

  const pagesRes = await fetch(`${GRAPH_API}/me/accounts?access_token=${userToken}`);
  const pagesJson = (await pagesRes.json()) as {
    data?: Array<{ id: string; access_token: string }>;
    error?: { message: string };
  };
  if (!pagesJson.data?.length) {
    throw new Error(
      pagesJson.error?.message ?? "No Facebook Pages found for this account. A Page linked to an Instagram Business/Creator account is required.",
    );
  }

  for (const page of pagesJson.data) {
    const igRes = await fetch(
      `${GRAPH_API}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`,
    );
    const igJson = (await igRes.json()) as { instagram_business_account?: { id: string } };
    if (igJson.instagram_business_account?.id) {
      const connection: InstagramConnection = {
        pageId: page.id,
        pageAccessToken: page.access_token,
        igBusinessAccountId: igJson.instagram_business_account.id,
      };
      ensureDir();
      writeFileSync(TOKEN_FILE, JSON.stringify(connection, null, 2));
      return;
    }
  }

  throw new Error(
    "None of your Facebook Pages have a linked Instagram Business/Creator account. Link one in Meta Business Suite first.",
  );
}

function getConnection(): InstagramConnection {
  if (!isInstagramConnected()) throw new Error("Instagram is not connected");
  return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
}

const listInstagramConversations = tool(
  "list_instagram_conversations",
  "List recent Instagram DM conversations for the connected Business/Creator account.",
  { limit: z.number().int().min(1).max(25).default(10) },
  async ({ limit }) => {
    const { pageId, pageAccessToken } = getConnection();
    const res = await fetch(
      `${GRAPH_API}/${pageId}/conversations?platform=instagram&limit=${limit}&access_token=${pageAccessToken}`,
    );
    const json = (await res.json()) as {
      data?: Array<{ id: string; participants?: { data?: Array<{ username?: string }> } }>;
      error?: { message: string };
    };
    if (json.error) return { content: [{ type: "text" as const, text: `Error: ${json.error.message}` }], isError: true };

    const lines = (json.data ?? []).map((c) => {
      const participant = c.participants?.data?.[0]?.username ?? "unknown";
      return `- [${c.id}] with @${participant}`;
    });
    return { content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No conversations found." }] };
  },
);

const readInstagramConversation = tool(
  "read_instagram_conversation",
  "Read recent messages in a specific Instagram DM conversation (by ID from list_instagram_conversations).",
  { conversationId: z.string() },
  async ({ conversationId }) => {
    const { pageAccessToken } = getConnection();
    const res = await fetch(
      `${GRAPH_API}/${conversationId}?fields=messages{message,from,created_time}&access_token=${pageAccessToken}`,
    );
    const json = (await res.json()) as {
      messages?: { data?: Array<{ message?: string; from?: { username?: string }; created_time?: string }> };
      error?: { message: string };
    };
    if (json.error) return { content: [{ type: "text" as const, text: `Error: ${json.error.message}` }], isError: true };

    const lines = (json.messages?.data ?? []).map(
      (m) => `[${m.created_time}] @${m.from?.username ?? "?"}: ${m.message ?? ""}`,
    );
    return { content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No messages found." }] };
  },
);

export const INSTAGRAM_TOOLS = [
  "mcp__instagram__list_instagram_conversations",
  "mcp__instagram__read_instagram_conversation",
];

export const instagramServer = createSdkMcpServer({
  name: "instagram",
  version: "1.0.0",
  instructions: "Tools for reading Instagram DM conversations on the connected Business/Creator account.",
  tools: [listInstagramConversations, readInstagramConversation],
});
