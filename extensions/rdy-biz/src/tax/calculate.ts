import { Type } from "@sinclair/typebox";
import Decimal from "decimal.js";
import { writeAuditLog } from "../core/audit.js";
import { resolveBookId } from "../core/book.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";
import { computeCnCit, computeCnVatSmallScale } from "./cn-tax.js";

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
      book: Type.Optional(
        Type.String({
          description:
            "Book code (e.g. 'statutory', 'internal'). Defaults to 'statutory' for tax calculations.",
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

            // Resolve book — default to "statutory" for tax calcs
            const bookCode = (params.book as string | undefined) ?? "statutory";
            const bookId = await resolveBookId(db, bookCode);

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
              book: bookCode,
            };

            if (type === "profits") {
              // Revenue - expenses from posted journal entries
              // Bug fix: use journal_lines (not journal_entry_lines), join chart_of_accounts for account codes
              let jeQuery = db.client
                .from("journal_lines")
                .select(
                  "account_id, debit, credit, account:chart_of_accounts!account_id(code, type), journal_entry:journal_entries!journal_entry_id(status, date)",
                )
                .eq("tenant_id", db.tenantId)
                .eq("journal_entry.status", "posted")
                .gte("journal_entry.date", periodStart)
                .lte("journal_entry.date", periodEnd);

              // Filter by book if available
              if (bookId) {
                jeQuery = jeQuery.eq("journal_entry.book_id", bookId);
              }

              const { data: jeLines, error: jeErr } = await jeQuery;

              if (jeErr) return errorResult(`Failed to fetch journal entries: ${jeErr.message}`);

              // Sum revenue (credit-normal accounts in 4xxx range)
              const revenue = sumMoney(
                (jeLines ?? [])
                  .filter((l: Record<string, unknown>) => {
                    const acct = l.account as Record<string, unknown> | null;
                    return acct && isRevenueAccount(acct.code as string);
                  })
                  .map((l: Record<string, unknown>) => {
                    // Revenue = credits - debits for revenue accounts
                    const credit = money((l.credit as string) ?? "0");
                    const debit = money((l.debit as string) ?? "0");
                    return credit.minus(debit).toFixed(2);
                  }),
              );

              const expenses = sumMoney(
                (jeLines ?? [])
                  .filter((l: Record<string, unknown>) => {
                    const acct = l.account as Record<string, unknown> | null;
                    return acct && isExpenseAccount(acct.code as string);
                  })
                  .map((l: Record<string, unknown>) => {
                    // Expenses = debits - credits for expense accounts
                    const debit = money((l.debit as string) ?? "0");
                    const credit = money((l.credit as string) ?? "0");
                    return debit.minus(credit).toFixed(2);
                  }),
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
              } else if (config.taxJurisdiction === "CN") {
                const enterpriseType = config.cnEnterpriseType ?? "standard";
                const result = computeCnCit(taxableAmount, enterpriseType);
                taxAmount = result.tax;
                appliedRate = result.rate.toNumber();
                metadata.calculation_method = result.method;
                metadata.enterprise_type = enterpriseType;
              } else {
                appliedRate = config.profitsTaxRate;
                taxAmount = computeStandardTax(taxableAmount, appliedRate);
                metadata.calculation_method = "standard profits tax";
                metadata.applied_rate = appliedRate;
              }
            } else if (type === "sales" || type === "GST" || type === "VAT") {
              // Check for CN small-scale VAT
              if (config.taxJurisdiction === "CN" && config.cnVatTaxpayerType === "small_scale") {
                // CN small-scale: flat rate on sales, no input credit
                const { data: invoices, error: invErr } = await db.client
                  .from("invoices")
                  .select("subtotal")
                  .eq("tenant_id", db.tenantId)
                  .in("status", ["posted", "paid"])
                  .gte("invoice_date", periodStart)
                  .lte("invoice_date", periodEnd);

                if (invErr) return errorResult(`Failed to fetch invoices: ${invErr.message}`);

                taxableAmount = sumMoney(
                  (invoices ?? []).map((i: Record<string, unknown>) => i.subtotal as string),
                );
                const vatResult = computeCnVatSmallScale(taxableAmount);
                taxAmount = vatResult.tax;
                appliedRate = vatResult.rate;
                metadata.invoice_count = (invoices ?? []).length;
                metadata.calculation_method = vatResult.method;
              } else {
                // Standard output tax minus input tax method
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
              }
            } else if (type === "income") {
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

            // Bug fix 3: pack all metadata into supporting_data JSONB
            // (table only has supporting_data, not applied_rate/jurisdiction/currency/metadata)
            const supportingData = {
              ...metadata,
              applied_rate: appliedRate,
              jurisdiction: config.taxJurisdiction,
              currency: config.defaultCurrency,
            };

            const calculationPayload = {
              tenant_id: db.tenantId,
              tax_period_id: taxPeriodId,
              type,
              taxable_amount: taxableAmount.toFixed(2),
              tax_amount: taxAmount.toFixed(2),
              supporting_data: JSON.stringify(supportingData),
              created_at: new Date().toISOString(),
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
              { ...calc, ...supportingData },
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

            const supportingData = (data.supporting_data ?? {}) as Record<string, unknown>;
            const currency = (supportingData.currency as string) ?? config.defaultCurrency;

            return jsonResult(
              { ...data, ...supportingData },
              `Tax calculation: ${data.type} — ${formatMoney(data.tax_amount, currency)}`,
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

function isRevenueAccount(code: string): boolean {
  const num = parseInt(code, 10);
  return (num >= 4000 && num < 5000) || (num >= 6001 && num <= 6301);
}

function isExpenseAccount(code: string): boolean {
  const num = parseInt(code, 10);
  return (num >= 5000 && num < 7000) || (num >= 6401 && num <= 6811);
}
