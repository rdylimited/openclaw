import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createCreditNoteTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_credit_note",
    label: "Finance: Credit Notes",
    description: "Create, retrieve, or list credit and debit notes against invoices or bills.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("get"), Type.Literal("list")], {
        description: "Operation to perform",
      }),
      id: Type.Optional(Type.String({ description: "Credit note UUID (required for get)" })),
      type: Type.Optional(
        Type.Union([Type.Literal("credit"), Type.Literal("debit")], {
          description: "Note type: credit (reduces amount owed) or debit (increases amount owed)",
        }),
      ),
      invoice_id: Type.Optional(Type.String({ description: "Invoice UUID this note applies to" })),
      bill_id: Type.Optional(Type.String({ description: "Bill UUID this note applies to" })),
      amount: Type.Optional(Type.String({ description: "Note amount as decimal string" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      reason: Type.Optional(Type.String({ description: "Reason for the credit or debit note" })),
      date: Type.Optional(
        Type.String({ description: "Note date (YYYY-MM-DD), defaults to today" }),
      ),
      type_filter: Type.Optional(
        Type.Union([Type.Literal("credit"), Type.Literal("debit")], {
          description: "Filter by note type (for list)",
        }),
      ),
      invoice_id_filter: Type.Optional(
        Type.String({ description: "Filter by invoice UUID (for list)" }),
      ),
      bill_id_filter: Type.Optional(Type.String({ description: "Filter by bill UUID (for list)" })),
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
            const type = params.type as string | undefined;
            const invoiceId = params.invoice_id as string | undefined;
            const billId = params.bill_id as string | undefined;
            const amount = params.amount as string | undefined;
            const reason = params.reason as string | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!type || !["credit", "debit"].includes(type)) {
              return errorResult("type is required and must be 'credit' or 'debit'");
            }
            if (!invoiceId && !billId) {
              return errorResult("Either invoice_id or bill_id is required for create");
            }
            if (invoiceId && billId) {
              return errorResult("Provide either invoice_id or bill_id, not both");
            }
            if (!amount) return errorResult("amount is required for create");

            const parsedAmount = money(amount);
            if (parsedAmount.lte(0)) return errorResult("amount must be positive");

            const now = new Date().toISOString();
            const date = (params.date as string | undefined) ?? now.slice(0, 10);
            const noteNumber = `${type === "credit" ? "CN" : "DN"}-${Date.now()}`;

            // Verify referenced document exists and belongs to tenant
            if (invoiceId) {
              const { error: invError } = await db.client
                .from("invoices")
                .select("id")
                .eq("tenant_id", db.tenantId)
                .eq("id", invoiceId)
                .single();

              if (invError) return errorResult(`Invoice not found: ${invError.message}`);
            }

            if (billId) {
              const { error: billError } = await db.client
                .from("bills")
                .select("id")
                .eq("tenant_id", db.tenantId)
                .eq("id", billId)
                .single();

              if (billError) return errorResult(`Bill not found: ${billError.message}`);
            }

            const payload = {
              tenant_id: db.tenantId,
              note_number: noteNumber,
              type,
              invoice_id: invoiceId ?? null,
              bill_id: billId ?? null,
              amount: parsedAmount.toFixed(2),
              currency,
              reason: reason ?? null,
              date,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("credit_notes")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create credit note: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "credit_note",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: {
                type,
                invoice_id: invoiceId ?? null,
                bill_id: billId ?? null,
                amount: parsedAmount.toFixed(2),
              },
            });

            return jsonResult(
              data,
              `${type === "credit" ? "Credit" : "Debit"} note created: ${noteNumber} — ${currency} ${parsedAmount.toFixed(2)}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("credit_notes")
              .select("*, invoice:invoices(invoice_number), bill:bills(bill_number)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Credit note not found: ${error.message}`);

            return jsonResult(data, `Credit note: ${data.note_number}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const typeFilter = params.type_filter as string | undefined;
            const invoiceIdFilter = params.invoice_id_filter as string | undefined;
            const billIdFilter = params.bill_id_filter as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("credit_notes")
              .select("*, invoice:invoices(invoice_number), bill:bills(bill_number)", {
                count: "exact",
              })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (typeFilter) query = query.eq("type", typeFilter);
            if (invoiceIdFilter) query = query.eq("invoice_id", invoiceIdFilter);
            if (billIdFilter) query = query.eq("bill_id", billIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list credit notes: ${error.message}`);

            return jsonResult(
              { notes: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} credit/debit notes (page ${page})`,
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
