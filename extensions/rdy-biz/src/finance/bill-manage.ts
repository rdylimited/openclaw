import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type BillLine = {
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate?: string;
};

function calculateBillTotals(lines: BillLine[]) {
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

export function createBillManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_bill_manage",
    label: "Finance: Bill Management",
    description:
      "Create, retrieve, update, list, receive, or void supplier bills. Mirrors invoice management on the payable side.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("receive"),
          Type.Literal("void"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Bill UUID (required for get/update/receive/void)" }),
      ),
      supplier_id: Type.Optional(Type.String({ description: "Supplier contact UUID" })),
      po_id: Type.Optional(Type.String({ description: "Related purchase order UUID" })),
      bill_number: Type.Optional(Type.String({ description: "Supplier's bill/invoice number" })),
      date: Type.Optional(Type.String({ description: "Bill date (YYYY-MM-DD)" })),
      due_date: Type.Optional(Type.String({ description: "Payment due date (YYYY-MM-DD)" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      notes: Type.Optional(Type.String({ description: "Bill notes" })),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            description: Type.String({ description: "Line item description" }),
            quantity: Type.String({ description: "Quantity as decimal string" }),
            unit_price: Type.String({ description: "Unit price as decimal string" }),
            tax_rate: Type.Optional(
              Type.String({ description: "Tax rate as decimal (e.g. '0.08' for 8%)" }),
            ),
          }),
          { description: "Bill line items" },
        ),
      ),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("draft"),
            Type.Literal("received"),
            Type.Literal("paid"),
            Type.Literal("void"),
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
            const lines = params.lines as BillLine[] | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!supplierId) return errorResult("supplier_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length === 0)
              return errorResult("lines is required and must not be empty");

            const { subtotal, taxTotal, total } = calculateBillTotals(lines);
            const now = new Date().toISOString();

            const billPayload = {
              tenant_id: db.tenantId,
              supplier_id: supplierId,
              po_id: (params.po_id as string | undefined) ?? null,
              bill_number: (params.bill_number as string | undefined) ?? null,
              date,
              due_date: (params.due_date as string | undefined) ?? null,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              status: "draft",
              subtotal: subtotal.toFixed(2),
              tax_total: taxTotal.toFixed(2),
              total: total.toFixed(2),
              created_at: now,
              updated_at: now,
            };

            const { data: bill, error: billError } = await db.client
              .from("bills")
              .insert(billPayload)
              .select("*")
              .single();

            if (billError) return errorResult(`Failed to create bill: ${billError.message}`);

            const linePayloads = lines.map((l) => {
              const lineSubtotal = money(l.quantity).times(money(l.unit_price));
              const rate = l.tax_rate ? money(l.tax_rate) : money("0");
              const lineTax = lineSubtotal.times(rate);
              return {
                tenant_id: db.tenantId,
                bill_id: bill.id,
                description: l.description,
                quantity: money(l.quantity).toFixed(4),
                unit_price: money(l.unit_price).toFixed(2),
                tax_rate: rate.toFixed(4),
                subtotal: lineSubtotal.toFixed(2),
                tax_amount: lineTax.toFixed(2),
                total: lineSubtotal.plus(lineTax).toFixed(2),
                created_at: now,
              };
            });

            const { data: insertedLines, error: lineError } = await db.client
              .from("bill_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError) return errorResult(`Failed to create bill lines: ${lineError.message}`);

            await writeAuditLog(db, {
              entity_type: "bill",
              entity_id: bill.id,
              action: "create",
              actor: _id,
              payload: { supplier_id: supplierId, total: total.toFixed(2), currency },
            });

            return jsonResult(
              { bill, lines: insertedLines },
              `Bill created: ${bill.id} — ${currency} ${total.toFixed(2)}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: bill, error: billError } = await db.client
              .from("bills")
              .select("*, supplier:contacts(name, email)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (billError) return errorResult(`Bill not found: ${billError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("bill_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("bill_id", id)
              .order("created_at", { ascending: true });

            if (lineError) return errorResult(`Failed to fetch bill lines: ${lineError.message}`);

            return jsonResult({ bill, lines: lines ?? [] }, `Bill: ${bill.id}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const { data: existing, error: fetchError } = await db.client
              .from("bills")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Bill not found: ${fetchError.message}`);
            if (existing.status !== "draft") return errorResult("Only draft bills can be updated");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.bill_number !== undefined) updates.bill_number = params.bill_number;
            if (params.due_date !== undefined) updates.due_date = params.due_date;
            if (params.notes !== undefined) updates.notes = params.notes;
            if (params.currency !== undefined) updates.currency = params.currency;
            if (params.po_id !== undefined) updates.po_id = params.po_id;

            const { data, error } = await db.client
              .from("bills")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update bill: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bill",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Bill updated: ${data.id}`);
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
              .from("bills")
              .select("*, supplier:contacts(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (supplierIdFilter) query = query.eq("supplier_id", supplierIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list bills: ${error.message}`);

            return jsonResult(
              { bills: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} bills (page ${page})`,
            );
          }

          case "receive": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for receive");

            const { data: existing, error: fetchError } = await db.client
              .from("bills")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Bill not found: ${fetchError.message}`);
            if (existing.status === "void") return errorResult("Cannot receive a voided bill");

            const { data, error } = await db.client
              .from("bills")
              .update({
                status: "received",
                received_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to mark bill as received: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bill",
              entity_id: id,
              action: "approve",
              actor: _id,
              payload: { status: "received" },
            });

            return jsonResult(data, `Bill marked as received: ${id}`);
          }

          case "void": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for void");

            const { data: existing, error: fetchError } = await db.client
              .from("bills")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Bill not found: ${fetchError.message}`);
            if (existing.status === "void") return errorResult("Bill is already voided");
            if (existing.status === "paid") return errorResult("Cannot void a paid bill");

            const { data, error } = await db.client
              .from("bills")
              .update({
                status: "void",
                voided_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to void bill: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bill",
              entity_id: id,
              action: "void",
              actor: _id,
              payload: { voided_at: data.voided_at },
            });

            return jsonResult(data, `Bill voided: ${id}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, receive, void`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
