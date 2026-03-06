import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createBomManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_bom_manage",
    label: "Procurement: Bill of Materials Management",
    description:
      "Create, retrieve, update, list, add lines to, activate, or obsolete bills of materials (BOMs). Supports multi-level BOMs with sub-assemblies.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("add_line"),
          Type.Literal("activate"),
          Type.Literal("obsolete"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({
          description: "BOM header UUID (required for get/update/add_line/activate/obsolete)",
        }),
      ),
      name: Type.Optional(Type.String({ description: "BOM name" })),
      item_id: Type.Optional(Type.String({ description: "Finished product inventory item UUID" })),
      notes: Type.Optional(Type.String({ description: "BOM notes" })),
      bom_id: Type.Optional(Type.String({ description: "BOM header UUID for add_line action" })),
      line_item_id: Type.Optional(
        Type.String({ description: "Component inventory item UUID for add_line" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Line item description for add_line" }),
      ),
      quantity: Type.Optional(
        Type.String({ description: "Component quantity as decimal string for add_line" }),
      ),
      unit: Type.Optional(Type.String({ description: "Unit of measure for the component" })),
      child_bom_id: Type.Optional(
        Type.String({ description: "Sub-assembly BOM UUID (for nested BOMs)" }),
      ),
      level: Type.Optional(Type.Number({ minimum: 0, description: "BOM level (0 = top level)" })),
      sort_order: Type.Optional(
        Type.Number({ minimum: 0, description: "Display sort order within BOM" }),
      ),
      item_id_filter: Type.Optional(
        Type.String({ description: "Filter by finished product item UUID (for list)" }),
      ),
      status_filter: Type.Optional(
        Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("obsolete")], {
          description: "Filter by BOM status (for list)",
        }),
      ),
      page: Type.Optional(Type.Number({ minimum: 1, default: 1, description: "Page number" })),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 100, default: 25, description: "Items per page" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "create": {
            const name = params.name as string | undefined;
            const itemId = params.item_id as string | undefined;

            if (!name) return errorResult("name is required for create");
            if (!itemId) return errorResult("item_id (finished product) is required for create");

            const now = new Date().toISOString();
            const payload = {
              tenant_id: db.tenantId,
              name,
              item_id: itemId,
              notes: (params.notes as string | undefined) ?? null,
              status: "draft",
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("bom_headers")
              .insert(payload)
              .select("*, item:inventory_items(name, sku)")
              .single();

            if (error) return errorResult(`Failed to create BOM: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bom_header",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, item_id: itemId },
            });

            return jsonResult(data, `BOM created: ${name}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: header, error: headerError } = await db.client
              .from("bom_headers")
              .select("*, item:inventory_items(name, sku)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (headerError) return errorResult(`BOM not found: ${headerError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("bom_lines")
              .select("*, component:inventory_items(name, sku, cost_price)")
              .eq("tenant_id", db.tenantId)
              .eq("bom_id", id)
              .order("sort_order", { ascending: true });

            if (lineError) return errorResult(`Failed to fetch BOM lines: ${lineError.message}`);

            return jsonResult({ header, lines: lines ?? [] }, `BOM: ${header.name}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const { data: existing, error: fetchError } = await db.client
              .from("bom_headers")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`BOM not found: ${fetchError.message}`);
            if (existing.status === "obsolete") return errorResult("Cannot update an obsolete BOM");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.name !== undefined) updates.name = params.name;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("bom_headers")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, item:inventory_items(name, sku)")
              .single();

            if (error) return errorResult(`Failed to update BOM: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bom_header",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `BOM updated: ${data.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const itemIdFilter = params.item_id_filter as string | undefined;
            const statusFilter = params.status_filter as string | undefined;

            let query = db.client
              .from("bom_headers")
              .select("*, item:inventory_items(name, sku)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (itemIdFilter) query = query.eq("item_id", itemIdFilter);
            if (statusFilter) query = query.eq("status", statusFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list BOMs: ${error.message}`);

            return jsonResult(
              { boms: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} BOMs (page ${page})`,
            );
          }

          case "add_line": {
            const bomId = params.bom_id as string | undefined;
            const lineItemId = params.line_item_id as string | undefined;
            const quantity = params.quantity as string | undefined;

            if (!bomId) return errorResult("bom_id is required for add_line");
            if (!lineItemId) return errorResult("line_item_id is required for add_line");
            if (!quantity) return errorResult("quantity is required for add_line");

            const { data: header, error: headerError } = await db.client
              .from("bom_headers")
              .select("status, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", bomId)
              .single();

            if (headerError) return errorResult(`BOM not found: ${headerError.message}`);
            if (header.status === "obsolete")
              return errorResult("Cannot add lines to an obsolete BOM");

            const now = new Date().toISOString();
            const linePayload = {
              tenant_id: db.tenantId,
              bom_id: bomId,
              item_id: lineItemId,
              description: (params.description as string | undefined) ?? null,
              quantity,
              unit: (params.unit as string | undefined) ?? null,
              child_bom_id: (params.child_bom_id as string | undefined) ?? null,
              level: (params.level as number | undefined) ?? 0,
              sort_order: (params.sort_order as number | undefined) ?? 0,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("bom_lines")
              .insert(linePayload)
              .select("*, component:inventory_items(name, sku, cost_price)")
              .single();

            if (error) return errorResult(`Failed to add BOM line: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bom_line",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { bom_id: bomId, item_id: lineItemId, quantity },
            });

            return jsonResult(data, `BOM line added to: ${header.name}`);
          }

          case "activate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for activate");

            const { data: existing, error: fetchError } = await db.client
              .from("bom_headers")
              .select("status, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`BOM not found: ${fetchError.message}`);
            if (existing.status === "active") return errorResult("BOM is already active");
            if (existing.status === "obsolete")
              return errorResult("Cannot activate an obsolete BOM");

            const { data, error } = await db.client
              .from("bom_headers")
              .update({
                status: "active",
                activated_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to activate BOM: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bom_header",
              entity_id: id,
              action: "approve",
              actor: _id,
              payload: { status: "active" },
            });

            return jsonResult(data, `BOM activated: ${existing.name}`);
          }

          case "obsolete": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for obsolete");

            const { data: existing, error: fetchError } = await db.client
              .from("bom_headers")
              .select("status, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`BOM not found: ${fetchError.message}`);
            if (existing.status === "obsolete") return errorResult("BOM is already obsolete");

            const { data, error } = await db.client
              .from("bom_headers")
              .update({
                status: "obsolete",
                obsoleted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to mark BOM as obsolete: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bom_header",
              entity_id: id,
              action: "void",
              actor: _id,
              payload: { status: "obsolete" },
            });

            return jsonResult(data, `BOM marked as obsolete: ${existing.name}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, add_line, activate, obsolete`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
