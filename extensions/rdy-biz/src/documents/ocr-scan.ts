import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { textResult, errorResult, type ToolResult } from "../core/types.js";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "image/jpeg";
}

async function buildImageContent(
  imageUrl?: string,
  imageBase64?: string,
  filePath?: string,
  mimeType?: string,
): Promise<{ type: "image_url"; image_url: { url: string } }> {
  if (imageUrl) {
    return { type: "image_url", image_url: { url: imageUrl } };
  }

  if (imageBase64) {
    const mime = mimeType ?? "image/jpeg";
    return {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${imageBase64}` },
    };
  }

  if (filePath) {
    const buffer = await readFile(filePath);
    const mime = detectMime(filePath);
    const base64 = buffer.toString("base64");
    return {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    };
  }

  throw new Error("One of image_url, image_base64, or file_path is required");
}

export function createOcrScanTool(config: BizConfig) {
  return {
    name: "doc_ocr_scan",
    label: "OCR Scan",
    description:
      "Extract text from an image using the rdycore-pro vision model. Provide an image URL, base64-encoded image, or a local file path.",
    parameters: Type.Object({
      image_url: Type.Optional(
        Type.String({ description: "Publicly accessible URL of the image to OCR" }),
      ),
      image_base64: Type.Optional(Type.String({ description: "Base64-encoded image data" })),
      file_path: Type.Optional(Type.String({ description: "Absolute path to a local image file" })),
      language: Type.Optional(
        Type.String({ description: "Optional language hint for OCR (e.g. 'zh', 'en')" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const imageUrl = params["image_url"] as string | undefined;
      const imageBase64 = params["image_base64"] as string | undefined;
      const filePath = params["file_path"] as string | undefined;
      const language = params["language"] as string | undefined;

      if (!imageUrl && !imageBase64 && !filePath) {
        return errorResult("One of image_url, image_base64, or file_path is required");
      }

      try {
        const imageContent = await buildImageContent(imageUrl, imageBase64, filePath);

        const languageHint = language ? ` The primary language in the image is ${language}.` : "";

        const prompt = `Extract all text from this image verbatim. Preserve the original layout as closely as possible using line breaks.${languageHint} Return only the extracted text with no additional commentary.`;

        const response = await fetch(`${config.vllmBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.vllmModel,
            stream: false,
            max_tokens: 4096,
            messages: [
              {
                role: "user",
                content: [imageContent, { type: "text", text: prompt }],
              },
            ],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return errorResult(`vLLM request failed (${response.status}): ${errorText}`);
        }

        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const extractedText = json.choices?.[0]?.message?.content ?? "";

        if (!extractedText) {
          return errorResult("No text extracted from the image");
        }

        return textResult(extractedText, { model: config.vllmModel });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`OCR scan failed: ${message}`);
      }
    },
  };
}
