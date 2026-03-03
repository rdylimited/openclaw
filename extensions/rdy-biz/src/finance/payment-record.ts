import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type Allocation = {
  invoice_id?: string;
  bill_id?: string;
  amount: string;
};

export function createPaymentRecordTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_payment_record",
    label: "Finance: Payment Record",
    description: "Record received or made payments with optional allocation to invoices or bills.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("get"), Type.Literal("list")], {
        description: "Operation to perform",
      }),
      id: Type.Optional(Type.String({ description: "Payment UUID (required for get)" })),
      type: Type.Optional(
        Type.Union([Type.Literal("received"), Type.Literal("made")], {
          description: "Payment direction: received (from customer) or made (to supplier)",
        }),
      ),
      contact_id: Type.Optional(Type.String({ description: "Customer or supplier contact UUID" })),
      amount: Type.Optional(Type.String({ description: "Total payment amount as decimal string" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal("bank_transfer"),
            Type.Literal("cheque"),
            Type.Literal("cash"),
            Type.Literal("credit_card"),
            Type.Literal("other"),
          ],
          { description: "Payment method" },
        ),
      ),
      reference: Type.Optional(
        Type.String({ description: "Payment reference number or cheque number" }),
      ),
      date: Type.Optional(Type.String({ description: "Payment date (YYYY-MM-DD)" })),
      allocated_to: Type.Optional(
        Type.Array(
          Type.Object({
            invoice_id: Type.Optional(
              Type.String({ description: "Invoice UUID to allocate against" }),
            ),
            bill_id: Type.Optional(Type.String({ description: "Bill UUID to allocate against" })),
            amount: Type.String({ description: "Amount to allocate as decimal string" }),
          }),
          { description: "Allocation of payment to specific invoices or bills" },
        ),
      ),
      type_filter: Type.Optional(
        Type.Union([Type.Literal("received"), Type.Literal("made")], {
          description: "Filter by payment type (for list)",
        }),
      ),
      contact_id_filter: Type.Optional(
        Type.String({ description: "Filter by contact UUID (for list)" }),
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
            const type = params.type as string | undefined;
            const contactId = params.contact_id as string | undefined;
            const amount = params.amount as string | undefined;
            const date = params.date as string | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;
            const allocatedTo = (params.allocated_to as Allocation[] | undefined) ?? [];

            if (!type || !["received", "made"].includes(type)) {
              return errorResult("type is required and must be 'received' or 'made'");
            }
            if (!contactId) return errorResult("contact_id is required for create");
            if (!amount) return errorResult("amount is required for create");
            if (!date) return errorResult("date is required for create");

            const parsedAmount = money(amount);
            if (parsedAmount.lte(0)) return errorResult("amount must be positive");

            const now = new Date().toISOString();

            const paymentPayload = {
              tenant_id: db.tenantId,
              type,
              contact_id: contactId,
              amount: parsedAmount.toFixed(2),
              currency,
              method: (params.method as string | undefined) ?? "bank_transfer",
              reference: (params.reference as string | undefined) ?? null,
              date,
              notes: (params.notes as string | undefined) ?? null,
              created_at: now,
              updated_at: now,
            };

            const { data: payment, error: paymentError } = await db.client
              .from("payments")
              .insert(paymentPayload)
              .select("*")
              .single();

            if (paymentError)
              return errorResult(`Failed to create payment: ${paymentError.message}`);

            // Insert allocations if provided
            if (allocatedTo.length > 0) {
              const allocationPayloads = allocatedTo.map((a) => ({
                tenant_id: db.tenantId,
                payment_id: payment.id,
                invoice_id: a.invoice_id ?? null,
                bill_id: a.bill_id ?? null,
                amount: money(a.amount).toFixed(2),
                created_at: now,
              }));

              const { error: allocError } = await db.client
                .from("payment_allocations")
                .insert(allocationPayloads);

              if (allocError)
                return errorResult(`Failed to create payment allocations: ${allocError.message}`);
            }

            await writeAuditLog(db, {
              entity_type: "payment",
              entity_id: payment.id,
              action: "create",
              actor: _id,
              payload: { type, contact_id: contactId, amount: parsedAmount.toFixed(2), currency },
            });

            return jsonResult(
              payment,
              `Payment recorded: ${type} ${currency} ${parsedAmount.toFixed(2)} on ${date}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: payment, error: paymentError } = await db.client
              .from("payments")
              .select("*, contact:contacts(name)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (paymentError) return errorResult(`Payment not found: ${paymentError.message}`);

            const { data: allocations, error: allocError } = await db.client
              .from("payment_allocations")
              .select("*, invoice:invoices(invoice_number), bill:bills(bill_number)")
              .eq("tenant_id", db.tenantId)
              .eq("payment_id", id);

            if (allocError)
              return errorResult(`Failed to fetch allocations: ${allocError.message}`);

            return jsonResult({ payment, allocations: allocations ?? [] }, `Payment: ${id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const typeFilter = params.type_filter as string | undefined;
            const contactIdFilter = params.contact_id_filter as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("payments")
              .select("*, contact:contacts(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (typeFilter) query = query.eq("type", typeFilter);
            if (contactIdFilter) query = query.eq("contact_id", contactIdFilter);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list payments: ${error.message}`);

            return jsonResult(
              { payments: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} payments (page ${page})`,
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
