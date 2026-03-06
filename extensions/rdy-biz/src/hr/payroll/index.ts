import { cnPayrollStrategy } from "./cn-payroll.js";
import { hkPayrollStrategy } from "./hk-payroll.js";
import type { PayrollStrategy } from "./types.js";

const strategies: Record<string, PayrollStrategy> = {
  HK: hkPayrollStrategy,
  CN: cnPayrollStrategy,
};

export function getPayrollStrategy(jurisdiction: string): PayrollStrategy {
  const strategy = strategies[jurisdiction.toUpperCase()];
  if (!strategy) {
    throw new Error(
      `Unsupported payroll jurisdiction: ${jurisdiction}. Supported: ${Object.keys(strategies).join(", ")}`,
    );
  }
  return strategy;
}

export type {
  PayrollStrategy,
  PayrollDeductions,
  PayrollStrategyContext,
  DeductionItem,
} from "./types.js";
