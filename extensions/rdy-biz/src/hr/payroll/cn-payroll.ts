import Decimal from "decimal.js";
import { money, sumMoney } from "../../core/money.js";
import type {
  PayrollStrategy,
  PayrollStrategyContext,
  PayrollDeductions,
  DeductionItem,
} from "./types.js";

// CN IIT progressive brackets (monthly, cumulative YTD)
const IIT_BRACKETS: Array<{ upper: Decimal; rate: Decimal; deduction: Decimal }> = [
  { upper: new Decimal("36000"), rate: new Decimal("0.03"), deduction: new Decimal("0") },
  { upper: new Decimal("144000"), rate: new Decimal("0.10"), deduction: new Decimal("2520") },
  { upper: new Decimal("300000"), rate: new Decimal("0.20"), deduction: new Decimal("16920") },
  { upper: new Decimal("420000"), rate: new Decimal("0.25"), deduction: new Decimal("31920") },
  { upper: new Decimal("660000"), rate: new Decimal("0.30"), deduction: new Decimal("52920") },
  { upper: new Decimal("960000"), rate: new Decimal("0.35"), deduction: new Decimal("85920") },
  { upper: new Decimal("Infinity"), rate: new Decimal("0.45"), deduction: new Decimal("181920") },
];

const STANDARD_DEDUCTION_MONTHLY = new Decimal("5000"); // CNY 5,000/month

type SocialInsuranceRates = {
  pension_employee: number;
  pension_employer: number;
  medical_employee: number;
  medical_employer: number;
  unemployment_employee: number;
  unemployment_employer: number;
  work_injury_employer: number;
  maternity_employer: number;
  housing_fund_employee: number;
  housing_fund_employer: number;
  pension_base_min: number;
  pension_base_max: number;
  housing_base_min: number;
  housing_base_max: number;
};

const DEFAULT_RATES: SocialInsuranceRates = {
  pension_employee: 0.08,
  pension_employer: 0.16,
  medical_employee: 0.02,
  medical_employer: 0.08,
  unemployment_employee: 0.005,
  unemployment_employer: 0.005,
  work_injury_employer: 0.004,
  maternity_employer: 0.008,
  housing_fund_employee: 0.07,
  housing_fund_employer: 0.07,
  pension_base_min: 0,
  pension_base_max: 0,
  housing_base_min: 0,
  housing_base_max: 0,
};

function clampBase(salary: Decimal, min: number, max: number): Decimal {
  let base = salary;
  if (min > 0 && base.lt(min)) base = new Decimal(min);
  if (max > 0 && base.gt(max)) base = new Decimal(max);
  return base;
}

async function loadRates(ctx: PayrollStrategyContext): Promise<SocialInsuranceRates> {
  const city = (ctx.config.cnCity as string) ?? "default";

  const { data, error } = await ctx.db.client
    .from("cn_social_insurance_rates")
    .select("*")
    .eq("tenant_id", ctx.db.tenantId)
    .eq("city", city)
    .eq("active", true)
    .lte("effective_from", ctx.periodEnd)
    .order("effective_from", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) {
    // Try "default" city as fallback
    if (city !== "default") {
      const { data: fallback } = await ctx.db.client
        .from("cn_social_insurance_rates")
        .select("*")
        .eq("tenant_id", ctx.db.tenantId)
        .eq("city", "default")
        .eq("active", true)
        .lte("effective_from", ctx.periodEnd)
        .order("effective_from", { ascending: false })
        .limit(1);

      if (fallback && fallback.length > 0) return fallback[0] as unknown as SocialInsuranceRates;
    }
    return DEFAULT_RATES;
  }

  return data[0] as unknown as SocialInsuranceRates;
}

/**
 * Compute CN IIT using cumulative YTD withholding method.
 * monthNumber = which month in the tax year (1-12).
 * ytdTaxableIncome = cumulative taxable income before this month.
 * ytdTaxPaid = cumulative tax already withheld in prior months.
 */
function computeIit(
  monthlyTaxable: Decimal,
  monthNumber: number,
  ytdTaxableIncome: Decimal = new Decimal(0),
  ytdTaxPaid: Decimal = new Decimal(0),
): Decimal {
  // Cumulative taxable income including this month
  const cumulativeTaxable = ytdTaxableIncome.plus(monthlyTaxable);
  if (cumulativeTaxable.lte(0)) return new Decimal(0);

  // Find bracket
  let bracket = IIT_BRACKETS[IIT_BRACKETS.length - 1];
  for (const b of IIT_BRACKETS) {
    if (cumulativeTaxable.lte(b.upper)) {
      bracket = b;
      break;
    }
  }

  // Cumulative tax = cumulative taxable × rate - quick deduction
  const cumulativeTax = cumulativeTaxable.times(bracket.rate).minus(bracket.deduction);
  // This month's withholding = cumulative tax - already paid
  const thisMonthTax = Decimal.max(new Decimal(0), cumulativeTax.minus(ytdTaxPaid));
  return thisMonthTax;
}

