import { Type } from "@sinclair/typebox";
import Decimal from "decimal.js";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const CALC_TAX_TYPES = ["GST", "VAT", "WHT", "income", "profits", "sales"] as const;
type CalcTaxType = (typeof CALC_TAX_TYPES)[number];

// HK two-tier profits tax thresholds
const HK_TWO_TIER_THRESHOLD = "2000000"; // HKD 2,000,000
const HK_FIRST_TIER_RATE = 0.0825; // 8.25% on first HKD 2M
const HK_SECOND_TIER_RATE = 0.165; // 16.5% on remainder

function computeHkProfitsTax(assessableProfit: Decimal): Decimal {
  if (assessableProfit.lte(0)) return new Decimal(0);

  const threshold = money(HK_TWO_TIER_THRESHOLD);
  if (assessableProfit.lte(threshold)) {
    return assessableProfit.times(HK_FIRST_TIER_RATE);
  }

  const firstTierTax = threshold.times(HK_FIRST_TIER_RATE);
  const secondTierTax = assessableProfit.minus(threshold).times(HK_SECOND_TIER_RATE);
  return firstTierTax.plus(secondTierTax);
}

function computeStandardTax(taxableAmount: Decimal, rate: number): Decimal {
  return taxableAmount.times(rate);
}

export function createTaxCalculateTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "tax_calculate",
    label: "Tax: Calculate Tax",
    description:
      "Calculate tax for a period by querying financial data (invoices, bills, payroll, journal entries), store results in tax_calculations. Retrieve or list past calculations.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("calculate_period"),
          Type.Literal("get_calculation"),
          Type.Literal("list_calculations"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Calculation UUID (required for get_calculation)" }),
      ),
      tax_period_id: Type.Optional(
        Type.String({
          description: "Tax period UUID (required for calculate_period, list_calculations)",
        }),
      ),
      type: Type.Optional(
        Type.Union(
          CALC_TAX_TYPES.map((t) => Type.Literal(t)) as [
            ReturnType<typeof Type.Literal>,
            ...ReturnType<typeof Type.Literal>[],
          ],
          { description: `Tax type to calculate: ${CALC_TAX_TYPES.join(", ")}` },
        ),
      ),
      tax_rate_id: Type.Optional(
        Type.String({
          description: "Tax rate UUID to apply (overrides config rate for non-profits types)",
        }),
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
          case "calculate_period": {
            const taxPeriodId = params.tax_period_id as string | undefined;
            const type = params.type as CalcTaxType | undefined;

            if (!taxPeriodId) return errorResult("tax_period_id is required for calculate_period");
            if (!type || !CALC_TAX_TYPES.includes(type)) {
              return errorResult(
                `type is required and must be one of: ${CALC_TAX_TYPES.join(", ")}`,
              );
            }

            // Fetch the tax period to get date bounds
            const { data: period, error: periodErr } = await db.client
              .from("tax_periods")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", taxPeriodId)
              .single();

            if (periodErr) return errorResult(`Tax period not found: ${periodErr.message}`);

            const periodStart = period.period_start as string;
            const periodEnd = period.period_end as string;

            let taxableAmount = new Decimal(0);
            let taxAmount = new Decimal(0);
            let appliedRate: number | null = null;
            const metadata: Record<string, unknown> = {
              period_start: periodStart,
              period_end: periodEnd,
            };

            if (type === "profits") {
              // Revenue - expenses from posted journal entries
              const { data: jeLines, error: jeErr } = await db.client
                .from("journal_entry_lines")
                .select("amount, type, journal_entries!inner(status, entry_date)")
                .eq("tenant_id", db.tenantId)
                .eq("journal_entries.status", "posted")
                .gte("journal_entries.entry_date", periodStart)
                .lte("journal_entries.entry_date", periodEnd);

              if (jeErr) return errorResult(`Failed to fetch journal entries: ${jeErr.message}`);

              const revenue = sumMoney(
                (jeLines ?? [])
                  .filter(
                    (l: Record<string, unknown>) => l.type === "credit" && isRevenueAccount(l),
                  )
                  .map((l: Record<string, unknown>) => l.amount as string),
              );
              const expenses = sumMoney(
                (jeLines ?? [])
                  .filter((l: Record<string, unknown>) => l.type === "debit" && isExpenseAccount(l))
                  .map((l: Record<string, unknown>) => l.amount as string),
              );

              const assessableProfit = revenue.minus(expenses);
              taxableAmount = assessableProfit.gt(0) ? assessableProfit : new Decimal(0);
              metadata.revenue = revenue.toFixed(2);
              metadata.expenses = expenses.toFixed(2);
              metadata.assessable_profit = taxableAmount.toFixed(2);

              if (config.taxJurisdiction === "HK") {
                taxAmount = computeHkProfitsTax(taxableAmount);
                metadata.calculation_method = "HK two-tier profits tax";
                metadata.first_tier_rate = HK_FIRST_TIER_RATE;
                metadata.second_tier_rate = HK_SECOND_TIER_RATE;
                metadata.threshold = HK_TWO_TIER_THRESHOLD;
              } else {
                appliedRate = config.profitsTaxRate;
                taxAmount = computeStandardTax(taxableAmount, appliedRate);
                metadata.calculation_method = "standard profits tax";
                metadata.applied_rate = appliedRate;
              }
            } else if (type === "sales" || type === "GST" || type === "VAT") {
              // Taxable invoices within the period
              const { data: invoices, error: invErr } = await db.client
                .from("invoices")
                .select("subtotal, tax_amount")
                .eq("tenant_id", db.tenantId)
                .in("status", ["posted", "paid"])
                .gte("invoice_date", periodStart)
                .lte("invoice_date", periodEnd);

              if (invErr) return errorResult(`Failed to fetch invoices: ${invErr.message}`);

              taxableAmount = sumMoney(
                (invoices ?? []).map((i: Record<string, unknown>) => i.subtotal as string),
              );
              const taxFromInvoices = sumMoney(
                (invoices ?? []).map((i: Record<string, unknown>) => i.tax_amount as string),
              );
              metadata.invoice_count = (invoices ?? []).length;
              metadata.output_tax = taxFromInvoices.toFixed(2);

              // Also compute purchase (input) tax from bills
              const { data: bills, error: billErr } = await db.client
                .from("bills")
                .select("subtotal, tax_amount")
                .eq("tenant_id", db.tenantId)
                .in("status", ["approved", "paid"])
                .gte("bill_date", periodStart)
                .lte("bill_date", periodEnd);

              if (billErr) return errorResult(`Failed to fetch bills: ${billErr.message}`);

              const inputTax = sumMoney(
                (bills ?? []).map((b: Record<string, unknown>) => b.tax_amount as string),
              );
              taxAmount = taxFromInvoices.minus(inputTax).lt(0)
                ? new Decimal(0)
                : taxFromInvoices.minus(inputTax);
              metadata.bill_count = (bills ?? []).length;
              metadata.input_tax = inputTax.toFixed(2);
              metadata.net_tax = taxAmount.toFixed(2);
              metadata.calculation_method = "output tax minus input tax";
            } else if (type === "income") {
              // Payroll data for income / payroll tax
              const { data: payroll, error: payErr } = await db.client
                .from("payroll_runs")
                .select("gross_salary, income_tax_withheld")
                .eq("tenant_id", db.tenantId)
                .eq("status", "processed")
                .gte("pay_date", periodStart)
                .lte("pay_date", periodEnd);

              if (payErr) return errorResult(`Failed to fetch payroll data: ${payErr.message}`);

              taxableAmount = sumMoney(
                (payroll ?? []).map((p: Record<string, unknown>) => p.gross_salary as string),
              );
              taxAmount = sumMoney(
                (payroll ?? []).map(
                  (p: Record<string, unknown>) => p.income_tax_withheld as string,
                ),
              );
              metadata.payroll_run_count = (payroll ?? []).length;
              metadata.calculation_method = "sum of income tax withheld from payroll";
            } else if (type === "WHT") {
              // Withholding tax already tracked separately
              const { data: whtRecords, error: whtErr } = await db.client
                .from("withholding_tax")
                .select("gross_amount, wht_amount")
                .eq("tenant_id", db.tenantId)
                .gte("created_at", periodStart)
                .lte("created_at", periodEnd);

              if (whtErr) return errorResult(`Failed to fetch WHT records: ${whtErr.message}`);

              taxableAmount = sumMoney(
                (whtRecords ?? []).map((w: Record<string, unknown>) => w.gross_amount as string),
              );
              taxAmount = sumMoney(
                (whtRecords ?? []).map((w: Record<string, unknown>) => w.wht_amount as string),
              );
              metadata.wht_record_count = (whtRecords ?? []).length;
              metadata.calculation_method = "sum of withholding tax records";
            }

            const calculationPayload = {
              tenant_id: db.tenantId,
              tax_period_id: taxPeriodId,
              type,
              taxable_amount: taxableAmount.toFixed(2),
              tax_amount: taxAmount.toFixed(2),
              applied_rate: appliedRate !== null ? String(appliedRate) : null,
              jurisdiction: config.taxJurisdiction,
              currency: config.defaultCurrency,
              metadata: JSON.stringify(metadata),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data: calc, error: calcErr } = await db.client
              .from("tax_calculations")
              .insert(calculationPayload)
              .select("*")
              .single();

            if (calcErr) return errorResult(`Failed to store calculation: ${calcErr.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_calculation",
              entity_id: calc.id,
              action: "create",
              actor: _id,
              payload: {
                tax_period_id: taxPeriodId,
                type,
                taxable_amount: taxableAmount.toFixed(2),
                tax_amount: taxAmount.toFixed(2),
              },
            });

            return jsonResult(
              { ...calc, metadata },
              `Tax calculated: ${type} — taxable ${formatMoney(taxableAmount, config.defaultCurrency)}, tax ${formatMoney(taxAmount, config.defaultCurrency)}`,
            );
          }

          case "get_calculation": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get_calculation");

            const { data, error } = await db.client
              .from("tax_calculations")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Tax calculation not found: ${error.message}`);

            return jsonResult(
              data,
              `Tax calculation: ${data.type} — ${formatMoney(data.tax_amount, data.currency ?? config.defaultCurrency)}`,
            );
          }

          case "list_calculations": {
            const taxPeriodId = params.tax_period_id as string | undefined;
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;

            let query = db.client
              .from("tax_calculations")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (taxPeriodId) query = query.eq("tax_period_id", taxPeriodId);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list calculations: ${error.message}`);

            return jsonResult(
              { calculations: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} tax calculations (page ${page})`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: calculate_period, get_calculation, list_calculations`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// Simple heuristics — in practice these would check account_code ranges
function isRevenueAccount(line: Record<string, unknown>): boolean {
  const accountCode = line.account_code as string | undefined;
  if (!accountCode) return true; // assume credit lines without code are revenue
  const code = parseInt(accountCode, 10);
  return code >= 4000 && code < 5000;
}

function isExpenseAccount(line: Record<string, unknown>): boolean {
  const accountCode = line.account_code as string | undefined;
  if (!accountCode) return true; // assume debit lines without code are expenses
  const code = parseInt(accountCode, 10);
  return code >= 5000 && code < 7000;
}
