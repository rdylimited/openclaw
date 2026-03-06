import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type SlotRow = {
  slot_date: string;
  resource_id: string | null;
  capacity: number;
  booked: number;
};

type AvailabilityEntry = {
  date: string;
  resource_id: string | null;
  capacity: number;
  booked: number;
  available: number;
};

export function createReservationAvailabilityTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_reservation_availability",
    label: "Operations: Reservation Availability",
    description:
      "Query available reservation slots for a resource type over a date range. Returns capacity, booked count, and available count per slot.",
    parameters: Type.Object({
      resource_type: Type.String({ description: "Type of resource to check (e.g. room, table)" }),
      resource_id: Type.Optional(
        Type.String({ description: "Specific resource UUID to check availability for" }),
      ),
      date_from: Type.String({ description: "Start date of range (YYYY-MM-DD)" }),
      date_to: Type.String({ description: "End date of range (YYYY-MM-DD)" }),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const resource_type = params.resource_type as string | undefined;
        const resource_id = params.resource_id as string | undefined;
        const date_from = params.date_from as string | undefined;
        const date_to = params.date_to as string | undefined;

        if (!resource_type) return errorResult("resource_type is required");
        if (!date_from) return errorResult("date_from is required");
        if (!date_to) return errorResult("date_to is required");

        // Validate date range
        if (date_from > date_to) return errorResult("date_from must be before or equal to date_to");

        let query = db.client
          .from("reservation_slots")
          .select("slot_date, resource_id, capacity, booked")
          .eq("tenant_id", db.tenantId)
          .eq("resource_type", resource_type)
          .gte("slot_date", date_from)
          .lte("slot_date", date_to)
          .order("slot_date", { ascending: true });

        if (resource_id) query = query.eq("resource_id", resource_id);

        const { data, error } = await query;

        if (error) return errorResult(`Failed to query availability: ${error.message}`);

        const slotsByDate = new Map<string, SlotRow>();
        for (const row of (data ?? []) as SlotRow[]) {
          const key = `${row.slot_date}:${row.resource_id ?? ""}`;
          slotsByDate.set(key, row);
        }

        // Generate all dates in range and merge with slot data
        const availability: AvailabilityEntry[] = [];
        const current = new Date(date_from);
        const end = new Date(date_to);

        while (current <= end) {
          const dateStr = current.toISOString().substring(0, 10);
          const key = `${dateStr}:${resource_id ?? ""}`;
          const slot = slotsByDate.get(key);

          if (slot) {
            availability.push({
              date: dateStr,
              resource_id: slot.resource_id,
              capacity: slot.capacity,
              booked: slot.booked,
              available: slot.capacity - slot.booked,
            });
          } else {
            // No slot record for this date — treat as no defined capacity
            availability.push({
              date: dateStr,
              resource_id: resource_id ?? null,
              capacity: 0,
              booked: 0,
              available: 0,
            });
          }

          current.setDate(current.getDate() + 1);
        }

        const totalAvailable = availability.reduce((sum, s) => sum + s.available, 0);

        return jsonResult(
          {
            resource_type,
            resource_id: resource_id ?? null,
            date_from,
            date_to,
            slots: availability,
          },
          `Availability for ${resource_type} from ${date_from} to ${date_to} — ${totalAvailable} total available slots`,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
