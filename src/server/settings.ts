import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../paths.js";

const SETTINGS_FILE = join(getDataDir(), "settings.json");

interface FieldMeta {
  envVar: string;
  label: string;
  group: string;
}

// Every credential from .env.example except PORT and the *_REDIRECT_URI
// vars — those stay env-only. Gmail/Instagram/LinkedIn redirect URIs are
// pre-registered in each provider's developer console against this app's
// fixed default port (3000); exposing them here would let a user silently
// break OAuth logins by editing a field with no visible connection to that
// registration.
const FIELDS: FieldMeta[] = [
  { envVar: "ANTHROPIC_API_KEY", label: "Anthropic API key", group: "Anthropic" },
  { envVar: "LINEAR_API_KEY", label: "Linear API key", group: "Linear" },
  { envVar: "LINEAR_TEAM_ID", label: "Linear team ID", group: "Linear" },
  { envVar: "GOOGLE_CLIENT_ID", label: "Google client ID", group: "Gmail" },
  { envVar: "GOOGLE_CLIENT_SECRET", label: "Google client secret", group: "Gmail" },
  { envVar: "META_APP_ID", label: "Meta app ID", group: "Instagram" },
  { envVar: "META_APP_SECRET", label: "Meta app secret", group: "Instagram" },
  { envVar: "LINKEDIN_CLIENT_ID", label: "LinkedIn client ID", group: "LinkedIn" },
  { envVar: "LINKEDIN_CLIENT_SECRET", label: "LinkedIn client secret", group: "LinkedIn" },
  { envVar: "ZERNIO_API_KEY", label: "Zernio API key", group: "Zernio" },
  { envVar: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp access token", group: "WhatsApp" },
  { envVar: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp phone number ID", group: "WhatsApp" },
  { envVar: "WHATSAPP_BUSINESS_ACCOUNT_ID", label: "WhatsApp business account ID", group: "WhatsApp" },
  { envVar: "OPENAI_API_KEY", label: "OpenAI API key", group: "Image generation" },
  { envVar: "AUTOMATION_API_KEY", label: "Automation API key", group: "Automation" },
  { envVar: "WEBHOOK_URL", label: "Webhook URL", group: "Automation" },
  { envVar: "N8N_WORKFLOWS", label: "n8n workflows (JSON)", group: "Automation" },
];

type SettingsFile = Record<string, string>;

function readSettingsFile(): SettingsFile {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettingsFile(data: SettingsFile) {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Populates process.env from the persisted settings file — called once at
 * server startup. Only fills in vars that aren't already set, so a dev
 * `.env` (loaded earlier via dotenv/config) always wins over settings.json,
 * and packaged installs (no .env) are driven entirely by settings.json.
 */
export function loadSettingsIntoEnv() {
  const saved = readSettingsFile();
  for (const { envVar } of FIELDS) {
    if (!process.env[envVar] && saved[envVar]) {
      process.env[envVar] = saved[envVar];
    }
  }
}

function mask(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export interface MaskedField {
  envVar: string;
  label: string;
  group: string;
  isSet: boolean;
  masked: string | null;
}

export function getMaskedSettings(): MaskedField[] {
  return FIELDS.map(({ envVar, label, group }) => {
    const value = process.env[envVar];
    return {
      envVar,
      label,
      group,
      isSet: Boolean(value),
      masked: value ? mask(value) : null,
    };
  });
}

/**
 * Applies any non-blank fields from `partial` to both settings.json and
 * process.env immediately. Every credential this app reads is read lazily,
 * per-call (confirmed across zernio.ts, whatsapp.ts, image-gen.ts, linear.ts,
 * n8n.ts, gmail.ts, instagram.ts, linkedin.ts), so this takes effect with no
 * server restart. Blank/omitted fields are left untouched — the frontend
 * never re-sends a real secret value (only a masked placeholder), so this
 * also protects against a blank field silently wiping an already-saved key.
 */
export function updateSettings(partial: Record<string, unknown>): MaskedField[] {
  const known = new Set(FIELDS.map((f) => f.envVar));
  const saved = readSettingsFile();
  let changed = false;
  for (const [key, value] of Object.entries(partial)) {
    if (!known.has(key) || typeof value !== "string" || value.trim() === "") continue;
    saved[key] = value;
    process.env[key] = value;
    changed = true;
  }
  if (changed) writeSettingsFile(saved);
  return getMaskedSettings();
}
