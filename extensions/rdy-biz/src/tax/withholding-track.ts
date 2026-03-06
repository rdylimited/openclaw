import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult, textResult } from "../core/types.js";

export function createWithholdingTrackTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "tax_withholding_track",
    label: "Tax: Track Withholding Tax",
    description:
      "Create and manage withholding tax (WHT) records, generate formatted WHT certificates for payees, and list records by date range or tax rate.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("generate_certificate"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "WHT record UUID (required for get, generate_certificate)" }),
      ),
      payment_id: Type.Optional(
        Type.String({ description: "Payment UUID this WHT relates to — required for create" }),
      ),
      tax_rate_id: Type.Optional(
        Type.String({
          description: "Tax rate UUID applied — required for create; optional filter for list",
        }),
      ),
      gross_amount: Type.Optional(
        Type.String({
          description: "Gross payment amount as decimal string — required for create",
        }),
      ),
      wht_amount: Type.Optional(
        Type.String({
          description: "Withholding tax amount as decimal string — required for create",
        }),
      ),
      certificate_number: Type.Optional(
        Type.String({ description: "Certificate number issued to payee — required for create" }),
      ),
      date_from: Type.Optional(
        Type.String({ format: "date", description: "Filter list from this date (YYYY-MM-DD)" }),
      ),
      date_to: Type.Optional(
        Type.String({ format: "date", description: "Filter list to this date (YYYY-MM-DD)" }),
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
            const paymentId = params.payment_id as string | undefined;
            const taxRateId = params.tax_rate_id as string | undefined;
            const grossAmount = params.gross_amount as string | undefined;
            const whtAmount = params.wht_amount as string | undefined;
            const certificateNumber = params.certificate_number as string | undefined;

            if (!paymentId) return errorResult("payment_id is required for create");
            if (!taxRateId) return errorResult("tax_rate_id is required for create");
            if (!grossAmount) return errorResult("gross_amount is required for create");
            if (!whtAmount) return errorResult("wht_amount is required for create");
            if (!certificateNumber) return errorResult("certificate_number is required for create");

            // Validate amounts are positive decimals
            const gross = money(grossAmount);
            const wht = money(whtAmount);
            if (gross.lte(0)) return errorResult("gross_amount must be positive");
            if (wht.lt(0)) return errorResult("wht_amount must be non-negative");
            if (wht.gt(gross)) return errorResult("wht_amount cannot exceed gross_amount");

            // Fetch tax rate for rate percentage display
            const { data: taxRate, error: rateErr } = await db.client
              .from("tax_rates")
              .select("name, rate, jurisdiction, type")
              .eq("tenant_id", db.tenantId)
              .eq("id", taxRateId)
              .single();

            if (rateErr) return errorResult(`Tax rate not found: ${rateErr.message}`);

            const payload = {
              tenant_id: db.tenantId,
              payment_id: paymentId,
              tax_rate_id: taxRateId,
              gross_amount: gross.toFixed(2),
              wht_amount: wht.toFixed(2),
              net_amount: gross.minus(wht).toFixed(2),
              certificate_number: certificateNumber,
              currency: config.defaultCurrency,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("withholding_tax")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create WHT record: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "withholding_tax",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: {
                payment_id: paymentId,
                tax_rate_id: taxRateId,
                gross_amount: gross.toFixed(2),
                wht_amount: wht.toFixed(2),
                certificate_number: certificateNumber,
              },
            });

            return jsonResult(
              { ...data, tax_rate: taxRate },
              `WHT record created: cert ${certificateNumber} — gross ${formatMoney(gross, config.defaultCurrency)}, WHT ${formatMoney(wht, config.defaultCurrency)} (${taxRate.name})`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("withholding_tax")
              .select("*, tax_rates(name, rate, type, jurisdiction)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`WHT record not found: ${error.message}`);

            return jsonResult(
              data,
              `WHT record: cert ${data.certificate_number} — ${formatMoney(data.wht_amount, data.currency ?? config.defaultCurrency)}`,
            );
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const taxRateId = params.tax_rate_id as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("withholding_tax")
              .select("*, tax_rates(name, rate, type, jurisdiction)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (taxRateId) query = query.eq("tax_rate_id", taxRateId);
            if (dateFrom) query = query.gte("created_at", dateFrom);
            if (dateTo) query = query.lte("created_at", dateTo + "T23:59:59");

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list WHT records: ${error.message}`);

            return jsonResult(
              { withholding_tax: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} WHT records (page ${page})`,
            );
          }

          case "generate_certificate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for generate_certificate");

            const { data: wht, error: whtErr } = await db.client
              .from("withholding_tax")
              .select(
                "*, tax_rates(name, rate, type, jurisdiction), payments(payee_name, payee_tax_id, payment_date, description)",
              )
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (whtErr) return errorResult(`WHT record not found: ${whtErr.message}`);

            const taxRate = wht.tax_rates as Record<string, unknown> | null;
            const payment = wht.payments as Record<string, unknown> | null;
            const currency = (wht.currency as string | undefined) ?? config.defaultCurrency;

            const certificateText = [
              "=".repeat(60),
              "        WITHHOLDING TAX CERTIFICATE",
              "=".repeat(60),
              "",
              `Certificate Number : ${wht.certificate_number}`,
              `Issue Date         : ${new Date().toISOString().slice(0, 10)}`,
              "",
              "PAYEE INFORMATION",
              "-".repeat(40),
              `Payee Name         : ${payment?.payee_name ?? "N/A"}`,
              `Payee Tax ID       : ${payment?.payee_tax_id ?? "N/A"}`,
              "",
              "PAYMENT DETAILS",
              "-".repeat(40),
              `Payment Date       : ${payment?.payment_date ?? "N/A"}`,
              `Description        : ${payment?.description ?? "N/A"}`,
              "",
              "TAX DETAILS",
              "-".repeat(40),
              `Tax Type           : ${taxRate?.type ?? "WHT"}`,
              `Tax Rate Name      : ${taxRate?.name ?? "N/A"}`,
              `Applied Rate       : ${taxRate?.rate !== undefined ? (Number(taxRate.rate) * 100).toFixed(2) + "%" : "N/A"}`,
              `Jurisdiction       : ${taxRate?.jurisdiction ?? config.taxJurisdiction}`,
              "",
              "AMOUNTS",
              "-".repeat(40),
              `Gross Amount       : ${formatMoney(wht.gross_amount as string, currency)}`,
              `Withholding Tax    : ${formatMoney(wht.wht_amount as string, currency)}`,
              `Net Amount Paid    : ${formatMoney(wht.net_amount as string, currency)}`,
              "",
              "=".repeat(60),
              "This certificate is issued for tax filing purposes.",
              "=".repeat(60),
            ].join("\n");

            return textResult(certificateText, {
              withholding_id: id,
              certificate_number: wht.certificate_number,
              gross_amount: wht.gross_amount,
              wht_amount: wht.wht_amount,
              net_amount: wht.net_amount,
            });
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, generate_certificate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
