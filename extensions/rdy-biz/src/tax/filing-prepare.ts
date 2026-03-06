import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { sumMoney, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const PERIOD_STATUSES = ["open", "calculating", "prepared", "submitted", "closed"] as const;

export function createFilingPrepareTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "tax_filing_prepare",
    label: "Tax: Prepare and Submit Filings",
    description:
      "Manage tax periods, prepare tax filing summaries aggregating all calculations, and record submission details.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create_period"),
          Type.Literal("get_period"),
          Type.Literal("list_periods"),
          Type.Literal("prepare_filing"),
          Type.Literal("submit_filing"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(Type.String({ description: "Period UUID (required for get_period)" })),
      tax_period_id: Type.Optional(
        Type.String({
          description: "Tax period UUID (required for prepare_filing, submit_filing)",
        }),
      ),
      jurisdiction: Type.Optional(
        Type.String({
          description: "Jurisdiction code (e.g. HK, US, GB) — required for create_period",
        }),
      ),
      period_start: Type.Optional(
        Type.String({
          format: "date",
          description: "Period start date YYYY-MM-DD — required for create_period",
        }),
      ),
      period_end: Type.Optional(
        Type.String({
          format: "date",
          description: "Period end date YYYY-MM-DD — required for create_period",
        }),
      ),
      reference_number: Type.Optional(
        Type.String({
          description: "Filing reference number from tax authority — required for submit_filing",
        }),
      ),
      filed_date: Type.Optional(
        Type.String({
          format: "date",
          description: "Date filed with tax authority — required for submit_filing",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          PERIOD_STATUSES.map((s) => Type.Literal(s)) as [
            ReturnType<typeof Type.Literal>,
            ...ReturnType<typeof Type.Literal>[],
          ],
          { description: "Filter list by status" },
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
          case "create_period": {
            const jurisdiction = params.jurisdiction as string | undefined;
            const periodStart = params.period_start as string | undefined;
            const periodEnd = params.period_end as string | undefined;

            if (!jurisdiction) return errorResult("jurisdiction is required for create_period");
            if (!periodStart) return errorResult("period_start is required for create_period");
            if (!periodEnd) return errorResult("period_end is required for create_period");
            if (periodStart >= periodEnd)
              return errorResult("period_end must be after period_start");

            const payload = {
              tenant_id: db.tenantId,
              jurisdiction,
              period_start: periodStart,
              period_end: periodEnd,
              status: "open",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("tax_periods")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create tax period: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_period",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { jurisdiction, period_start: periodStart, period_end: periodEnd },
            });

            return jsonResult(
              data,
              `Tax period created: ${data.jurisdiction} ${data.period_start} to ${data.period_end}`,
            );
          }

          case "get_period": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get_period");

            const { data, error } = await db.client
              .from("tax_periods")
              .select("*, tax_filings(*)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Tax period not found: ${error.message}`);

            return jsonResult(
              data,
              `Tax period: ${data.jurisdiction} ${data.period_start} to ${data.period_end} [${data.status}]`,
            );
          }

          case "list_periods": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const statusFilter = params.status as string | undefined;
            const jurisdictionFilter = params.jurisdiction as string | undefined;

            let query = db.client
              .from("tax_periods")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("period_start", { ascending: false })
              .range(offset, offset + limit - 1);

            if (statusFilter) query = query.eq("status", statusFilter);
            if (jurisdictionFilter) query = query.eq("jurisdiction", jurisdictionFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list tax periods: ${error.message}`);

            return jsonResult(
              { periods: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} tax periods (page ${page})`,
            );
          }

          case "prepare_filing": {
            const taxPeriodId = params.tax_period_id as string | undefined;
            if (!taxPeriodId) return errorResult("tax_period_id is required for prepare_filing");

            // Fetch the period
            const { data: period, error: periodErr } = await db.client
              .from("tax_periods")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId)
              .single();

            if (periodErr) return errorResult(`Tax period not found: ${periodErr.message}`);

            // Aggregate all tax calculations for the period
            const { data: calculations, error: calcErr } = await db.client
              .from("tax_calculations")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("tax_period_id", taxPeriodId);

            if (calcErr) return errorResult(`Failed to fetch calculations: ${calcErr.message}`);

            const calcs = calculations ?? [];

            // Build summary grouped by type
            const byType = calcs.reduce<
              Record<string, { taxable_amount: string[]; tax_amount: string[] }>
            >((acc, c: Record<string, unknown>) => {
              const t = c.type as string;
              if (!acc[t]) acc[t] = { taxable_amount: [], tax_amount: [] };
              acc[t].taxable_amount.push(c.taxable_amount as string);
              acc[t].tax_amount.push(c.tax_amount as string);
              return acc;
            }, {});

            const summary = Object.entries(byType).map(([type, amounts]) => ({
              type,
              total_taxable_amount: sumMoney(amounts.taxable_amount).toFixed(2),
              total_tax_amount: sumMoney(amounts.tax_amount).toFixed(2),
            }));

            const grandTotalTax = sumMoney(
              calcs.map((c: Record<string, unknown>) => c.tax_amount as string),
            );

            const filing = {
              jurisdiction: period.jurisdiction,
              period_start: period.period_start,
              period_end: period.period_end,
              currency: config.defaultCurrency,
              summary_by_type: summary,
              grand_total_tax: grandTotalTax.toFixed(2),
              grand_total_tax_formatted: formatMoney(grandTotalTax, config.defaultCurrency),
              calculation_count: calcs.length,
              prepared_at: new Date().toISOString(),
              prepared_by: _id,
            };

            // Update period status to "prepared"
            const { error: updateErr } = await db.client
              .from("tax_periods")
              .update({ status: "prepared", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId);

            if (updateErr)
              return errorResult(`Failed to update period status: ${updateErr.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_period",
              entity_id: taxPeriodId,
              action: "update",
              actor: _id,
              payload: { status: "prepared", grand_total_tax: grandTotalTax.toFixed(2) },
            });

            return jsonResult(
              { tax_period_id: taxPeriodId, filing },
              `Filing prepared for ${period.jurisdiction} ${period.period_start} to ${period.period_end} — total tax ${filing.grand_total_tax_formatted}`,
            );
          }

          case "submit_filing": {
            const taxPeriodId = params.tax_period_id as string | undefined;
            const referenceNumber = params.reference_number as string | undefined;
            const filedDate = params.filed_date as string | undefined;

            if (!taxPeriodId) return errorResult("tax_period_id is required for submit_filing");
            if (!referenceNumber)
              return errorResult("reference_number is required for submit_filing");
            if (!filedDate) return errorResult("filed_date is required for submit_filing");

            // Verify period exists and is in prepared status
            const { data: period, error: periodErr } = await db.client
              .from("tax_periods")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId)
              .single();

            if (periodErr) return errorResult(`Tax period not found: ${periodErr.message}`);
            if (period.status !== "prepared") {
              return errorResult(
                `Tax period must be in 'prepared' status to submit. Current status: ${period.status}`,
              );
            }

            // Create tax_filings record
            const filingPayload = {
              tenant_id: db.tenantId,
              tax_period_id: taxPeriodId,
              jurisdiction: period.jurisdiction,
              reference_number: referenceNumber,
              filed_date: filedDate,
              filed_by: _id,
              status: "submitted",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data: filingRecord, error: filingErr } = await db.client
              .from("tax_filings")
              .insert(filingPayload)
              .select("*")
              .single();

            if (filingErr)
              return errorResult(`Failed to create filing record: ${filingErr.message}`);

            // Update period status to "submitted"
            const { error: updateErr } = await db.client
              .from("tax_periods")
              .update({ status: "submitted", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId);

            if (updateErr)
              return errorResult(`Failed to update period status: ${updateErr.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_filing",
              entity_id: filingRecord.id,
              action: "create",
              actor: _id,
              payload: {
                tax_period_id: taxPeriodId,
                reference_number: referenceNumber,
                filed_date: filedDate,
              },
            });

            return jsonResult(
              filingRecord,
              `Filing submitted: ${period.jurisdiction} ref ${referenceNumber} on ${filedDate}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create_period, get_period, list_periods, prepare_filing, submit_filing`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
