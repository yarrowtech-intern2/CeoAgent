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

// Confirmed against docs.zernio.com/guides/media-uploads (2026-08): presign
// gives a short-lived direct-upload URL (no auth on the PUT itself) plus a
// publicUrl that's immediately usable both as a preview link and as a post's
// mediaItems.url — Zernio promotes it from temp to permanent storage once a
// post actually references it, so there's no separate "confirm" step needed
// on our side for the upload itself.
export async function uploadMediaToZernio(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  const presignRes = await fetch(`${API_BASE}/media/presign`, {
    method: "POST",
    headers: zernioHeaders(),
    body: JSON.stringify({ filename, contentType }),
  });
  if (!presignRes.ok) {
    throw new Error(`Zernio media presign failed: ${presignRes.status} ${await presignRes.text()}`);
  }
  const { uploadUrl, publicUrl } = (await presignRes.json()) as { uploadUrl?: string; publicUrl?: string };
  if (!uploadUrl || !publicUrl) {
    throw new Error("Zernio media presign response was missing uploadUrl/publicUrl");
  }

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Blob([new Uint8Array(buffer)]),
  });
  if (!putRes.ok) {
    throw new Error(`Zernio media upload failed: ${putRes.status} ${await putRes.text()}`);
  }

  return publicUrl;
}

interface PublishZernioPostArgs {
  content: string;
  platforms: Array<{ platform: string; accountId: string }>;
  imageUrl?: string;
}

// Shared by the text/image post tool below and by post_folder_image
// (post-images.ts) so both paths go through one call to POST /posts.
export async function publishZernioPost({ content, platforms, imageUrl }: PublishZernioPostArgs) {
  const res = await fetch(`${API_BASE}/posts`, {
    method: "POST",
    headers: zernioHeaders(),
    body: JSON.stringify({
      content,
      platforms,
      mediaItems: imageUrl ? [{ url: imageUrl, type: "image" }] : undefined,
      publishNow: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Zernio error posting: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { post?: { _id: string; status: string } };
  return { id: json.post?._id ?? "unknown", status: json.post?.status ?? "unknown" };
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
  "Publish a post to one or more connected platforms via Zernio, optionally with one image. Irreversible and immediately public once sent — describe the draft (and, if there's an image, the imageUrl to review) back to the user and only call this when explicitly told to post (not just draft). Look up accountId values with list_zernio_accounts first. Instagram in particular requires an image — it has no text-only post type, so pass imageUrl (from generate_image or post_folder_image's preview step) whenever instagram is one of the target platforms.",
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
    imageUrl: z
      .string()
      .url()
      .optional()
      .describe("Public image URL to attach, e.g. from generate_image's preview output. Required for instagram."),
  },
  async ({ content, platforms, imageUrl }) => {
    try {
      const { id, status } = await publishZernioPost({ content, platforms, imageUrl });
      return {
        content: [
          {
            type: "text" as const,
            text: `Posted via Zernio to ${platforms.map((p) => p.platform).join(", ")}${imageUrl ? " with image" : ""} (post id: ${id}, status: ${status}).`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error posting via Zernio: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
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
    const json = (await res.json()) as {
      data?: Array<{ id: string; accountId: string; platform?: string; participantUsername?: string; participantName?: string; lastMessage?: string }>;
    };
    const conversations = json.data ?? [];
    if (!conversations.length) {
      return { content: [{ type: "text" as const, text: "No conversations found." }] };
    }
    const lines = conversations.map(
      (c) =>
        `- [${c.id}] ${c.platform ?? ""} account ${c.accountId} with ${c.participantUsername ?? c.participantName ?? "unknown"}: ${(c.lastMessage ?? "").slice(0, 140)}`,
    );
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
