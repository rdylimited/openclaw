import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type QuotationLine = {
  description: string;
  quantity: string;
  unit_price: string;
  tax_rate?: string;
};

function calculateQuotationTotals(lines: QuotationLine[]) {
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

export function createQuotationManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_quotation_manage",
    label: "Finance: Quotation Management",
    description:
      "Create, retrieve, update, list, send, accept, reject, or convert quotations to invoices. Linking converted_invoice_id on conversion.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("send"),
          Type.Literal("accept"),
          Type.Literal("reject"),
          Type.Literal("convert_to_invoice"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({
          description:
            "Quotation UUID (required for get/update/send/accept/reject/convert_to_invoice)",
        }),
      ),
      customer_id: Type.Optional(Type.String({ description: "Customer contact UUID" })),
      date: Type.Optional(Type.String({ description: "Quotation date (YYYY-MM-DD)" })),
      expiry_date: Type.Optional(Type.String({ description: "Quote expiry date (YYYY-MM-DD)" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      notes: Type.Optional(Type.String({ description: "Quotation notes / terms" })),
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
          { description: "Quotation line items" },
        ),
      ),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("draft"),
            Type.Literal("sent"),
            Type.Literal("accepted"),
            Type.Literal("rejected"),
            Type.Literal("converted"),
          ],
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
            const lines = params.lines as QuotationLine[] | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!customerId) return errorResult("customer_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length === 0)
              return errorResult("lines is required and must not be empty");

            const quotationNumber = `QUO-${Date.now()}`;
            const { subtotal, taxTotal, total } = calculateQuotationTotals(lines);
            const now = new Date().toISOString();

            const quotationPayload = {
              tenant_id: db.tenantId,
              quotation_number: quotationNumber,
              customer_id: customerId,
              date,
              expiry_date: (params.expiry_date as string | undefined) ?? null,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              status: "draft",
              subtotal: subtotal.toFixed(2),
              tax_total: taxTotal.toFixed(2),
              total: total.toFixed(2),
              converted_invoice_id: null,
              created_at: now,
              updated_at: now,
            };

            const { data: quotation, error: quotationError } = await db.client
              .from("quotations")
              .insert(quotationPayload)
              .select("*")
              .single();

            if (quotationError)
              return errorResult(`Failed to create quotation: ${quotationError.message}`);

            const linePayloads = lines.map((l) => {
              const lineSubtotal = money(l.quantity).times(money(l.unit_price));
              const rate = l.tax_rate ? money(l.tax_rate) : money("0");
              const lineTax = lineSubtotal.times(rate);
              return {
                tenant_id: db.tenantId,
                quotation_id: quotation.id,
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
              .from("quotation_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError)
              return errorResult(`Failed to create quotation lines: ${lineError.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: quotation.id,
              action: "create",
              actor: _id,
              payload: {
                quotation_number: quotationNumber,
                customer_id: customerId,
                total: total.toFixed(2),
              },
            });

            return jsonResult(
              { quotation, lines: insertedLines },
              `Quotation created: ${quotationNumber} — ${currency} ${total.toFixed(2)}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: quotation, error: quotationError } = await db.client
              .from("quotations")
              .select("*, customer:contacts(name, email)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (quotationError)
              return errorResult(`Quotation not found: ${quotationError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("quotation_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("quotation_id", id)
              .order("created_at", { ascending: true });

            if (lineError)
              return errorResult(`Failed to fetch quotation lines: ${lineError.message}`);

            return jsonResult(
              { quotation, lines: lines ?? [] },
              `Quotation: ${quotation.quotation_number}`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const { data: existing, error: fetchError } = await db.client
              .from("quotations")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Quotation not found: ${fetchError.message}`);
            if (!["draft", "sent"].includes(existing.status)) {
              return errorResult("Only draft or sent quotations can be updated");
            }

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.expiry_date !== undefined) updates.expiry_date = params.expiry_date;
            if (params.notes !== undefined) updates.notes = params.notes;
            if (params.currency !== undefined) updates.currency = params.currency;

            const { data, error } = await db.client
              .from("quotations")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update quotation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Quotation updated: ${data.quotation_number}`);
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
              .from("quotations")
              .select("*, customer:contacts(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (customerIdFilter) query = query.eq("customer_id", customerIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list quotations: ${error.message}`);

            return jsonResult(
              { quotations: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} quotations (page ${page})`,
            );
          }

          case "send": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for send");

            const { data: existing, error: fetchError } = await db.client
              .from("quotations")
              .select("status, quotation_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Quotation not found: ${fetchError.message}`);
            if (existing.status !== "draft")
              return errorResult("Only draft quotations can be sent");

            const { data, error } = await db.client
              .from("quotations")
              .update({
                status: "sent",
                sent_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to send quotation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { status: "sent" },
            });

            return jsonResult(data, `Quotation sent: ${existing.quotation_number}`);
          }

          case "accept": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for accept");

            const { data: existing, error: fetchError } = await db.client
              .from("quotations")
              .select("status, quotation_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Quotation not found: ${fetchError.message}`);
            if (existing.status !== "sent")
              return errorResult("Only sent quotations can be accepted");

            const { data, error } = await db.client
              .from("quotations")
              .update({
                status: "accepted",
                accepted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to accept quotation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: id,
              action: "approve",
              actor: _id,
              payload: { status: "accepted" },
            });

            return jsonResult(data, `Quotation accepted: ${existing.quotation_number}`);
          }

          case "reject": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for reject");

            const { data: existing, error: fetchError } = await db.client
              .from("quotations")
              .select("status, quotation_number")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Quotation not found: ${fetchError.message}`);
            if (!["sent", "draft"].includes(existing.status)) {
              return errorResult("Only draft or sent quotations can be rejected");
            }

            const { data, error } = await db.client
              .from("quotations")
              .update({
                status: "rejected",
                rejected_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to reject quotation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: id,
              action: "reject",
              actor: _id,
              payload: { status: "rejected" },
            });

            return jsonResult(data, `Quotation rejected: ${existing.quotation_number}`);
          }

          case "convert_to_invoice": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for convert_to_invoice");

            const { data: quotation, error: fetchError } = await db.client
              .from("quotations")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Quotation not found: ${fetchError.message}`);
            if (!["accepted", "sent"].includes(quotation.status)) {
              return errorResult("Only accepted or sent quotations can be converted to invoices");
            }
            if (quotation.converted_invoice_id) {
              return errorResult(
                `Quotation already converted to invoice: ${quotation.converted_invoice_id}`,
              );
            }

            const { data: quotationLines, error: linesFetchError } = await db.client
              .from("quotation_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("quotation_id", id);

            if (linesFetchError)
              return errorResult(`Failed to fetch quotation lines: ${linesFetchError.message}`);

            const invoiceNumber = `INV-${Date.now()}`;
            const now = new Date().toISOString();
            const invoiceDate = new Date().toISOString().slice(0, 10);

            const invoicePayload = {
              tenant_id: db.tenantId,
              invoice_number: invoiceNumber,
              customer_id: quotation.customer_id,
              date: invoiceDate,
              due_date: null,
              currency: quotation.currency,
              notes: quotation.notes,
              status: "draft",
              subtotal: quotation.subtotal,
              tax_total: quotation.tax_total,
              total: quotation.total,
              quotation_id: id,
              created_at: now,
              updated_at: now,
            };

            const { data: invoice, error: invoiceError } = await db.client
              .from("invoices")
              .insert(invoicePayload)
              .select("*")
              .single();

            if (invoiceError)
              return errorResult(
                `Failed to create invoice from quotation: ${invoiceError.message}`,
              );

            const invoiceLinePayloads = (quotationLines ?? []).map(
              (l: Record<string, unknown>) => ({
                tenant_id: db.tenantId,
                invoice_id: invoice.id,
                description: l.description,
                quantity: l.quantity,
                unit_price: l.unit_price,
                tax_rate: l.tax_rate,
                subtotal: l.subtotal,
                tax_amount: l.tax_amount,
                total: l.total,
                created_at: now,
              }),
            );

            const { error: invLineError } = await db.client
              .from("invoice_lines")
              .insert(invoiceLinePayloads);

            if (invLineError)
              return errorResult(`Failed to create invoice lines: ${invLineError.message}`);

            // Link invoice back to quotation
            const { error: linkError } = await db.client
              .from("quotations")
              .update({
                converted_invoice_id: invoice.id,
                status: "converted",
                updated_at: now,
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id);

            if (linkError)
              return errorResult(`Failed to link invoice to quotation: ${linkError.message}`);

            await writeAuditLog(db, {
              entity_type: "quotation",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { converted_to_invoice: invoice.id },
            });

            return jsonResult(
              { quotation_id: id, invoice },
              `Quotation converted to invoice: ${invoiceNumber}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, send, accept, reject, convert_to_invoice`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
