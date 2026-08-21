import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { uploadMediaToZernio } from "./zernio.js";

const IMAGES_URL = "https://api.openai.com/v1/images/generations";

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return key;
}

export function isImageGenConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// gpt-image-1 always returns base64 (no hosted `url` field, unlike older
// DALL-E response formats) — confirmed against OpenAI's current docs
// (2026-08). We upload that straight to Zernio's media store via the same
// presign flow post_folder_image uses, so the result is one public URL that
// works both as a preview link for the user and as create_zernio_post's
// imageUrl once approved.
const generateImage = tool(
  "generate_image",
  "Generate an image from a text prompt and upload it for preview. Returns a public URL — show it to the user and get explicit approval before passing it to create_zernio_post as imageUrl; this tool only generates, it never posts.",
  {
    prompt: z.string().describe("Description of the image to generate"),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024").describe("1024x1024 square, 1536x1024 landscape, 1024x1536 portrait"),
  },
  async ({ prompt, size }) => {
    const res = await fetch(IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size, n: 1 }),
    });
    if (!res.ok) {
      return { content: [{ type: "text" as const, text: `Error generating image: ${res.status} ${await res.text()}` }], isError: true };
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      return { content: [{ type: "text" as const, text: "OpenAI response had no image data." }], isError: true };
    }

    try {
      const buffer = Buffer.from(b64, "base64");
      const publicUrl = await uploadMediaToZernio(buffer, `generated-${randomUUID()}.png`, "image/png");
      return {
        content: [
          {
            type: "text" as const,
            text: `Generated image, uploaded for review: ${publicUrl}\n\nShow this link to the user before posting. Once approved, call create_zernio_post with this URL as imageUrl.`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Image generated but upload for preview failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

export const IMAGE_GEN_TOOLS = ["mcp__image_gen__generate_image"];

export const imageGenServer = createSdkMcpServer({
  name: "image_gen",
  version: "1.0.0",
  instructions: "Tool for generating an AI image and getting a public preview URL, for use with create_zernio_post.",
  tools: [generateImage],
});
