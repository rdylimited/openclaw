import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { jsonResult, errorResult, type ToolResult } from "../core/types.js";

const RECEIPT_PROMPT = `You are a receipt parsing assistant. Extract all receipt data from the provided content and return a single JSON object with exactly these fields:

{
  "vendor": "string — business name",
  "date": "string — date of transaction (YYYY-MM-DD if determinable, else original text)",
  "currency": "string — ISO 4217 currency code (e.g. HKD, USD)",
  "items": [
    {
      "description": "string",
      "quantity": "number or null",
      "unit_price": "string decimal or null",
      "amount": "string decimal"
    }
  ],
  "subtotal": "string decimal or null",
  "tax": "string decimal or null",
  "total": "string decimal",
  "payment_method": "string or null",
  "reference_number": "string or null"
}

Return ONLY the JSON object, no markdown fences, no explanation.`;

export function createReceiptProcessTool(config: BizConfig) {
  return {
    name: "doc_receipt_process",
    label: "Receipt Process",
    description:
      "Parse a receipt from raw OCR text or an image and extract structured data: vendor, date, line items, totals, payment method, and reference number.",
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Raw OCR text of the receipt" })),
      image_url: Type.Optional(
        Type.String({ description: "Publicly accessible URL of the receipt image" }),
      ),
      image_base64: Type.Optional(Type.String({ description: "Base64-encoded receipt image" })),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const text = params["text"] as string | undefined;
      const imageUrl = params["image_url"] as string | undefined;
      const imageBase64 = params["image_base64"] as string | undefined;

      if (!text && !imageUrl && !imageBase64) {
        return errorResult("One of text, image_url, or image_base64 is required");
      }

      try {
        type MessageContent =
          | string
          | Array<
              { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
            >;

        let userContent: MessageContent;

        if (text) {
          userContent = `${RECEIPT_PROMPT}\n\nReceipt text:\n${text}`;
        } else {
          const imageContent: { type: "image_url"; image_url: { url: string } } = imageUrl
            ? { type: "image_url", image_url: { url: imageUrl } }
            : {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
              };

          userContent = [imageContent, { type: "text", text: RECEIPT_PROMPT }];
        }

        const response = await fetch(`${config.vllmBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.vllmModel,
            stream: false,
            max_tokens: 2048,
            messages: [{ role: "user", content: userContent }],
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return errorResult(`vLLM request failed (${response.status}): ${errorText}`);
        }

        const completion = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const raw = completion.choices?.[0]?.message?.content ?? "";

        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) {
          return errorResult(
            `Could not extract JSON from model response. Raw: ${raw.slice(0, 200)}`,
          );
        }

        let receipt: unknown;
        try {
          receipt = JSON.parse(match[0]);
        } catch {
          return errorResult(`Failed to parse extracted JSON: ${match[0].slice(0, 200)}`);
        }

        return jsonResult(receipt, "Parsed receipt data");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Receipt processing failed: ${message}`);
      }
    },
  };
}
