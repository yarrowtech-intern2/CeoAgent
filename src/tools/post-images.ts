import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { uploadMediaToZernio, publishZernioPost } from "./zernio.js";
import { getDataDir } from "../paths.js";

// A plain folder on disk, not under WORKSPACE_DIR — these files come from the
// user dropping them in directly (e.g. via Explorer/Finder or a synced
// drive), not from an agent tool call, so the workspace.ts note about
// delegated-subagent writes silently no-op'ing outside WORKSPACE_DIR doesn't
// apply here; this only ever gets read from, never written to, by the agent.
export const POST_IMAGES_DIR = join(getDataDir(), "post-images");
if (!existsSync(POST_IMAGES_DIR)) mkdirSync(POST_IMAGES_DIR, { recursive: true });

// Instagram only accepts JPEG/PNG (docs.zernio.com/platforms/instagram,
// checked 2026-08) — filtering here instead of at post time gives a clean
// "not found" instead of a late Zernio-side rejection for e.g. a stray .webp.
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const CONTENT_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

async function ensureDir() {
  if (!existsSync(POST_IMAGES_DIR)) mkdirSync(POST_IMAGES_DIR, { recursive: true });
}

const listPostImages = tool(
  "list_post_images",
  `List image files available to post from the local drop folder (${POST_IMAGES_DIR}). Use this before post_folder_image to see what's there and confirm the filename with the user.`,
  {},
  async () => {
    await ensureDir();
    const entries = await readdir(POST_IMAGES_DIR);
    const images = entries.filter((name) => ALLOWED_EXTENSIONS.has(extname(name).toLowerCase()));
    if (!images.length) {
      return {
        content: [
          { type: "text" as const, text: `No images found. Drop .jpg/.jpeg/.png files into ${POST_IMAGES_DIR} and try again.` },
        ],
      };
    }
    const lines = await Promise.all(
      images.map(async (name) => {
        const { size } = await stat(join(POST_IMAGES_DIR, name));
        return `- ${name} (${(size / 1024).toFixed(0)} KB)`;
      }),
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const postFolderImage = tool(
  "post_folder_image",
  "Upload an image from the local drop folder and publish it as a post to one or more connected platforms via Zernio. Irreversible and immediately public once sent — describe the filename, caption, and target platforms back to the user and only call this when explicitly told to post (not just draft). Look up the filename with list_post_images and accountId values with list_zernio_accounts first.",
  {
    filename: z.string().describe("Exact filename from list_post_images"),
    content: z.string().describe("Post caption/body text"),
    platforms: z
      .array(
        z.object({
          platform: z.string().describe("e.g. twitter, instagram, facebook, linkedin, tiktok, threads"),
          accountId: z.string().describe("Account ID from list_zernio_accounts"),
        }),
      )
      .min(1),
  },
  async ({ filename, content, platforms }) => {
    const ext = extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return { content: [{ type: "text" as const, text: `Unsupported file type "${ext}" — only .jpg/.jpeg/.png are supported.` }], isError: true };
    }
    const filePath = join(POST_IMAGES_DIR, filename);
    if (!existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: `"${filename}" not found in the drop folder — check list_post_images.` }], isError: true };
    }

    try {
      const buffer = await readFile(filePath);
      const publicUrl = await uploadMediaToZernio(buffer, filename, CONTENT_TYPES[ext]);
      const { id, status } = await publishZernioPost({ content, platforms, imageUrl: publicUrl });
      return {
        content: [
          {
            type: "text" as const,
            text: `Posted "${filename}" via Zernio to ${platforms.map((p) => p.platform).join(", ")} (post id: ${id}, status: ${status}).`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error posting via Zernio: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

export const POST_IMAGES_TOOLS = ["mcp__post_images__list_post_images", "mcp__post_images__post_folder_image"];

export const postImagesServer = createSdkMcpServer({
  name: "post_images",
  version: "1.0.0",
  instructions: `Tools for posting images the user has placed in a local drop folder (${POST_IMAGES_DIR}) to connected social platforms via Zernio.`,
  tools: [listPostImages, postFolderImage],
});
