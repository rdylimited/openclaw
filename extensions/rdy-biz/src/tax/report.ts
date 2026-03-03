import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { sumMoney, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createTaxReportTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "tax_report",
    label: "Tax: Reports and Obligations",
    description:
      "Generate tax summary reports, deductions reports, and obligations overview showing upcoming tax periods and their filing status.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("tax_summary"),
          Type.Literal("deductions_report"),
          Type.Literal("obligations"),
        ],
        { description: "Report to generate" },
      ),
      tax_period_id: Type.Optional(
        Type.String({ description: "Tax period UUID — required for deductions_report" }),
      ),
      period_start: Type.Optional(
        Type.String({
          format: "date",
          description: "Start of reporting window YYYY-MM-DD — required for tax_summary",
        }),
      ),
      period_end: Type.Optional(
        Type.String({
          format: "date",
          description: "End of reporting window YYYY-MM-DD — required for tax_summary",
        }),
      ),
      obligations_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Max upcoming periods to show for obligations",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "tax_summary": {
            const periodStart = params.period_start as string | undefined;
            const periodEnd = params.period_end as string | undefined;

            if (!periodStart) return errorResult("period_start is required for tax_summary");
            if (!periodEnd) return errorResult("period_end is required for tax_summary");
            if (periodStart > periodEnd)
              return errorResult("period_end must be on or after period_start");

            // Fetch all tax calculations whose period falls within the window
            // Join through tax_periods to filter by date range
            const { data: calculations, error: calcErr } = await db.client
              .from("tax_calculations")
              .select(
                "type, taxable_amount, tax_amount, currency, jurisdiction, created_at, tax_periods!inner(period_start, period_end)",
              )
              .eq("tenant_id", db.tenantId)
              .gte("tax_periods.period_start", periodStart)
              .lte("tax_periods.period_end", periodEnd);

            if (calcErr) return errorResult(`Failed to fetch tax calculations: ${calcErr.message}`);

            const calcs = calculations ?? [];

            // Group by type
            const byType = calcs.reduce<
              Record<string, { taxable_amounts: string[]; tax_amounts: string[]; count: number }>
            >((acc, c: Record<string, unknown>) => {
              const t = c.type as string;
              if (!acc[t]) acc[t] = { taxable_amounts: [], tax_amounts: [], count: 0 };
              acc[t].taxable_amounts.push(c.taxable_amount as string);
              acc[t].tax_amounts.push(c.tax_amount as string);
              acc[t].count += 1;
              return acc;
            }, {});

            const summaryByType = Object.entries(byType).map(([type, data]) => {
              const totalTaxable = sumMoney(data.taxable_amounts);
              const totalTax = sumMoney(data.tax_amounts);
              return {
                type,
                calculation_count: data.count,
                total_taxable_amount: totalTaxable.toFixed(2),
                total_taxable_formatted: formatMoney(totalTaxable, config.defaultCurrency),
                total_tax_amount: totalTax.toFixed(2),
                total_tax_formatted: formatMoney(totalTax, config.defaultCurrency),
              };
            });

            const grandTotalTax = sumMoney(
              calcs.map((c: Record<string, unknown>) => c.tax_amount as string),
            );
            const grandTotalTaxable = sumMoney(
              calcs.map((c: Record<string, unknown>) => c.taxable_amount as string),
            );

            const report = {
              period_start: periodStart,
              period_end: periodEnd,
              jurisdiction: config.taxJurisdiction,
              currency: config.defaultCurrency,
              summary_by_type: summaryByType,
              totals: {
                total_taxable_amount: grandTotalTaxable.toFixed(2),
                total_taxable_formatted: formatMoney(grandTotalTaxable, config.defaultCurrency),
                total_tax_amount: grandTotalTax.toFixed(2),
                total_tax_formatted: formatMoney(grandTotalTax, config.defaultCurrency),
                calculation_count: calcs.length,
              },
              generated_at: new Date().toISOString(),
            };

            return jsonResult(
              report,
              `Tax summary for ${periodStart} to ${periodEnd} — total tax ${report.totals.total_tax_formatted}`,
            );
          }

          case "deductions_report": {
            const taxPeriodId = params.tax_period_id as string | undefined;
            if (!taxPeriodId) return errorResult("tax_period_id is required for deductions_report");

            // Verify the period exists
            const { data: period, error: periodErr } = await db.client
              .from("tax_periods")
              .select("jurisdiction, period_start, period_end, status")
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId)
              .single();

            if (periodErr) return errorResult(`Tax period not found: ${periodErr.message}`);

            // Fetch all deductions for this period
            const { data: deductions, error: dedErr } = await db.client
              .from("tax_deductions")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("tax_period_id", taxPeriodId)
              .order("type", { ascending: true })
              .order("amount", { ascending: false });

            if (dedErr) return errorResult(`Failed to fetch deductions: ${dedErr.message}`);

            const deds = deductions ?? [];

            // Group by deduction type
            const byType = deds.reduce<Record<string, { amounts: string[]; items: unknown[] }>>(
              (acc, d: Record<string, unknown>) => {
                const t = (d.type as string) ?? "other";
                if (!acc[t]) acc[t] = { amounts: [], items: [] };
                acc[t].amounts.push(d.amount as string);
                acc[t].items.push(d);
                return acc;
              },
              {},
            );

            const deductionsByType = Object.entries(byType).map(([type, data]) => {
              const total = sumMoney(data.amounts);
              return {
                type,
                item_count: data.items.length,
                total_amount: total.toFixed(2),
                total_formatted: formatMoney(total, config.defaultCurrency),
                items: data.items,
              };
            });

            const grandTotal = sumMoney(
              deds.map((d: Record<string, unknown>) => d.amount as string),
            );

            const report = {
              tax_period_id: taxPeriodId,
              jurisdiction: period.jurisdiction,
              period_start: period.period_start,
              period_end: period.period_end,
              period_status: period.status,
              currency: config.defaultCurrency,
              deductions_by_type: deductionsByType,
              totals: {
                total_deductions: grandTotal.toFixed(2),
                total_formatted: formatMoney(grandTotal, config.defaultCurrency),
                item_count: deds.length,
              },
              generated_at: new Date().toISOString(),
            };

            return jsonResult(
              report,
              `Deductions report for ${period.jurisdiction} ${period.period_start} to ${period.period_end} — ${deds.length} items totalling ${report.totals.total_formatted}`,
            );
          }

          case "obligations": {
            const obligationsLimit = (params.obligations_limit as number | undefined) ?? 10;
            const today = new Date().toISOString().slice(0, 10);

            // Fetch upcoming and recent periods with their filing status
            const { data: upcoming, error: upcomingErr } = await db.client
              .from("tax_periods")
              .select("*, tax_filings(id, reference_number, filed_date, status)")
              .eq("tenant_id", db.tenantId)
              .gte("period_end", today)
              .order("period_end", { ascending: true })
              .limit(obligationsLimit);

            if (upcomingErr)
              return errorResult(`Failed to fetch upcoming periods: ${upcomingErr.message}`);

            // Also fetch recently past open/prepared periods (potential overdue)
            const { data: overdue, error: overdueErr } = await db.client
              .from("tax_periods")
              .select("*, tax_filings(id, reference_number, filed_date, status)")
              .eq("tenant_id", db.tenantId)
              .lt("period_end", today)
              .in("status", ["open", "calculating", "prepared"])
              .order("period_end", { ascending: false })
              .limit(obligationsLimit);

            if (overdueErr)
              return errorResult(`Failed to fetch overdue periods: ${overdueErr.message}`);

            const formatPeriod = (p: Record<string, unknown>) => ({
              id: p.id,
              jurisdiction: p.jurisdiction,
              period_start: p.period_start,
              period_end: p.period_end,
              status: p.status,
              is_overdue:
                (p.period_end as string) < today &&
                !["submitted", "closed"].includes(p.status as string),
              filings: p.tax_filings ?? [],
            });

            const report = {
              as_of_date: today,
              upcoming_obligations: (upcoming ?? []).map(formatPeriod),
              overdue_obligations: (overdue ?? []).map(formatPeriod),
              summary: {
                upcoming_count: (upcoming ?? []).length,
                overdue_count: (overdue ?? []).length,
              },
              generated_at: new Date().toISOString(),
            };

            const overdueCount = report.summary.overdue_count;
            const upcomingCount = report.summary.upcoming_count;
            const summaryLine = [
              overdueCount > 0
                ? `${overdueCount} OVERDUE obligation${overdueCount > 1 ? "s" : ""}`
                : null,
              upcomingCount > 0
                ? `${upcomingCount} upcoming obligation${upcomingCount > 1 ? "s" : ""}`
                : null,
            ]
              .filter(Boolean)
              .join(", ");

            return jsonResult(
              report,
              `Tax obligations as of ${today}: ${summaryLine || "none found"}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: tax_summary, deductions_report, obligations`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
