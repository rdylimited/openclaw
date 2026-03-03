import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type InvoiceLine = {
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate?: string;
};

function calculateInvoiceTotals(lines: InvoiceLine[]) {
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

export function createInvoiceManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_invoice_manage",
    label: "Finance: Invoice Management",
    description:
      "Create, retrieve, update, list, send, or void customer invoices. Auto-generates invoice numbers and calculates subtotals, tax, and totals from line items.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("send"),
          Type.Literal("void"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Invoice UUID (required for get/update/send/void)" }),
      ),
      customer_id: Type.Optional(Type.String({ description: "Customer contact UUID" })),
      date: Type.Optional(Type.String({ description: "Invoice date (YYYY-MM-DD)" })),
      due_date: Type.Optional(Type.String({ description: "Payment due date (YYYY-MM-DD)" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      notes: Type.Optional(Type.String({ description: "Invoice notes / terms" })),
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
          { description: "Invoice line items" },
        ),
      ),
      status: Type.Optional(
        Type.Union(
          [Type.Literal("draft"), Type.Literal("sent"), Type.Literal("paid"), Type.Literal("void")],
          { description: "Status filter for list" },
        ),
      ),
      customer_id_filter: Type.Optional(
        Type.String({ description: "Filter by customer UUID (for list)" }),
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
            const customerId = params.customer_id as string | undefined;
            const date = params.date as string | undefined;
            const dueDate = params.due_date as string | undefined;
            const lines = params.lines as InvoiceLine[] | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!customerId) return errorResult("customer_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length === 0)
              return errorResult("lines is required and must not be empty");

            const invoiceNumber = `INV-${Date.now()}`;
            const { subtotal, taxTotal, total } = calculateInvoiceTotals(lines);
            const now = new Date().toISOString();

            const invoicePayload = {
              tenant_id: db.tenantId,
              invoice_number: invoiceNumber,
              customer_id: customerId,
              date,
              due_date: dueDate ?? null,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              status: "draft",
              subtotal: subtotal.toFixed(2),
              tax_total: taxTotal.toFixed(2),
              total: total.toFixed(2),
              created_at: now,
              updated_at: now,
            };

            const { data: invoice, error: invoiceError } = await db.client
              .from("invoices")
              .insert(invoicePayload)
              .select("*")
              .single();

            if (invoiceError)
              return errorResult(`Failed to create invoice: ${invoiceError.message}`);

            const linePayloads = lines.map((l) => {
              const lineSubtotal = money(l.quantity).times(money(l.unit_price));
              const rate = l.tax_rate ? money(l.tax_rate) : money("0");
              const lineTax = lineSubtotal.times(rate);
              return {
                tenant_id: db.tenantId,
                invoice_id: invoice.id,
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
              .from("invoice_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError)
              return errorResult(`Failed to create invoice lines: ${lineError.message}`);

            await writeAuditLog(db, {
              entity_type: "invoice",
              entity_id: invoice.id,
              action: "create",
              actor: _id,
              payload: {
                invoice_number: invoiceNumber,
                customer_id: customerId,
                total: total.toFixed(2),
                currency,
              },
            });

            return jsonResult(
              { invoice, lines: insertedLines },
              `Invoice created: ${invoiceNumber} — ${currency} ${total.toFixed(2)}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: invoice, error: invoiceError } = await db.client
              .from("invoices")
              .select("*, customer:contacts(name, email)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (invoiceError) return errorResult(`Invoice not found: ${invoiceError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("invoice_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("invoice_id", id)
              .order("created_at", { ascending: true });

            if (lineError)
              return errorResult(`Failed to fetch invoice lines: ${lineError.message}`);

            return jsonResult(
              { invoice, lines: lines ?? [] },
              `Invoice: ${invoice.invoice_number}`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const { data: existing, error: fetchError } = await db.client
              .from("invoices")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Invoice not found: ${fetchError.message}`);
            if (existing.status !== "draft")
              return errorResult("Only draft invoices can be updated");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.due_date !== undefined) updates.due_date = params.due_date;
            if (params.notes !== undefined) updates.notes = params.notes;
            if (params.currency !== undefined) updates.currency = params.currency;

            const { data, error } = await db.client
              .from("invoices")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update invoice: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "invoice",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Invoice updated: ${data.invoice_number}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const status = params.status as string | undefined;
            const customerIdFilter = params.customer_id_filter as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("invoices")
              .select("*, customer:contacts(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (customerIdFilter) query = query.eq("customer_id", customerIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list invoices: ${error.message}`);

            return jsonResult(
              { invoices: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} invoices (page ${page})`,
            );
          }

          case "send": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for send");

            const { data: existing, error: fetchError } = await db.client
              .from("invoices")
              .select("status, invoice_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Invoice not found: ${fetchError.message}`);
            if (existing.status === "void") return errorResult("Cannot send a voided invoice");

            const { data, error } = await db.client
              .from("invoices")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to send invoice: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "invoice",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: "sent" },
            });

            return jsonResult(data, `Invoice sent: ${existing.invoice_number}`);
          }

          case "void": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for void");

            const { data: existing, error: fetchError } = await db.client
              .from("invoices")
              .select("status, invoice_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Invoice not found: ${fetchError.message}`);
            if (existing.status === "void") return errorResult("Invoice is already voided");
            if (existing.status === "paid") return errorResult("Cannot void a paid invoice");

            const { data, error } = await db.client
              .from("invoices")
              .update({
                status: "void",
                voided_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to void invoice: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "invoice",
              entity_id: id,
              action: "void",
              actor: _id,
              payload: { voided_at: data.voided_at },
            });

            return jsonResult(data, `Invoice voided: ${existing.invoice_number}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, send, void`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
