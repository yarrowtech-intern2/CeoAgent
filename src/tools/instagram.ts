import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const TOKEN_FILE = join(DATA_DIR, "instagram-token.json");

// "Instagram API with Instagram Login" — logs the user into their Instagram
// professional account directly (no Facebook Page required), which is what
// this app's Meta app is configured for. This is a DIFFERENT product from
// the older "Facebook Login for Business" + Pages flow (graph.facebook.com,
// pages_show_list scope, etc.) — different auth host, different token
// exchange, different scopes. Do not mix the two.
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_API = "https://graph.instagram.com/v21.0";

interface InstagramConnection {
  userId: string;
  accessToken: string;
  username?: string;
  expiresAt: number;
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
  // Meta's current scope names for this product (the pre-2025 names like
  // instagram_basic/pages_show_list are for the old Pages-based flow and
  // don't apply here).
  const scope = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
    "instagram_business_manage_insights",
  ].join(",");
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Requires a Meta app with the "Instagram API with Instagram Login" product
 * added, and the connecting account set up as an Instagram professional
 * (Business/Creator) account — no Facebook Page needed for this flow.
 */
export async function handleInstagramCallback(code: string): Promise<void> {
  const { appId, appSecret, redirectUri } = getConfig();

  // Meta's docs show this endpoint called with curl -F (multipart), not
  // urlencoded — a FormData body here, not URLSearchParams. Don't set
  // Content-Type manually; fetch derives the correct multipart boundary.
  const form = new FormData();
  form.append("client_id", appId);
  form.append("client_secret", appSecret);
  form.append("grant_type", "authorization_code");
  form.append("redirect_uri", redirectUri);
  form.append("code", code);

  const tokenRes = await fetch(TOKEN_URL, { method: "POST", body: form });
  const tokenText = await tokenRes.text();
  let tokenJson: {
    // Confirmed live: the response is a flat object, not wrapped in `data`
    // like some Meta docs/summaries suggest — support both shapes.
    data?: Array<{ access_token: string; user_id: string | number; permissions?: string[] }>;
    access_token?: string;
    user_id?: string | number;
    permissions?: string[];
    error_message?: string;
    error_type?: string;
  };
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    throw new Error(`Instagram token exchange returned a non-JSON response (${tokenRes.status}): ${tokenText.slice(0, 300)}`);
  }
  const shortLived =
    tokenJson.data?.[0] ??
    (tokenJson.access_token && tokenJson.user_id !== undefined
      ? { access_token: tokenJson.access_token, user_id: tokenJson.user_id, permissions: tokenJson.permissions }
      : undefined);
  if (!shortLived) {
    throw new Error(tokenJson.error_message ?? `Failed to exchange code for token (${tokenRes.status}): ${tokenText.slice(0, 300)}`);
  }

  const longLivedRes = await fetch(
    `${GRAPH_API.replace("/v21.0", "")}/access_token?` +
      new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: appSecret,
        access_token: shortLived.access_token,
      }),
  );
  const longLivedJson = (await longLivedRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error_message?: string;
  };
  const accessToken = longLivedJson.access_token ?? shortLived.access_token;
  const expiresAt = Date.now() + (longLivedJson.expires_in ?? 3600) * 1000;

  // Best-effort — a username is nice for the Accounts page label but not
  // required for the connection to work.
  let username: string | undefined;
  try {
    const meRes = await fetch(`${GRAPH_API}/me?fields=user_id,username&access_token=${accessToken}`);
    const meJson = (await meRes.json()) as { username?: string };
    username = meJson.username;
  } catch {
    // non-fatal
  }

  const connection: InstagramConnection = { userId: String(shortLived.user_id), accessToken, username, expiresAt };
  ensureDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(connection, null, 2));
}

function getConnection(): InstagramConnection {
  if (!isInstagramConnected()) throw new Error("Instagram is not connected");
  const connection: InstagramConnection = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  if (Date.now() > connection.expiresAt) {
    throw new Error("Instagram connection expired — reconnect it from the Accounts page.");
  }
  return connection;
}

// NOTE: unlike the OAuth flow above (verified against Meta's current docs),
// these two endpoints follow the same /conversations shape Meta's other
// messaging APIs use, adapted to the graph.instagram.com host — Meta's
// public docs didn't have a page confirming this exact path at the time
// this was written. Treat as best-effort; if either 404s, that's the first
// thing to check against Meta's current Instagram Messaging API reference.
const listInstagramConversations = tool(
  "list_instagram_conversations",
  "List recent Instagram DM conversations for the connected professional account.",
  { limit: z.number().int().min(1).max(25).default(10) },
  async ({ limit }) => {
    const { accessToken } = getConnection();
    const res = await fetch(`${GRAPH_API}/me/conversations?platform=instagram&limit=${limit}&access_token=${accessToken}`);
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
    const { accessToken } = getConnection();
    const res = await fetch(
      `${GRAPH_API}/${conversationId}?fields=messages{message,from,created_time}&access_token=${accessToken}`,
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
  instructions: "Tools for reading Instagram DM conversations on the connected professional account.",
  tools: [listInstagramConversations, readInstagramConversation],
});
