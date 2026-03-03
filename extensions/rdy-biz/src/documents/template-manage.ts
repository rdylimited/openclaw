import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { jsonResult, textResult, errorResult, type ToolResult } from "../core/types.js";

type TemplateAction = "create" | "get" | "update" | "list" | "deactivate";

export function createTemplateManageTool(config: BizConfig) {
  return {
    name: "doc_template_manage",
    label: "Template Manage",
    description:
      "CRUD operations on document templates. Actions: create, get, update, list, deactivate.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("deactivate"),
        ],
        { description: "Operation to perform" },
      ),
      template_id: Type.Optional(
        Type.String({ description: "Template UUID — required for get, update, deactivate" }),
      ),
      name: Type.Optional(Type.String({ description: "Template name — required for create" })),
      type: Type.Optional(
        Type.String({
          description:
            "Template type (e.g. invoice, contract, receipt) — required for create; used as filter for list",
        }),
      ),
      body_html: Type.Optional(
        Type.String({ description: "Handlebars HTML template body — required for create" }),
      ),
      variables_schema: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON schema describing expected template variables",
        }),
      ),
      active: Type.Optional(Type.Boolean({ description: "Filter by active status (list only)" })),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params["action"] as TemplateAction;
      const db = createTenantClient(config);

      try {
        switch (action) {
          case "create": {
            const name = params["name"] as string | undefined;
            const type = params["type"] as string | undefined;
            const bodyHtml = params["body_html"] as string | undefined;

            if (!name) return errorResult("name is required for create");
            if (!type) return errorResult("type is required for create");
            if (!bodyHtml) return errorResult("body_html is required for create");

            const { data, error } = await db.client
              .from("document_templates")
              .insert({
                tenant_id: db.tenantId,
                name,
                type,
                body_html: bodyHtml,
                variables_schema: params["variables_schema"] ?? null,
                active: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .select()
              .single();

            if (error) return errorResult(`Create failed: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "document_template",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, type },
            });

            return jsonResult(data, `Template created: ${data.id}`);
          }

          case "get": {
            const templateId = params["template_id"] as string | undefined;
            if (!templateId) return errorResult("template_id is required for get");

            const { data, error } = await db.client
              .from("document_templates")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", templateId)
              .single();

            if (error) return errorResult(`Template not found: ${error.message}`);

            return jsonResult(data);
          }

          case "update": {
            const templateId = params["template_id"] as string | undefined;
            if (!templateId) return errorResult("template_id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };
            if (params["name"] !== undefined) updates["name"] = params["name"];
            if (params["type"] !== undefined) updates["type"] = params["type"];
            if (params["body_html"] !== undefined) updates["body_html"] = params["body_html"];
            if (params["variables_schema"] !== undefined)
              updates["variables_schema"] = params["variables_schema"];
            if (params["active"] !== undefined) updates["active"] = params["active"];

            const { data, error } = await db.client
              .from("document_templates")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", templateId)
              .select()
              .single();

            if (error) return errorResult(`Update failed: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "document_template",
              entity_id: templateId,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Template updated: ${templateId}`);
          }

          case "list": {
            let query = db.client
              .from("document_templates")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false });

            if (params["type"] !== undefined) {
              query = query.eq("type", params["type"] as string);
            }
            if (params["active"] !== undefined) {
              query = query.eq("active", params["active"] as boolean);
            }

            const { data, error } = await query;
            if (error) return errorResult(`List failed: ${error.message}`);

            return jsonResult(data, `Found ${data?.length ?? 0} templates`);
          }

          case "deactivate": {
            const templateId = params["template_id"] as string | undefined;
            if (!templateId) return errorResult("template_id is required for deactivate");

            const { error } = await db.client
              .from("document_templates")
              .update({ active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", templateId);

            if (error) return errorResult(`Deactivate failed: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "document_template",
              entity_id: templateId,
              action: "update",
              actor: _id,
              payload: { active: false },
            });

            return textResult(`Template ${templateId} deactivated`);
          }

          default:
            return errorResult(`Unknown action: ${String(action)}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Template operation failed: ${message}`);
      }
    },
  };
}
