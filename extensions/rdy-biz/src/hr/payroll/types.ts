import type Decimal from "decimal.js";
import type { TenantClient } from "../../core/supabase.js";

export type DeductionItem = {
  label: string;
  amount: Decimal;
  category: "social_insurance" | "housing_fund" | "tax" | "pension" | "other";
};

export type PayrollDeductions = {
  items: DeductionItem[];
  totalEmployee: Decimal;
  totalEmployer: Decimal;
};

export type PayrollStrategyContext = {
  db: TenantClient;
  grossSalary: Decimal;
  employeeId: string;
  contractId: string;
  periodStart: string;
  periodEnd: string;
  config: Record<string, unknown>;
};

export interface PayrollStrategy {
  jurisdiction: string;
  compute(ctx: PayrollStrategyContext): Promise<PayrollDeductions>;
}