export const cnPayrollStrategy: PayrollStrategy = {
  jurisdiction: "CN",

  async compute(ctx: PayrollStrategyContext): Promise<PayrollDeductions> {
    const rates = await loadRates(ctx);

    const pensionBase = clampBase(ctx.grossSalary, rates.pension_base_min, rates.pension_base_max);
    const housingBase = clampBase(ctx.grossSalary, rates.housing_base_min, rates.housing_base_max);

    // Employee deductions
    const pensionEmp = pensionBase.times(rates.pension_employee);
    const medicalEmp = ctx.grossSalary.times(rates.medical_employee);
    const unemploymentEmp = ctx.grossSalary.times(rates.unemployment_employee);
    const housingEmp = housingBase.times(rates.housing_fund_employee);

    // Employer contributions
    const pensionEr = pensionBase.times(rates.pension_employer);
    const medicalEr = ctx.grossSalary.times(rates.medical_employer);
    const unemploymentEr = ctx.grossSalary.times(rates.unemployment_employer);
    const workInjuryEr = ctx.grossSalary.times(rates.work_injury_employer);
    const maternityEr = ctx.grossSalary.times(rates.maternity_employer);
    const housingEr = housingBase.times(rates.housing_fund_employer);

    const totalSocialEmp = pensionEmp.plus(medicalEmp).plus(unemploymentEmp);
    const totalSocialEr = pensionEr
      .plus(medicalEr)
      .plus(unemploymentEr)
      .plus(workInjuryEr)
      .plus(maternityEr);

    // IIT calculation (simplified: assumes month 1, no YTD context)
    // In practice, YTD would be fetched from prior payroll items
    const monthlyTaxable = ctx.grossSalary
      .minus(totalSocialEmp)
      .minus(housingEmp)
      .minus(STANDARD_DEDUCTION_MONTHLY);

    // Determine month number from period
    const periodMonth = new Date(ctx.periodEnd).getMonth() + 1;

    // Fetch YTD data from prior payroll items this year
    const yearStart = `${new Date(ctx.periodEnd).getFullYear()}-01-01`;
    const { data: priorItems } = await ctx.db.client
      .from("payroll_items")
      .select("gross, deductions, tax")
      .eq("tenant_id", ctx.db.tenantId)
      .eq("employee_id", ctx.employeeId)
      .gte("created_at", yearStart)
      .lt("created_at", ctx.periodStart);

    let ytdTaxable = new Decimal(0);
    let ytdTaxPaid = new Decimal(0);
    for (const item of priorItems ?? []) {
      // Approximate YTD taxable from prior gross minus deductions
      const priorGross = money(item.gross ?? "0");
      const priorTax = money(item.tax ?? "0");
      const deductions = item.deductions as Record<string, string> | null;
      const priorSocial = money(deductions?.social_insurance ?? "0");
      const priorHousing = money(deductions?.housing_fund ?? "0");
      ytdTaxable = ytdTaxable.plus(
        priorGross.minus(priorSocial).minus(priorHousing).minus(STANDARD_DEDUCTION_MONTHLY),
      );
      ytdTaxPaid = ytdTaxPaid.plus(priorTax);
    }

    const iit = computeIit(monthlyTaxable, periodMonth, ytdTaxable, ytdTaxPaid);

    const items: DeductionItem[] = [
      { label: "养老保险 (Pension)", amount: pensionEmp, category: "social_insurance" },
      { label: "医疗保险 (Medical)", amount: medicalEmp, category: "social_insurance" },
      { label: "失业保险 (Unemployment)", amount: unemploymentEmp, category: "social_insurance" },
      { label: "住房公积金 (Housing Fund)", amount: housingEmp, category: "housing_fund" },
      { label: "个人所得税 (IIT)", amount: iit, category: "tax" },
    ];

    const totalEmployee = totalSocialEmp.plus(housingEmp).plus(iit);
    const totalEmployer = totalSocialEr.plus(housingEr);

    return { items, totalEmployee, totalEmployer };
  },
};
