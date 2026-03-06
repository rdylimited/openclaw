import Decimal from "decimal.js";
import type { PayrollStrategy, PayrollStrategyContext, PayrollDeductions } from "./types.js";

const MPF_RATE = new Decimal("0.05");
const MPF_CAP = new Decimal("1500");
const HK_BASIC_ALLOWANCE = new Decimal("132000");

function calcMpfContribution(monthlyGross: Decimal): Decimal {
  return Decimal.min(monthlyGross.mul(MPF_RATE), MPF_CAP);
}

function calcEstimatedMonthlyTax(monthlyGross: Decimal, profitsTaxRate: number): Decimal {
  const annualSalary = monthlyGross.mul(12);
  const taxable = annualSalary.minus(HK_BASIC_ALLOWANCE);
  if (taxable.lte(0)) return new Decimal(0);
  return Decimal.max(new Decimal(0), taxable.mul(new Decimal(profitsTaxRate)).div(12));
}

export const hkPayrollStrategy: PayrollStrategy = {
  jurisdiction: "HK",

  async compute(ctx: PayrollStrategyContext): Promise<PayrollDeductions> {
    const profitsTaxRate = (ctx.config.profitsTaxRate as number) ?? 0.165;
    const mpfEmployee = calcMpfContribution(ctx.grossSalary);
    const mpfEmployer = calcMpfContribution(ctx.grossSalary);
    const estimatedTax = calcEstimatedMonthlyTax(ctx.grossSalary, profitsTaxRate);

    return {
      items: [
        { label: "MPF (Employee)", amount: mpfEmployee, category: "pension" },
        { label: "Estimated Salaries Tax", amount: estimatedTax, category: "tax" },
      ],
      totalEmployee: mpfEmployee.plus(estimatedTax),
      totalEmployer: mpfEmployer,
    };
  },
};
