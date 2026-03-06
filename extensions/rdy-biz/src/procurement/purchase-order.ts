import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type PoLine = {
  item_id?: string;
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate?: string;
};

function calculatePoTotals(lines: PoLine[]) {
  const subtotal = sumMoney(
    lines.map((l) => money(l.quantity).times(money(l.unit_price)).toFixed(2)),
  );
  const taxTotal = sumMoney(
    lines.map((l) => {
      const lineAmount = money(l.quantity).times(money(l.unit_price));
      const rate = l.tax_rate ? money(l.tax_rate) : money("0");
      return lineAmount.times(rate).toFixed(2);
    }),
  );
  const total = subtotal.plus(taxTotal);
  return { subtotal, taxTotal, total };
}

export function createPurchaseOrderTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_purchase_order",
    label: "Procurement: Purchase Order",
    description:
      "Create, retrieve, update, list, send, receive, close, or cancel purchase orders. Auto-generates PO numbers and calculates totals from line items.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("send"),
          Type.Literal("receive"),
          Type.Literal("close"),
          Type.Literal("cancel"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({
          description: "Purchase order UUID (required for get/update/send/receive/close/cancel)",
        }),
      ),
      supplier_id: Type.Optional(Type.String({ description: "Supplier UUID" })),
      date: Type.Optional(Type.String({ description: "PO date (YYYY-MM-DD)" })),
      expected_date: Type.Optional(
        Type.String({ description: "Expected delivery date (YYYY-MM-DD)" }),
      ),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      notes: Type.Optional(Type.String({ description: "Purchase order notes" })),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            item_id: Type.Optional(Type.String({ description: "Inventory item UUID" })),
            description: Type.String({ description: "Line item description" }),
            quantity: Type.String({ description: "Quantity as decimal string" }),
            unit_price: Type.String({ description: "Unit price as decimal string" }),
            tax_rate: Type.Optional(
              Type.String({ description: "Tax rate as decimal (e.g. '0.08' for 8%)" }),
            ),
          }),
          { description: "Purchase order line items" },
        ),
      ),
      grn_id: Type.Optional(
        Type.String({ description: "Goods received note UUID to link on receive" }),
      ),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("draft"),
            Type.Literal("sent"),
            Type.Literal("partial"),
            Type.Literal("received"),
            Type.Literal("closed"),
            Type.Literal("cancelled"),
          ],
          { description: "Status filter for list" },
        ),
      ),
      supplier_id_filter: Type.Optional(
        Type.String({ description: "Filter by supplier UUID (for list)" }),
      ),
      date_from: Type.Optional(Type.String({ description: "Start date filter (YYYY-MM-DD)" })),
      date_to: Type.Optional(Type.String({ description: "End date filter (YYYY-MM-DD)" })),
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
            const supplierId = params.supplier_id as string | undefined;
            const date = params.date as string | undefined;
            const lines = params.lines as PoLine[] | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!supplierId) return errorResult("supplier_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length === 0)
              return errorResult("lines is required and must not be empty");

            const poNumber = `PO-${Date.now()}`;
            const { subtotal, taxTotal, total } = calculatePoTotals(lines);
            const now = new Date().toISOString();

            const poPayload = {
              tenant_id: db.tenantId,
              po_number: poNumber,
              supplier_id: supplierId,
              date,
              expected_date: (params.expected_date as string | undefined) ?? null,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              status: "draft",
              subtotal: subtotal.toFixed(2),
              tax_total: taxTotal.toFixed(2),
              total: total.toFixed(2),
              created_at: now,
              updated_at: now,
            };

            const { data: po, error: poError } = await db.client
              .from("purchase_orders")
              .insert(poPayload)
              .select("*")
              .single();

            if (poError) return errorResult(`Failed to create purchase order: ${poError.message}`);

            const linePayloads = lines.map((l) => {
              const lineSubtotal = money(l.quantity).times(money(l.unit_price));
              const rate = l.tax_rate ? money(l.tax_rate) : money("0");
              const lineTax = lineSubtotal.times(rate);
              return {
                tenant_id: db.tenantId,
                po_id: po.id,
                item_id: l.item_id ?? null,
                description: l.description,
                quantity: money(l.quantity).toFixed(4),
                unit_price: money(l.unit_price).toFixed(2),
                tax_rate: rate.toFixed(4),
                subtotal: lineSubtotal.toFixed(2),
                tax_amount: lineTax.toFixed(2),
                total: lineSubtotal.plus(lineTax).toFixed(2),
                received_qty: "0",
                created_at: now,
              };
            });

            const { data: insertedLines, error: lineError } = await db.client
              .from("po_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError) return errorResult(`Failed to create PO lines: ${lineError.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: po.id,
              action: "create",
              actor: _id,
              payload: {
                po_number: poNumber,
                supplier_id: supplierId,
                total: total.toFixed(2),
                currency,
              },
            });

            return jsonResult(
              { po, lines: insertedLines },
              `Purchase order created: ${poNumber} — ${currency} ${total.toFixed(2)}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: po, error: poError } = await db.client
              .from("purchase_orders")
              .select("*, supplier:suppliers(id, company:companies(name))")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (poError) return errorResult(`Purchase order not found: ${poError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("po_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("po_id", id)
              .order("created_at", { ascending: true });

            if (lineError) return errorResult(`Failed to fetch PO lines: ${lineError.message}`);

            return jsonResult({ po, lines: lines ?? [] }, `Purchase order: ${po.po_number}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const { data: existing, error: fetchError } = await db.client
              .from("purchase_orders")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Purchase order not found: ${fetchError.message}`);
            if (existing.status !== "draft")
              return errorResult("Only draft purchase orders can be updated");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.expected_date !== undefined) updates.expected_date = params.expected_date;
            if (params.notes !== undefined) updates.notes = params.notes;
            if (params.currency !== undefined) updates.currency = params.currency;

            const { data, error } = await db.client
              .from("purchase_orders")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update purchase order: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Purchase order updated: ${data.po_number}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const status = params.status as string | undefined;
            const supplierIdFilter = params.supplier_id_filter as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("purchase_orders")
              .select("*, supplier:suppliers(id, company:companies(name))", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (supplierIdFilter) query = query.eq("supplier_id", supplierIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list purchase orders: ${error.message}`);

            return jsonResult(
              { purchase_orders: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} purchase orders (page ${page})`,
            );
          }

          case "send": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for send");

            const { data: existing, error: fetchError } = await db.client
              .from("purchase_orders")
              .select("status, po_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Purchase order not found: ${fetchError.message}`);
            if (existing.status !== "draft")
              return errorResult("Only draft purchase orders can be sent");

            const { data, error } = await db.client
              .from("purchase_orders")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to send purchase order: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: "sent" },
            });

            return jsonResult(data, `Purchase order sent: ${existing.po_number}`);
          }

          case "receive": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for receive");

            const grnId = params.grn_id as string | undefined;

            const { data: existing, error: fetchError } = await db.client
              .from("purchase_orders")
              .select("status, po_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Purchase order not found: ${fetchError.message}`);
            if (existing.status === "cancelled")
              return errorResult("Cannot receive a cancelled purchase order");
            if (existing.status === "closed")
              return errorResult("Purchase order is already closed");

            const updatePayload: Record<string, unknown> = {
              status: "received",
              received_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            if (grnId) updatePayload.grn_id = grnId;

            const { data, error } = await db.client
              .from("purchase_orders")
              .update(updatePayload)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update purchase order: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: "received", grn_id: grnId ?? null },
            });

            return jsonResult(data, `Purchase order marked as received: ${existing.po_number}`);
          }

          case "close": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for close");

            const { data: existing, error: fetchError } = await db.client
              .from("purchase_orders")
              .select("status, po_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Purchase order not found: ${fetchError.message}`);
            if (existing.status === "cancelled")
              return errorResult("Cannot close a cancelled purchase order");
            if (existing.status === "draft")
              return errorResult("Cannot close a draft purchase order");

            const { data, error } = await db.client
              .from("purchase_orders")
              .update({
                status: "closed",
                closed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to close purchase order: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: "closed" },
            });

            return jsonResult(data, `Purchase order closed: ${existing.po_number}`);
          }

          case "cancel": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for cancel");

            const { data: existing, error: fetchError } = await db.client
              .from("purchase_orders")
              .select("status, po_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Purchase order not found: ${fetchError.message}`);
            if (existing.status === "closed")
              return errorResult("Cannot cancel a closed purchase order");
            if (existing.status === "received")
              return errorResult("Cannot cancel a received purchase order");

            const { data, error } = await db.client
              .from("purchase_orders")
              .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to cancel purchase order: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "purchase_order",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { status: "cancelled" },
            });

            return jsonResult(data, `Purchase order cancelled: ${existing.po_number}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, send, receive, close, cancel`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
