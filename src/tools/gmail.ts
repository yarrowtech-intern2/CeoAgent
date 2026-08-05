import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const TOKEN_FILE = join(DATA_DIR, "gmail-token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
];

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 3000}/auth/gmail/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isGmailConnected(): boolean {
  return existsSync(TOKEN_FILE);
}

export function disconnectGmail() {
  if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
}

export function getGmailAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function handleGmailCallback(code: string): Promise<void> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  ensureDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function getAuthedClient() {
  if (!isGmailConnected()) throw new Error("Gmail is not connected");
  const client = getOAuthClient();
  const tokens = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    // Persist refreshed access tokens so we don't re-prompt for consent.
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, ...newTokens }, null, 2));
  });
  return google.gmail({ version: "v1", auth: client });
}

function decodeBody(payload: unknown): string {
  const p = payload as {
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
  };
  if (p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf-8");
  const textPart = p.parts?.find((part) => part.mimeType === "text/plain");
  if (textPart?.body?.data) return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
  const htmlPart = p.parts?.find((part) => part.mimeType === "text/html");
  if (htmlPart?.body?.data) return Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
  return "(no readable body)";
}

function buildRawMessage(to: string, subject: string, body: string): string {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\n",
  );
  return Buffer.from(message).toString("base64url");
}

const listRecentEmails = tool(
  "list_recent_emails",
  "List recent emails in the connected Gmail inbox. Use a Gmail search query to filter (e.g. 'is:unread', 'from:someone@example.com').",
  {
    query: z.string().optional().describe("Gmail search query, e.g. 'is:unread'. Omit for the most recent emails."),
    maxResults: z.number().int().min(1).max(25).default(10),
  },
  async ({ query, maxResults }) => {
    const gmail = getAuthedClient();
    const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
    const messages = list.data.messages ?? [];
    if (!messages.length) {
      return { content: [{ type: "text" as const, text: "No emails found." }] };
    }

    const lines: string[] = [];
    for (const m of messages) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = msg.data.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
      lines.push(`- [${m.id}] ${get("Date")} | From: ${get("From")} | Subject: ${get("Subject")}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const readEmail = tool(
  "read_email",
  "Read the full content of a specific email by its message ID (from list_recent_emails).",
  { messageId: z.string() },
  async ({ messageId }) => {
    const gmail = getAuthedClient();
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const headers = msg.data.payload?.headers ?? [];
    const get = (name: string) => headers.find((h) => h.name === name)?.value ?? "";
    const body = decodeBody(msg.data.payload);
    return {
      content: [
        {
          type: "text" as const,
          text: `From: ${get("From")}\nTo: ${get("To")}\nSubject: ${get("Subject")}\nDate: ${get("Date")}\n\n${body}`,
        },
      ],
    };
  },
);

const createEmailDraft = tool(
  "create_email_draft",
  "Create a draft email in Gmail (does NOT send it). Safe, reversible — use this by default when asked to write an email.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string(),
    body: z.string().describe("Plain text email body"),
  },
  async ({ to, subject, body }) => {
    const gmail = getAuthedClient();
    const raw = buildRawMessage(to, subject, body);
    const draft = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    return {
      content: [{ type: "text" as const, text: `Draft created (id: ${draft.data.id}) to ${to}: "${subject}"` }],
    };
  },
);

const sendEmail = tool(
  "send_email",
  "Send an email immediately via Gmail. Irreversible — only use this when explicitly instructed to send (not just draft) an email.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string(),
    body: z.string().describe("Plain text email body"),
  },
  async ({ to, subject, body }) => {
    const gmail = getAuthedClient();
    const raw = buildRawMessage(to, subject, body);
    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return {
      content: [{ type: "text" as const, text: `Email sent (id: ${sent.data.id}) to ${to}: "${subject}"` }],
    };
  },
);

export const GMAIL_TOOLS = [
  "mcp__gmail__list_recent_emails",
  "mcp__gmail__read_email",
  "mcp__gmail__create_email_draft",
  "mcp__gmail__send_email",
];

export const gmailServer = createSdkMcpServer({
  name: "gmail",
  version: "1.0.0",
  instructions:
    "Tools for reading and drafting/sending email via the connected Gmail account. Default to creating drafts; only send directly when explicitly told to.",
  tools: [listRecentEmails, readEmail, createEmailDraft, sendEmail],
});
