import express from "express";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readDoc, writeDoc, docExists, deleteDoc } from "../storage.js";
import { join } from "node:path";
import { getGlobalDataDir, runWithTenant, type TenantContext } from "../paths.js";
import { getEnvValue } from "./settings.js";

const COOKIE_NAME = "ceo_agent_session";
const TENANTS_FILE = join(getGlobalDataDir(), "tenants.json");

// Gmail/Instagram/LinkedIn/Facebook/Canva "Connect" links must be opened in
// the user's real OS browser (see setWindowOpenHandler in electron/main.cjs)
// because these providers block sign-in from an embedded Electron webview.
// That real browser doesn't carry the Electron session's `ceo_agent_session`
// cookie, so it can't be used to identify which tenant's credentials to use
// for the OAuth round trip. Instead, the authenticated Electron session mints
// one of these short-lived signed tokens (identifying only the tenant, not a
// login) into the connect link; it round-trips through the provider via the
// standard OAuth `state` param and is verified — without needing any cookie
// — on both the initiating request and the callback. It's process-lifetime
// only (not persisted), which is fine since a connect flow completes in a
// couple of minutes, well inside OAUTH_STATE_TTL_MS.
const OAUTH_STATE_SECRET = randomBytes(32);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function signOAuthState(payload: string): string {
  return createHmac("sha256", OAUTH_STATE_SECRET).update(payload).digest("base64url");
}

export function createOAuthStateToken(tenant: TenantContext): string {
  const payload = Buffer.from(JSON.stringify({ o: tenant.organizationId, e: Date.now() + OAUTH_STATE_TTL_MS })).toString(
    "base64url",
  );
  return `${payload}.${signOAuthState(payload)}`;
}

export function verifyOAuthStateToken(token: string): TenantContext {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Malformed OAuth state token");
  const expected = signOAuthState(payload);
  const actual = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    throw new Error("Invalid OAuth state token");
  }
  const { o: organizationId, e: expiresAt } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
    o: string;
    e: number;
  };
  if (Date.now() > expiresAt) throw new Error("OAuth state token expired — please click Connect again");
  const tenant = findTenantByOrganizationId(organizationId);
  if (!tenant) throw new Error("Unknown organization in OAuth state token");
  return tenant;
}

/**
 * Resolves which tenant an /auth/* OAuth request belongs to from the signed
 * `state` token (see the OAuth-state-token comment above). The token is
 * required — there's deliberately no fallback to the session cookie: a
 * cookie-only callback would let an attacker send a victim a link carrying
 * the attacker's own authorization code and silently connect the attacker's
 * account to the victim's org (OAuth login CSRF). Returns undefined for
 * single-tenant/no-auth deployments, matching pre-multi-tenant behavior.
 */
export async function resolveAuthFlowTenant(req: express.Request): Promise<TenantContext | undefined> {
  if (!isSupabaseAuthConfigured()) return undefined;
  const token = typeof req.query.state === "string" ? req.query.state : "";
  if (!token) throw new Error("Missing OAuth state — start the connection again from the Accounts screen.");
  return verifyOAuthStateToken(token);
}

interface SupabaseUser {
  id: string;
  email?: string;
  user_metadata?: {
    name?: string;
    full_name?: string;
    organization_name?: string;
  };
}

interface TenantRecord extends TenantContext {
  createdAt: string;
  updatedAt: string;
  uiTheme?: UiTheme;
}

// Which UI design `/` serves: "ceopro" (default, the former /preview
// dashboard) or "ceounik" (the original dashboard, which also hosts the
// login screen). Independent of light/dark mode, which stays client-side.
export type UiTheme = "ceopro" | "ceounik";
export const UI_THEMES: UiTheme[] = ["ceopro", "ceounik"];
const DEFAULT_UI_THEME: UiTheme = "ceopro";
// No-auth (single-tenant) deployments have no tenant record to hang the
// preference on, so it lives in its own global doc instead.
const LOCAL_UI_THEME_FILE = join(getGlobalDataDir(), "ui-theme.json");

export function getUiTheme(tenant: TenantContext | undefined): UiTheme {
  const saved = tenant
    ? readTenants().users[tenant.userId]?.uiTheme
    : readDoc<{ uiTheme?: UiTheme }>(LOCAL_UI_THEME_FILE)?.uiTheme;
  return saved && UI_THEMES.includes(saved) ? saved : DEFAULT_UI_THEME;
}

