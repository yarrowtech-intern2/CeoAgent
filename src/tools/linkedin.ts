import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const TOKEN_FILE = join(DATA_DIR, "linkedin-token.json");

// LinkedIn's REST API is calendar-versioned via this header — LinkedIn ships
// a new version monthly and only supports the last ~12. Bump this if calls
// start failing with a version-related 4xx; there's no way to pin "latest".
const LINKEDIN_VERSION = "202501";
const API_BASE = "https://api.linkedin.com/rest";

interface LinkedinConnection {
  accessToken: string;
  /** urn:li:organization:{id} — the Company Page this connection posts as. */
  organizationUrn: string;
  organizationName: string;
  expiresAt: number;
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri =
    process.env.LINKEDIN_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 3000}/auth/linkedin/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set");
  }
  return { clientId, clientSecret, redirectUri };
}

export function isLinkedinConnected(): boolean {
  return existsSync(TOKEN_FILE);
}

export function disconnectLinkedin() {
  if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
}

export function getLinkedinAuthUrl(): string {
  const { clientId, redirectUri } = getConfig();
  // Posting/reading as an ORGANIZATION (Company Page) — not a personal
  // profile. w_organization_social + r_organization_social require the
  // "Community Management API" product on the LinkedIn app, which (unlike
  // Google/Meta) needs LinkedIn's approval, not just a self-serve toggle.
  const scope = ["w_organization_social", "r_organization_social", "rw_organization_admin"].join(" ");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

/**
 * Requires a LinkedIn Company Page you administer, a LinkedIn Developer app
 * with the Community Management API product approved, and that app
 * associated with the same Page. Picks the first organization the
 * authenticated user administers — if you administer more than one Page,
 * disconnect and note this only supports one at a time for now.
 */
export async function handleLinkedinCallback(code: string): Promise<void> {
  const { clientId, clientSecret, redirectUri } = getConfig();

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!tokenJson.access_token) {
    throw new Error(tokenJson.error_description ?? "Failed to exchange code for token");
  }
  const accessToken = tokenJson.access_token;

  const aclsRes = await fetch(
    "https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(*,organization~(id,localizedName)))",
    { headers: { Authorization: `Bearer ${accessToken}`, "X-Restli-Protocol-Version": "2.0.0" } },
  );
  const aclsJson = (await aclsRes.json()) as {
    elements?: Array<{ organization: string; "organization~"?: { id: number; localizedName: string } }>;
    message?: string;
  };
  const first = aclsJson.elements?.[0];
  if (!first) {
    throw new Error(
      aclsJson.message ??
        "No Company Page found where you're an administrator. Create/claim one and make sure this LinkedIn app is associated with it.",
    );
  }

  const connection: LinkedinConnection = {
    accessToken,
    organizationUrn: first.organization,
    organizationName: first["organization~"]?.localizedName ?? "Connected Page",
    expiresAt: Date.now() + (tokenJson.expires_in ?? 3600) * 1000,
  };
  ensureDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(connection, null, 2));
}

function getConnection(): LinkedinConnection {
  if (!isLinkedinConnected()) throw new Error("LinkedIn is not connected");
  const connection: LinkedinConnection = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  // LinkedIn's standard OAuth tokens are short-lived (~60 days) with no
  // refresh token in this flow — once expired, reconnecting via the
  // Accounts page is the only way back in, same as a stale Instagram token.
  if (Date.now() > connection.expiresAt) {
    throw new Error("LinkedIn connection expired — reconnect it from the Accounts page.");
  }
  return connection;
}

function linkedinHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    "Content-Type": "application/json",
  };
}

const createOrganizationPost = tool(
  "create_organization_post",
  "Publish a text post to the connected LinkedIn Company Page's feed. Irreversible and immediately public — only use when explicitly told to post (not just draft).",
  { text: z.string().describe("Post body text") },
  async ({ text }) => {
    const { accessToken, organizationUrn, organizationName } = getConnection();
    const res = await fetch(`${API_BASE}/posts`, {
      method: "POST",
      headers: linkedinHeaders(accessToken),
      body: JSON.stringify({
        author: organizationUrn,
        commentary: text,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { content: [{ type: "text" as const, text: `Error posting to LinkedIn: ${res.status} ${errText}` }], isError: true };
    }
    const postId = res.headers.get("x-restli-id") ?? "unknown";
    return {
      content: [{ type: "text" as const, text: `Posted to ${organizationName}'s LinkedIn Page (id: ${postId}).` }],
    };
  },
);

const listOrganizationPosts = tool(
  "list_organization_posts",
  "List recent posts on the connected LinkedIn Company Page, for context or reporting.",
  { limit: z.number().int().min(1).max(25).default(10) },
  async ({ limit }) => {
    const { accessToken, organizationUrn } = getConnection();
    const params = new URLSearchParams({
      q: "author",
      author: organizationUrn,
      count: String(limit),
    });
    const res = await fetch(`${API_BASE}/posts?${params.toString()}`, {
      headers: linkedinHeaders(accessToken),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { content: [{ type: "text" as const, text: `Error: ${res.status} ${errText}` }], isError: true };
    }
    const json = (await res.json()) as { elements?: Array<{ id: string; commentary?: string; createdAt?: number }> };
    const lines = (json.elements ?? []).map(
      (p) => `- [${p.id}] ${p.createdAt ? new Date(p.createdAt).toISOString() : ""}: ${(p.commentary ?? "").slice(0, 140)}`,
    );
    return { content: [{ type: "text" as const, text: lines.length ? lines.join("\n") : "No posts found." }] };
  },
);

export const LINKEDIN_TOOLS = ["mcp__linkedin__create_organization_post", "mcp__linkedin__list_organization_posts"];

export const linkedinServer = createSdkMcpServer({
  name: "linkedin",
  version: "1.0.0",
  instructions:
    "Tools for posting to and reading the connected LinkedIn Company Page's feed. Default to describing the draft back to the user before posting; only post directly when explicitly told to.",
  tools: [createOrganizationPost, listOrganizationPosts],
});
