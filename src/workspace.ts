import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every agent session (CEO-routed or direct-to-specialist) runs with its cwd
// here — a sandbox this app owns, never the CEO Agent OS's own source code.
// This is what makes it safe to give the Developer agent real Bash/file
// access. It's also load-bearing beyond Developer: file writes *outside* this
// directory silently fail when made by a CEO-delegated (async/background)
// subagent — confirmed by comparing Developer (writes inside cwd, works via
// delegation) against the documents store (used to live in ../data, outside
// cwd, and silently no-op'd for delegated runs while working fine for direct
// runs). Anything a tool handler writes to disk on an agent's behalf needs to
// live under WORKSPACE_DIR for that reason, not just for sandboxing.
export const WORKSPACE_DIR = join(__dirname, "..", "workspace");
if (!existsSync(WORKSPACE_DIR)) mkdirSync(WORKSPACE_DIR, { recursive: true });