export function setUiTheme(tenant: TenantContext | undefined, uiTheme: UiTheme) {
  if (!tenant) {
    writeDoc(LOCAL_UI_THEME_FILE, { uiTheme });
    return;
  }
  const data = readTenants();
  const record = data.users[tenant.userId];
  if (!record) return;
  record.uiTheme = uiTheme;
  record.updatedAt = new Date().toISOString();
  writeTenants(data);
}

type TenantsFile = {
  users: Record<string, TenantRecord>;
};

function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL?.replace(/\/+$/, "");
}

function supabaseAnonKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
}

export function isSupabaseAuthConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

export function getPublicAuthConfig() {
  return {
    enabled: isSupabaseAuthConfigured(),
    supabaseUrl: supabaseUrl() ?? null,
    supabaseAnonKey: supabaseAnonKey() ?? null,
  };
}

function readTenants(): TenantsFile {
  if (!docExists(TENANTS_FILE)) return { users: {} };
  try {
    return readDoc(TENANTS_FILE)!;
  } catch {
    return { users: {} };
  }
}

function writeTenants(data: TenantsFile) {
  const dir = getGlobalDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeDoc(TENANTS_FILE, data);
}

function readCookie(req: express.Request, name: string): string | undefined {
  const header = req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function cookieOptions(maxAge = 60 * 60): string {
  const parts = [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(res: express.Response, accessToken: string) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(accessToken)}; ${cookieOptions()}`);
}

export function clearSessionCookie(res: express.Response) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}

// Every authenticated request (including the UI's 10s poll, which fires
// several calls at once) would otherwise make a network round trip to
// Supabase. Verified sessions are cached briefly, keyed by a hash of the
// token so raw tokens aren't held as map keys. Trade-off: a token revoked
// at Supabase keeps working here for up to SESSION_CACHE_TTL_MS.
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 5_000;
const sessionCache = new Map<string, { user: SupabaseUser; expiresAt: number }>();
const sessionInflight = new Map<string, Promise<SupabaseUser>>();

async function verifyAccessToken(accessToken: string): Promise<SupabaseUser> {
  const key = createHash("sha256").update(accessToken).digest("base64url");
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  sessionCache.delete(key);

  // Parallel requests with the same token share one Supabase call.
  let pending = sessionInflight.get(key);
  if (!pending) {
    pending = fetchSupabaseUser(accessToken).finally(() => sessionInflight.delete(key));
    sessionInflight.set(key, pending);
  }
  const user = await pending;
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(key, { user, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  return user;
}

async function fetchSupabaseUser(accessToken: string): Promise<SupabaseUser> {
  const url = supabaseUrl();
  const anonKey = supabaseAnonKey();
  if (!url || !anonKey) throw new Error("Supabase auth is not configured");

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error("Invalid Supabase session");
  const user = (await res.json()) as SupabaseUser;
  if (!user.id) throw new Error("Supabase user response had no id");
  return user;
}

function tenantForUser(user: SupabaseUser): TenantContext {
  const data = readTenants();
  const existing = data.users[user.id];
  if (existing) {
    const email = user.email ?? existing.email;
    if (email !== existing.email) {
      existing.email = email;
      existing.updatedAt = new Date().toISOString();
      writeTenants(data);
    }
    return existing;
  }

  const now = new Date().toISOString();
  const name = user.user_metadata?.name ?? user.user_metadata?.full_name ?? "";
  const organizationName = user.user_metadata?.organization_name ?? "My Organization";
  const record: TenantRecord = {
    userId: user.id,
    email: user.email ?? "",
    name,
    organizationId: randomUUID(),
    organizationName,
    createdAt: now,
    updatedAt: now,
  };
  data.users[user.id] = record;
  writeTenants(data);
  return record;
}

export function listTenantContexts(): TenantContext[] {
  return Object.values(readTenants().users);
}

export function findTenantByOrganizationId(organizationId: string): TenantContext | undefined {
  return listTenantContexts().find((tenant) => tenant.organizationId === organizationId);
}

export async function readRequestTenant(req: express.Request): Promise<TenantContext> {
  const token = readCookie(req, COOKIE_NAME) ?? req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Missing session");
  if (token.startsWith(ERP_SESSION_PREFIX)) return verifyErpSessionCookieValue(token);
  return tenantForUser(await verifyAccessToken(token));
}

// --- ERP single-sign-on bridge ------------------------------------------
//
// Lets an ERP (its own, separate login system) redirect a signed-in user
// straight into CEO Agent, auto-provisioning that company's CEO Agent org
// on first click, without the user ever typing Supabase credentials. Three
// pieces, not to be confused with each other:
//
//  1. The ERP -> CEO Agent *handoff* token (verifyErpHandoff): minted by the
//     ERP's own backend, signed with ERP_SSO_SECRET — a secret shared only
//     between this server's process env and that ERP's backend (set once by
//     whoever operates both systems; see .env). It must be a single shared
//     secret, not a per-org one, because at verification time no CEO Agent
//     org may exist yet for this ERP company — that's the whole point of
//     auto-provisioning. Carries which ERP company + user is signing in.
//  2. tenantForErpOrg: finds-or-creates the CEO Agent org for that ERP
//     company (keyed by the ERP's own stable company id, `erpOrgId` —
//     never by email/name, which can change). First click creates it.
//  3. The CEO Agent *session* cookie value this produces (ERP_SESSION_PREFIX):
//     signed with a server-process secret, scoped only to "which org", and
//     is what readRequestTenant above recognizes on every later request —
//     it never touches Supabase.
//
// A real Supabase access token is a JWT (always two dots, no fixed prefix),
// so the ERP_SESSION_PREFIX string can never collide with one.
//
// The consent step (user must explicitly accept before the org is created /
// linked) lives in index.ts's GET/POST /sso/erp handlers: GET verifies the
// token and renders a confirm page, POST (only reached by the user clicking
// Allow) calls completeErpSignIn below.
const ERP_SESSION_PREFIX = "erpsso:";
const ERP_SESSION_SECRET = randomBytes(32);
const ERP_SESSION_TTL_SEC = 60 * 60;

function signErpSession(payload: string): string {
  return createHmac("sha256", ERP_SESSION_SECRET).update(payload).digest("base64url");
}

function createErpSessionValue(organizationId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ o: organizationId, e: Date.now() + ERP_SESSION_TTL_SEC * 1000 }),
  ).toString("base64url");
  return `${ERP_SESSION_PREFIX}${payload}.${signErpSession(payload)}`;
}

function verifyErpSessionCookieValue(token: string): TenantContext {
  const body = token.slice(ERP_SESSION_PREFIX.length);
  const [payload, signature] = body.split(".");
  if (!payload || !signature) throw new Error("Malformed ERP session");
  const expected = signErpSession(payload);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error("Invalid ERP session");
  }
  const { o: organizationId, e: expiresAt } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
    o: string;
    e: number;
  };
  if (Date.now() > expiresAt) throw new Error("ERP session expired — please click through from the ERP again");
  const tenant = findTenantByOrganizationId(organizationId);
  if (!tenant) throw new Error("Unknown organization for ERP session");
  return tenant;
}

export function setErpSessionCookie(res: express.Response, organizationId: string) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(createErpSessionValue(organizationId))}; ${cookieOptions(ERP_SESSION_TTL_SEC)}`,
  );
}

