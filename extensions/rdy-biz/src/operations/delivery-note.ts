import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createDeliveryNoteTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_delivery_note",
    label: "Operations: Delivery Notes",
    description:
      "Create, retrieve, and list delivery notes linked to shipments. Each note records items delivered with quantity and notes.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("get"), Type.Literal("list")], {
        description: "Operation to perform",
      }),
      id: Type.Optional(Type.String({ description: "Delivery note UUID (required for get)" })),
      shipment_id: Type.Optional(
        Type.String({
          description: "Shipment UUID (required for create; optional filter for list)",
        }),
      ),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            description: Type.String({ description: "Item description" }),
            quantity: Type.Number({ minimum: 1, description: "Quantity delivered" }),
            notes: Type.Optional(Type.String({ description: "Per-item notes" })),
          }),
          { description: "Items included in this delivery note" },
        ),
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
            const shipment_id = params.shipment_id as string | undefined;
            if (!shipment_id) return errorResult("shipment_id is required for create");

            const items = params.items as
              | Array<{ description: string; quantity: number; notes?: string }>
              | undefined;
            if (!items || items.length === 0)
              return errorResult("items array is required and must not be empty");

            const payload = {
              tenant_id: db.tenantId,
              shipment_id,
              items,
              created_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("delivery_notes")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create delivery note: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "delivery_note",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { shipment_id, item_count: items.length },
            });

            return jsonResult(
              data,
              `Delivery note created: ${data.id} for shipment ${shipment_id}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("delivery_notes")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Delivery note not found: ${error.message}`);

            return jsonResult(data, `Delivery note: ${data.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const shipment_id = params.shipment_id as string | undefined;

            let query = db.client
              .from("delivery_notes")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (shipment_id) query = query.eq("shipment_id", shipment_id);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list delivery notes: ${error.message}`);

            return jsonResult(
              { delivery_notes: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} delivery notes (page ${page})`,
            );
          }

          default:
            return errorResult(`Unknown action: ${action}. Must be one of: create, get, list`);
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
