import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type GrnLine = {
  po_line_id: string;
  item_id?: string;
  received_qty: string;
  accepted_qty: string;
  rejected_qty: string;
};

export function createGoodsReceiveTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_goods_receive",
    label: "Procurement: Goods Received Note",
    description:
      "Create or retrieve goods received notes (GRNs). Auto-generates GRN numbers and updates received quantities on PO lines.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("get"), Type.Literal("list")], {
        description: "Operation to perform",
      }),
      id: Type.Optional(Type.String({ description: "GRN UUID (required for get)" })),
      po_id: Type.Optional(
        Type.String({ description: "Purchase order UUID (required for create)" }),
      ),
      date: Type.Optional(Type.String({ description: "Receipt date (YYYY-MM-DD)" })),
      notes: Type.Optional(Type.String({ description: "Notes about this receipt" })),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            po_line_id: Type.String({ description: "PO line UUID being received" }),
            item_id: Type.Optional(Type.String({ description: "Inventory item UUID" })),
            received_qty: Type.String({ description: "Total quantity received as decimal string" }),
            accepted_qty: Type.String({ description: "Accepted quantity as decimal string" }),
            rejected_qty: Type.String({ description: "Rejected quantity as decimal string" }),
          }),
          { description: "GRN line items" },
        ),
      ),
      po_id_filter: Type.Optional(
        Type.String({ description: "Filter by purchase order UUID (for list)" }),
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
            const poId = params.po_id as string | undefined;
            const date = params.date as string | undefined;
            const lines = params.lines as GrnLine[] | undefined;

            if (!poId) return errorResult("po_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length === 0)
              return errorResult("lines is required and must not be empty");

            for (const line of lines) {
              const received = money(line.received_qty);
              const accepted = money(line.accepted_qty);
              const rejected = money(line.rejected_qty);
              if (accepted.plus(rejected).greaterThan(received)) {
                return errorResult(
                  `accepted_qty + rejected_qty cannot exceed received_qty for po_line_id: ${line.po_line_id}`,
                );
              }
            }

            const grnNumber = `GRN-${Date.now()}`;
            const now = new Date().toISOString();

            const grnPayload = {
              tenant_id: db.tenantId,
              grn_number: grnNumber,
              po_id: poId,
              date,
              notes: (params.notes as string | undefined) ?? null,
              created_at: now,
              updated_at: now,
            };

            const { data: grn, error: grnError } = await db.client
              .from("goods_received_notes")
              .insert(grnPayload)
              .select("*")
              .single();

            if (grnError) return errorResult(`Failed to create GRN: ${grnError.message}`);

            const linePayloads = lines.map((l) => ({
              tenant_id: db.tenantId,
              grn_id: grn.id,
              po_line_id: l.po_line_id,
              item_id: l.item_id ?? null,
              received_qty: money(l.received_qty).toFixed(4),
              accepted_qty: money(l.accepted_qty).toFixed(4),
              rejected_qty: money(l.rejected_qty).toFixed(4),
              created_at: now,
            }));

            const { data: insertedLines, error: lineError } = await db.client
              .from("grn_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError) return errorResult(`Failed to create GRN lines: ${lineError.message}`);

            for (const line of lines) {
              const { data: poLine, error: poLineError } = await db.client
                .from("po_lines")
                .select("received_qty")
                .eq("tenant_id", db.tenantId)
                .eq("id", line.po_line_id)
                .single();

              if (poLineError) {
                return errorResult(
                  `Failed to fetch PO line ${line.po_line_id}: ${poLineError.message}`,
                );
              }

              const updatedReceivedQty = money(poLine.received_qty ?? "0")
                .plus(money(line.accepted_qty))
                .toFixed(4);

              const { error: updateError } = await db.client
                .from("po_lines")
                .update({ received_qty: updatedReceivedQty, updated_at: now })
                .eq("tenant_id", db.tenantId)
                .eq("id", line.po_line_id);

              if (updateError) {
                return errorResult(`Failed to update PO line received qty: ${updateError.message}`);
              }
            }

            await writeAuditLog(db, {
              entity_type: "goods_received_note",
              entity_id: grn.id,
              action: "create",
              actor: _id,
              payload: { grn_number: grnNumber, po_id: poId, lines_count: lines.length },
            });

            return jsonResult(
              { grn, lines: insertedLines },
              `Goods received note created: ${grnNumber}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: grn, error: grnError } = await db.client
              .from("goods_received_notes")
              .select("*, purchase_order:purchase_orders(po_number)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (grnError) return errorResult(`GRN not found: ${grnError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("grn_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("grn_id", id)
              .order("created_at", { ascending: true });

            if (lineError) return errorResult(`Failed to fetch GRN lines: ${lineError.message}`);

            return jsonResult({ grn, lines: lines ?? [] }, `GRN: ${grn.grn_number}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const poIdFilter = params.po_id_filter as string | undefined;

            let query = db.client
              .from("goods_received_notes")
              .select("*, purchase_order:purchase_orders(po_number)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (poIdFilter) query = query.eq("po_id", poIdFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list GRNs: ${error.message}`);

            return jsonResult(
              { grns: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} goods received notes (page ${page})`,
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