export interface ErpHandoffClaims {
  /** Stable id of the company/tenant inside the ERP — NOT the end user's id. One CEO Agent org per erpOrgId. */
  erpOrgId: string;
  erpUserId: string;
  email?: string;
  name?: string;
  /** Display name for the CEO Agent org, used only the first time this erpOrgId is seen. */
  orgName?: string;
}

/**
 * Verifies a one-time handoff token minted by the ERP's backend. `token` is
 * `<base64url JSON payload>.<base64url HMAC-SHA256 signature>`, signed with
 * ERP_SSO_SECRET (server env — shared with the ERP's backend only, never
 * exposed to its frontend). The payload must include `exp` (epoch ms); 5
 * minutes is plenty since the ERP mints it immediately before redirecting.
 * Deliberately does NOT create or touch any tenant — that only happens once
 * the user accepts the consent prompt (completeErpSignIn, below).
 */
export function verifyErpHandoff(token: string): ErpHandoffClaims {
  const secret = process.env.ERP_SSO_SECRET;
  if (!secret) throw new Error("ERP SSO is not configured on this server — set ERP_SSO_SECRET");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Malformed SSO token");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    throw new Error("Invalid SSO signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as ErpHandoffClaims & {
    exp: number;
  };
  if (typeof claims.exp !== "number" || Date.now() > claims.exp) throw new Error("SSO token expired — click the button again");
  if (!claims.erpOrgId || !claims.erpUserId) throw new Error("SSO token missing erpOrgId/erpUserId");
  return claims;
}

