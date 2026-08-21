// Backing implementation for the human-facing "Files" browser (VS Code-style
// tree in the UI). Deliberately separate from tools/documents.ts, which is
// the *agent*-facing deliverable store — this module exposes real folders on
// disk (data/, deliverables/, the agent workspace/) read-only-by-default to
// the browser, with upload as the one write path.
import { promises as fs } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { WORKSPACE_DIR } from "../workspace.js";
import { getDataDir, getDeliverablesDir } from "../paths.js";

export interface FileRoot {
  key: string;
  label: string;
  dir: string;
}

// The only three real directories the browser can ever resolve into. Every
// path from the client starts with one of these keys — there is no way to
// address any other location on disk through this API.
export const FILE_ROOTS: FileRoot[] = [
  { key: "data", label: "Company Data", dir: getDataDir() },
  { key: "deliverables", label: "Deliverables", dir: getDeliverablesDir() },
  { key: "workspace", label: "Agent Files", dir: WORKSPACE_DIR },
];

const ROOTS_BY_KEY = new Map(FILE_ROOTS.map((r) => [r.key, r]));

// Names hidden from the tree everywhere: dotfiles/dotfolders (incl.
// workspace/.documents, the agent-facing document index — that has its own
// UI already), OS/Office junk, and this app's own internal state files that
// aren't meaningful to a human browsing "their" files.
const HIDDEN_NAMES = new Set(["runs.json", "schedules.json", "Thumbs.db", "desktop.ini", ".DS_Store"]);
const HIDDEN_PATTERNS = [/^\./, /^~\$/, /token\.json$/i];

function isHidden(name: string): boolean {
  if (HIDDEN_NAMES.has(name)) return true;
  return HIDDEN_PATTERNS.some((p) => p.test(name));
}

export class FilesApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ResolvedPath {
  root: FileRoot;
  relPath: string; // path within the root, "" for the root itself, forward-slash separated
  absPath: string;
}

// virtualPath looks like "data/Projects/EEC" or "deliverables" or "" (the
// top-level roots listing). Resolves it to a real filesystem path, refusing
// anything that would escape its root (traversal via "..", absolute paths
// smuggled in a segment, etc.) or that names a hidden entry.
export function resolveVirtualPath(virtualPath: string): ResolvedPath {
  const clean = (virtualPath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!clean) throw new FilesApiError(400, "path is required");

  const segments = clean.split("/").filter(Boolean);
  const [rootKey, ...rest] = segments;
  const root = ROOTS_BY_KEY.get(rootKey);
  if (!root) throw new FilesApiError(404, `unknown root: ${rootKey}`);

  if (rest.some((s) => s === "." || s === ".." || isHidden(s))) {
    throw new FilesApiError(400, "invalid path");
  }

  const absPath = resolve(root.dir, ...rest);
  const withinRoot = absPath === root.dir || absPath.startsWith(root.dir + sep);
  if (!withinRoot) throw new FilesApiError(400, "invalid path");

  return { root, relPath: rest.join("/"), absPath };
}

export interface FileEntry {
  name: string;
  path: string; // virtual path, relative to the files API root ("" excluded)
  type: "dir" | "file";
  size: number | null;
  modifiedAt: string | null;
}

export function listRoots(): FileEntry[] {
  return FILE_ROOTS.map((r) => ({
    name: r.label,
    path: r.key,
    type: "dir" as const,
    size: null,
    modifiedAt: null,
  }));
}

export async function listDirectory(virtualPath: string): Promise<FileEntry[]> {
  if (!virtualPath) return listRoots();

  const resolved = resolveVirtualPath(virtualPath);
  await fs.mkdir(resolved.absPath, { recursive: true }).catch(() => {});
  let dirents;
  try {
    dirents = await fs.readdir(resolved.absPath, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new FilesApiError(404, "not found");
    if (err?.code === "ENOTDIR") throw new FilesApiError(400, "not a folder");
    throw err;
  }

  const entries = await Promise.all(
    dirents
      .filter((d) => !isHidden(d.name) && (d.isDirectory() || d.isFile()))
      .map(async (d) => {
        const abs = join(resolved.absPath, d.name);
        const stat = await fs.stat(abs).catch(() => null);
        return {
          name: d.name,
          path: `${resolved.root.key}/${[resolved.relPath, d.name].filter(Boolean).join("/")}`,
          type: d.isDirectory() ? ("dir" as const) : ("file" as const),
          size: stat && !d.isDirectory() ? stat.size : null,
          modifiedAt: stat ? stat.mtime.toISOString() : null,
        };
      }),
  );

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return entries;
}

export async function statPath(virtualPath: string) {
  const resolved = resolveVirtualPath(virtualPath);
  const stat = await fs.stat(resolved.absPath).catch(() => null);
  if (!stat) throw new FilesApiError(404, "not found");
  return { resolved, stat };
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_LIMITS = { fileSize: MAX_UPLOAD_BYTES, files: 20 };

// Sanitizes an uploaded file's declared name down to a bare, safe basename,
// then avoids clobbering an existing file by appending " (n)" — the same
// "never silently overwrite" behavior a desktop file manager gives you,
// which matters more here since these files may be things an agent is
// relying on.
export async function saveUpload(targetVirtualPath: string, originalName: string, data: Buffer): Promise<FileEntry> {
  const resolved = resolveVirtualPath(targetVirtualPath);
  const stat = await fs.stat(resolved.absPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new FilesApiError(400, "target folder does not exist");

  const safeName = basename(originalName.replace(/\\/g, "/")).trim();
  if (!safeName || isHidden(safeName)) throw new FilesApiError(400, `invalid file name: ${originalName}`);

  const dotIndex = safeName.lastIndexOf(".");
  const stem = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const ext = dotIndex > 0 ? safeName.slice(dotIndex) : "";

  let finalName = safeName;
  let n = 1;
  while (await fs.stat(join(resolved.absPath, finalName)).then(() => true, () => false)) {
    finalName = `${stem} (${n})${ext}`;
    n += 1;
  }

  const destAbs = join(resolved.absPath, finalName);
  await fs.writeFile(destAbs, data);
  const written = await fs.stat(destAbs);
  return {
    name: finalName,
    path: `${resolved.root.key}/${[resolved.relPath, finalName].filter(Boolean).join("/")}`,
    type: "file",
    size: written.size,
    modifiedAt: written.mtime.toISOString(),
  };
}
