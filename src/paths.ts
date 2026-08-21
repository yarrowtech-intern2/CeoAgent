import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The packaged Electron app sets CEO_AGENT_DATA_DIR to a per-user writable
// folder (app.getPath('userData')) before starting the server, since the
// install directory itself (e.g. under Program Files) isn't writable by a
// normal user at runtime. In dev (tsx against source), this is unset and
// everything falls back to the project-root data/workspace dirs, unchanged
// from before this helper existed.
const BASE_DIR = process.env.CEO_AGENT_DATA_DIR ?? join(__dirname, "..");

export function getDataDir(): string {
  return join(BASE_DIR, "data");
}

export function getWorkspaceDir(): string {
  return join(BASE_DIR, "workspace");
}

export function getDeliverablesDir(): string {
  return join(BASE_DIR, "deliverables");
}
