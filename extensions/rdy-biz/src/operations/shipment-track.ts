import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const SHIPMENT_TYPES = ["inbound", "outbound"] as const;
type ShipmentType = (typeof SHIPMENT_TYPES)[number];

const SHIPMENT_STATUSES = [
  "pending",
  "picked_up",
  "in_transit",
  "delivered",
  "returned",
  "cancelled",
] as const;
type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export function createShipmentTrackTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_shipment_track",
    label: "Operations: Track Shipments",
    description:
      "Create, retrieve, list, and manage shipments. Track status updates, log shipment events, and add items to shipments.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("update_status"),
          Type.Literal("add_event"),
          Type.Literal("add_items"),
        ],
        { description: "Operation to perform" },
      ),
      shipment_id: Type.Optional(
        Type.String({
          description: "Shipment UUID (required for get, update_status, add_event, add_items)",
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("inbound"), Type.Literal("outbound")], {
          description: "Shipment direction",
        }),
      ),
      carrier: Type.Optional(Type.String({ description: "Carrier name (e.g. DHL, FedEx)" })),
      tracking_number: Type.Optional(Type.String({ description: "Carrier tracking number" })),
      origin: Type.Optional(Type.Unknown({ description: "Origin address as JSONB object" })),
      destination: Type.Optional(
        Type.Unknown({ description: "Destination address as JSONB object" }),
      ),
      contact_id: Type.Optional(Type.String({ description: "Associated contact UUID" })),
      notes: Type.Optional(Type.String({ description: "Free-form notes" })),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("picked_up"),
            Type.Literal("in_transit"),
            Type.Literal("delivered"),
            Type.Literal("returned"),
            Type.Literal("cancelled"),
          ],
          { description: "Shipment status" },
        ),
      ),
      location: Type.Optional(Type.String({ description: "Event location description" })),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            item_id: Type.Optional(Type.String({ description: "Inventory item UUID" })),
            description: Type.String({ description: "Item description" }),
            quantity: Type.Number({ minimum: 1, description: "Quantity" }),
          }),
          { description: "Items to add to shipment" },
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
            const type = params.type as ShipmentType | undefined;
            if (!type || !SHIPMENT_TYPES.includes(type)) {
              return errorResult(
                `type is required and must be one of: ${SHIPMENT_TYPES.join(", ")}`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              type,
              carrier: (params.carrier as string | undefined) ?? null,
              tracking_number: (params.tracking_number as string | undefined) ?? null,
              origin: (params.origin as unknown) ?? null,
              destination: (params.destination as unknown) ?? null,
              contact_id: (params.contact_id as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              status: "pending" as ShipmentStatus,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("shipments")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create shipment: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "shipment",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { type, carrier: payload.carrier, tracking_number: payload.tracking_number },
            });

            return jsonResult(data, `Shipment created: ${data.id} (${type})`);
          }

          case "get": {
            const shipment_id = params.shipment_id as string | undefined;
            if (!shipment_id) return errorResult("shipment_id is required for get");

            const { data, error } = await db.client
              .from("shipments")
              .select("*, events:shipment_events(*), items:shipment_items(*)")
              .eq("tenant_id", db.tenantId)
              .eq("id", shipment_id)
              .single();

            if (error) return errorResult(`Shipment not found: ${error.message}`);

            return jsonResult(data, `Shipment: ${data.id} — ${data.status}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const type = params.type as string | undefined;
            const status = params.status as string | undefined;

            let query = db.client
              .from("shipments")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (type) query = query.eq("type", type);
            if (status) query = query.eq("status", status);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list shipments: ${error.message}`);

            return jsonResult(
              { shipments: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} shipments (page ${page})`,
            );
          }

          case "update_status": {
            const shipment_id = params.shipment_id as string | undefined;
            if (!shipment_id) return errorResult("shipment_id is required for update_status");

            const status = params.status as ShipmentStatus | undefined;
            if (!status || !SHIPMENT_STATUSES.includes(status)) {
              return errorResult(
                `status is required and must be one of: ${SHIPMENT_STATUSES.join(", ")}`,
              );
            }

            const { data, error } = await db.client
              .from("shipments")
              .update({ status, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", shipment_id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update shipment status: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "shipment",
              entity_id: shipment_id,
              action: "update",
              actor: _id,
              payload: { status },
            });

            return jsonResult(data, `Shipment ${shipment_id} status updated to: ${status}`);
          }

          case "add_event": {
            const shipment_id = params.shipment_id as string | undefined;
            if (!shipment_id) return errorResult("shipment_id is required for add_event");

            const status = params.status as string | undefined;
            if (!status) return errorResult("status is required for add_event");

            const eventPayload = {
              tenant_id: db.tenantId,
              shipment_id,
              status,
              location: (params.location as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              occurred_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("shipment_events")
              .insert(eventPayload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to add shipment event: ${error.message}`);

            return jsonResult(data, `Event added to shipment ${shipment_id}: ${status}`);
          }

          case "add_items": {
            const shipment_id = params.shipment_id as string | undefined;
            if (!shipment_id) return errorResult("shipment_id is required for add_items");

            const items = params.items as
              | Array<{ item_id?: string; description: string; quantity: number }>
              | undefined;
            if (!items || items.length === 0)
              return errorResult("items array is required and must not be empty");

            const rows = items.map((item) => ({
              tenant_id: db.tenantId,
              shipment_id,
              item_id: item.item_id ?? null,
              description: item.description,
              quantity: item.quantity,
            }));

            const { data, error } = await db.client.from("shipment_items").insert(rows).select("*");

            if (error) return errorResult(`Failed to add shipment items: ${error.message}`);

            return jsonResult(data, `Added ${data.length} item(s) to shipment ${shipment_id}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, update_status, add_event, add_items`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
