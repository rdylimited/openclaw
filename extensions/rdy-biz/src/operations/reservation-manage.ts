import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const RESERVATION_STATUSES = ["pending", "confirmed", "cancelled", "completed", "no_show"] as const;
type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function createReservationManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_reservation_manage",
    label: "Operations: Manage Reservations",
    description:
      "Create, retrieve, update, list, cancel, complete, or mark no-show for reservations. Enforces slot capacity before booking.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("cancel"),
          Type.Literal("complete"),
          Type.Literal("no_show"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({
          description: "Reservation UUID (required for get, update, cancel, complete, no_show)",
        }),
      ),
      resource_type: Type.Optional(
        Type.String({ description: "Type of resource being reserved (e.g. room, table)" }),
      ),
      resource_id: Type.Optional(Type.String({ description: "Resource UUID" })),
      contact_id: Type.Optional(Type.String({ description: "Associated contact UUID" })),
      start_time: Type.Optional(
        Type.String({ description: "Reservation start datetime (ISO 8601)" }),
      ),
      end_time: Type.Optional(Type.String({ description: "Reservation end datetime (ISO 8601)" })),
      notes: Type.Optional(Type.String({ description: "Free-form notes" })),
      date_from: Type.Optional(Type.String({ description: "Filter: start date (YYYY-MM-DD)" })),
      date_to: Type.Optional(Type.String({ description: "Filter: end date (YYYY-MM-DD)" })),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("confirmed"),
            Type.Literal("cancelled"),
            Type.Literal("completed"),
            Type.Literal("no_show"),
          ],
          { description: "Reservation status filter (for list) or target status" },
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
            const resource_type = params.resource_type as string | undefined;
            const resource_id = params.resource_id as string | undefined;
            const contact_id = params.contact_id as string | undefined;
            const start_time = params.start_time as string | undefined;
            const end_time = params.end_time as string | undefined;

            if (!resource_type) return errorResult("resource_type is required for create");
            if (!start_time) return errorResult("start_time is required for create");
            if (!end_time) return errorResult("end_time is required for create");

            // Check slot capacity for the booking date
            const bookingDate = start_time.substring(0, 10);

            const slotQuery = db.client
              .from("reservation_slots")
              .select("id, capacity, booked")
              .eq("tenant_id", db.tenantId)
              .eq("resource_type", resource_type)
              .eq("slot_date", bookingDate);

            if (resource_id) slotQuery.eq("resource_id", resource_id);

            const { data: slotData, error: slotError } = await slotQuery.maybeSingle();

            if (slotError)
              return errorResult(`Failed to check slot capacity: ${slotError.message}`);

            if (slotData) {
              const available = slotData.capacity - slotData.booked;
              if (available <= 0) {
                return errorResult(
                  `No capacity available for ${resource_type} on ${bookingDate} (capacity: ${slotData.capacity}, booked: ${slotData.booked})`,
                );
              }
            }

            const payload = {
              tenant_id: db.tenantId,
              resource_type,
              resource_id: resource_id ?? null,
              contact_id: contact_id ?? null,
              start_time,
              end_time,
              notes: (params.notes as string | undefined) ?? null,
              status: "pending" as ReservationStatus,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("reservations")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create reservation: ${error.message}`);

            // Increment booked count in slot
            if (slotData) {
              await db.client
                .from("reservation_slots")
                .update({ booked: slotData.booked + 1 })
                .eq("tenant_id", db.tenantId)
                .eq("id", slotData.id);
            }

            await writeAuditLog(db, {
              entity_type: "reservation",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { resource_type, resource_id, start_time, end_time },
            });

            return jsonResult(
              data,
              `Reservation created: ${data.id} for ${resource_type} on ${bookingDate}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("reservations")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Reservation not found: ${error.message}`);

            return jsonResult(data, `Reservation: ${data.id} — ${data.status}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.start_time !== undefined) updates.start_time = params.start_time;
            if (params.end_time !== undefined) updates.end_time = params.end_time;
            if (params.contact_id !== undefined) updates.contact_id = params.contact_id;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("reservations")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update reservation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "reservation",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Reservation updated: ${data.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const resource_type = params.resource_type as string | undefined;
            const status = params.status as string | undefined;
            const date_from = params.date_from as string | undefined;
            const date_to = params.date_to as string | undefined;

            let query = db.client
              .from("reservations")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("start_time", { ascending: true })
              .range(offset, offset + limit - 1);

            if (resource_type) query = query.eq("resource_type", resource_type);
            if (status) query = query.eq("status", status);
            if (date_from) query = query.gte("start_time", date_from);
            if (date_to) query = query.lte("start_time", `${date_to}T23:59:59`);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list reservations: ${error.message}`);

            return jsonResult(
              { reservations: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} reservations (page ${page})`,
            );
          }

          case "cancel":
          case "complete":
          case "no_show": {
            const id = params.id as string | undefined;
            if (!id) return errorResult(`id is required for ${action}`);

            const newStatus: ReservationStatus =
              action === "cancel" ? "cancelled" : action === "complete" ? "completed" : "no_show";

            // Fetch current reservation to check status and slot info
            const { data: existing, error: fetchError } = await db.client
              .from("reservations")
              .select("status, resource_type, resource_id, start_time")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Reservation not found: ${fetchError.message}`);

            const { data, error } = await db.client
              .from("reservations")
              .update({ status: newStatus, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to ${action} reservation: ${error.message}`);

            // On cancel, decrement booked count in slot
            if (action === "cancel" && existing.status !== "cancelled") {
              const bookingDate = existing.start_time.substring(0, 10);

              const slotQuery = db.client
                .from("reservation_slots")
                .select("id, booked")
                .eq("tenant_id", db.tenantId)
                .eq("resource_type", existing.resource_type)
                .eq("slot_date", bookingDate);

              if (existing.resource_id) slotQuery.eq("resource_id", existing.resource_id);

              const { data: slot } = await slotQuery.maybeSingle();

              if (slot && slot.booked > 0) {
                await db.client
                  .from("reservation_slots")
                  .update({ booked: slot.booked - 1 })
                  .eq("tenant_id", db.tenantId)
                  .eq("id", slot.id);
              }
            }

            await writeAuditLog(db, {
              entity_type: "reservation",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: newStatus },
            });

            return jsonResult(data, `Reservation ${id} marked as ${newStatus}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, cancel, complete, no_show`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
