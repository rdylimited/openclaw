import { Type } from "@sinclair/typebox";
import Handlebars from "handlebars";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { storeDocument } from "../core/document-store.js";
import { createTenantClient } from "../core/supabase.js";
import { textResult, jsonResult, errorResult, type ToolResult } from "../core/types.js";

async function renderToPdf(html: string): Promise<Buffer> {
  // Dynamic import to avoid hard dependency at module load time
  const puppeteer = await import("puppeteer-core");

  const browser = await puppeteer.default.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env["PUPPETEER_EXECUTABLE_PATH"] ?? "/usr/bin/chromium-browser",
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

export function createDocGenerateTool(config: BizConfig) {
  return {
    name: "doc_doc_generate",
    label: "Document Generate",
    description:
      "Render a document template with provided variables. Supports HTML output (returned directly) or PDF output (stored and returned as document ID + URL).",
    parameters: Type.Object({
      template_id: Type.String({ description: "UUID of the document template to render" }),
      variables: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Key/value pairs to pass into the Handlebars template",
        }),
      ),
      output_format: Type.Optional(
        Type.Union([Type.Literal("html"), Type.Literal("pdf")], {
          description: 'Output format: "html" (default) or "pdf"',
          default: "html",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const templateId = params["template_id"] as string | undefined;
      if (!templateId) return errorResult("template_id is required");

      const variables = (params["variables"] as Record<string, unknown>) ?? {};
      const outputFormat = (params["output_format"] as "html" | "pdf") ?? "html";

      const db = createTenantClient(config);

      try {
        // Fetch template
        const { data: template, error: templateError } = await db.client
          .from("document_templates")
          .select("*")
          .eq("tenant_id", db.tenantId)
          .eq("id", templateId)
          .eq("active", true)
          .single();

        if (templateError || !template) {
          return errorResult(
            `Template not found or inactive: ${templateError?.message ?? templateId}`,
          );
        }

        // Render with Handlebars
        let renderedHtml: string;
        try {
          const compiledTemplate = Handlebars.compile(template.body_html as string);
          renderedHtml = compiledTemplate(variables);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Template rendering failed: ${message}`);
        }

        if (outputFormat === "html") {
          await writeAuditLog(db, {
            entity_type: "document",
            entity_id: templateId,
            action: "create",
            actor: _id,
            payload: { template_id: templateId, output_format: "html" },
          });

          return textResult(renderedHtml, { template_id: templateId, output_format: "html" });
        }

        // PDF generation
        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await renderToPdf(renderedHtml);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`PDF generation failed: ${message}`);
        }

        const documentName = `${(template.name as string).replace(/[^a-z0-9]/gi, "_")}_${Date.now()}.pdf`;

        const documentId = await storeDocument(db, pdfBuffer, {
          type: template.type as string,
          name: documentName,
          mime_type: "application/pdf",
          storage_path: "",
          version: 1,
          source_type: "document_template",
          source_id: templateId,
        });

        await writeAuditLog(db, {
          entity_type: "document",
          entity_id: documentId,
          action: "create",
          actor: _id,
          payload: { template_id: templateId, output_format: "pdf" },
        });

        return jsonResult(
          { document_id: documentId, template_id: templateId, output_format: "pdf" },
          `PDF document stored: ${documentId}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Document generation failed: ${message}`);
      }
    },
  };
}