/** Finds the CEO Agent org already linked to this ERP company, if any — read-only, used to render the consent page. */
export function findTenantByErpOrgId(erpOrgId: string): TenantContext | undefined {
  return readTenants().users[`erp:${erpOrgId}`];
}

/**
 * Called only after the user accepts the consent prompt. Finds the CEO
 * Agent org already linked to this ERP company (by erpOrgId), or creates
 * one on first use. Returns the tenant to log the browser into.
 */
export function completeErpSignIn(claims: ErpHandoffClaims): TenantContext {
  const data = readTenants();
  const key = `erp:${claims.erpOrgId}`;
  const existing = data.users[key];
  if (existing) {
    let changed = false;
    if (claims.email && claims.email !== existing.email) {
      existing.email = claims.email;
      changed = true;
    }
    if (claims.name && claims.name !== existing.name) {
      existing.name = claims.name;
      changed = true;
    }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      writeTenants(data);
    }
    return existing;
  }

  const now = new Date().toISOString();
  const record: TenantRecord = {
    userId: key,
    email: claims.email ?? "",
    name: claims.name ?? "",
    organizationId: randomUUID(),
    organizationName: claims.orgName ?? "My Organization",
    createdAt: now,
    updatedAt: now,
  };
  data.users[key] = record;
  writeTenants(data);
  return record;
}

declare global {
  namespace Express {
    interface Request {
      // Stashed by requireAuth alongside the AsyncLocalStorage context (see
      // restoreTenant below) since multer's multipart parsing runs the rest
      // of the middleware chain outside that context — it isn't a plain
      // Promise continuation, so Node's async-context propagation doesn't
      // carry it through busboy's stream handling.
      tenant?: TenantContext;
      /** Exact request bytes, kept for /webhook/* routes so signatures can be verified. */
      rawBody?: Buffer;
    }
  }
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.originalUrl.startsWith("/api/automation/")) {
    next();
    return;
  }
  readRequestTenant(req)
    .then((tenant) => {
      req.tenant = tenant;
      runWithTenant(tenant, next);
    })
    .catch(() => {
      // req.path is relative to this middleware's /api mount point (Express
      // strips the prefix), so it never starts with "/api/" — check
      // originalUrl instead, or every failed-auth API call falls through to
      // the HTML redirect below and breaks any client doing res.json().
      if (req.originalUrl.startsWith("/api/")) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      res.redirect("/");
    });
}

// Re-establishes the tenant AsyncLocalStorage context after a multer upload
// middleware, which loses it (see the Request.tenant comment above). Mount
// this right after `upload.single(...)`/`upload.array(...)` on any route
// whose handler resolves tenant-scoped storage (getDataDir/getWorkspaceDir/
// etc.) — otherwise those calls silently fall back to the untenanted base
// dir instead of throwing, so the bug shows up as "not found" errors on
// paths that plainly exist.
export function restoreTenant(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.tenant) {
    runWithTenant(req.tenant, next);
  } else {
    next();
  }
}

/** Constant-time string compare, so the API key can't be guessed byte-by-byte from response timing. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Each organization authenticates automation calls with its OWN key, set in
// that org's Settings (AUTOMATION_API_KEY is org-only — see settings.ts, it
// never falls back to the server env for an org). A single server-wide key
// would let anyone holding it act as every organization just by changing
// the X-Organization-Id header.
export function requireAutomationTenant(req: express.Request, res: express.Response, next: express.NextFunction) {
  const organizationId = req.header("X-Organization-Id");
  if (!organizationId) {
    res.status(400).json({ error: "X-Organization-Id header is required" });
    return;
  }
  const tenant = findTenantByOrganizationId(organizationId);
  const presented = req.header("X-API-Key") ?? "";
  // Same response for "unknown org", "org has no key" and "wrong key", so
  // the endpoint can't be used to probe which organization IDs exist.
  const reject = () => res.status(401).json({ error: "invalid X-API-Key or X-Organization-Id" });
  if (!tenant) {
    reject();
    return;
  }
  runWithTenant(tenant, () => {
    const configuredKey = getEnvValue("AUTOMATION_API_KEY");
    if (!configuredKey || !presented || !safeEqual(presented, configuredKey)) {
      reject();
      return;
    }
    req.tenant = tenant;
    next();
  });
}
