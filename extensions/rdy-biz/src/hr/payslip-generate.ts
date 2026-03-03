import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { formatMoney, money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, textResult, errorResult } from "../core/types.js";

type PayrollItem = {
  id: string;
  employee_id: string;
  gross: string;
  tax: string;
  net: string;
  currency: string;
  deductions: { mpf?: string; tax?: string } | null;
  employee?: {
    employee_number?: string;
    contact?: { name?: string } | null;
  } | null;
};

function renderPayslip(
  item: PayrollItem,
  periodStart: string,
  periodEnd: string,
  defaultCurrency: string,
): string {
  const currency = item.currency ?? defaultCurrency;
  const employeeName = item.employee?.contact?.name ?? "Unknown";
  const employeeNumber = item.employee?.employee_number ?? item.employee_id;
  const mpf = item.deductions?.mpf ?? "0";
  const tax = item.deductions?.tax ?? "0";

  const gross = money(item.gross ?? "0");
  const mpfAmount = money(mpf);
  const taxAmount = money(tax);
  const totalDeductions = mpfAmount.plus(taxAmount);
  const net = money(item.net ?? "0");

  const lines = [
    "=".repeat(52),
    "                     PAYSLIP",
    "=".repeat(52),
    `Employee : ${employeeName} (${employeeNumber})`,
    `Period   : ${periodStart} to ${periodEnd}`,
    "-".repeat(52),
    "EARNINGS",
    `  Basic Salary                   ${formatMoney(gross, currency).padStart(15)}`,
    "-".repeat(52),
    `  Gross Pay                       ${formatMoney(gross, currency).padStart(15)}`,
    "-".repeat(52),
    "DEDUCTIONS",
    `  MPF (Employee)                 ${formatMoney(mpfAmount, currency).padStart(15)}`,
    `  Estimated Salaries Tax         ${formatMoney(taxAmount, currency).padStart(15)}`,
    "-".repeat(52),
    `  Total Deductions                ${formatMoney(totalDeductions, currency).padStart(15)}`,
    "=".repeat(52),
    `  NET PAY                         ${formatMoney(net, currency).padStart(15)}`,
    "=".repeat(52),
  ];

  return lines.join("\n");
}

export function createPayslipGenerateTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_payslip_generate",
    label: "HR: Generate Payslips",
    description:
      "Generate text-based payslip summaries for a payroll run. Provide employee_id to generate for a single employee, or omit to generate for all.",
    parameters: Type.Object({
      payroll_run_id: Type.String({ description: "Payroll run UUID" }),
      employee_id: Type.Optional(
        Type.String({
          description: "Employee UUID — if omitted, generates for all employees in the run",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const payroll_run_id = params.payroll_run_id as string | undefined;
      const employee_id = params.employee_id as string | undefined;

      if (!payroll_run_id) return errorResult("payroll_run_id is required");

      try {
        // Fetch the payroll run for period info
        const { data: run, error: runError } = await db.client
          .from("payroll_runs")
          .select("period_start, period_end, status")
          .eq("tenant_id", db.tenantId)
          .eq("id", payroll_run_id)
          .single();

        if (runError) return errorResult(`Payroll run not found: ${runError.message}`);

        // Build items query with employee and contact details
        let itemsQuery = db.client
          .from("payroll_items")
          .select("*, employee:employees(employee_number, contact:contacts(name))")
          .eq("tenant_id", db.tenantId)
          .eq("payroll_run_id", payroll_run_id);

        if (employee_id) {
          itemsQuery = itemsQuery.eq("employee_id", employee_id);
        }

        const { data: items, error: itemsError } = await itemsQuery;

        if (itemsError) return errorResult(`Failed to fetch payroll items: ${itemsError.message}`);
        if (!items || items.length === 0) {
          return errorResult("No payroll items found for the specified run/employee");
        }

        const payslips = (items as PayrollItem[]).map((item) =>
          renderPayslip(item, run.period_start, run.period_end, config.defaultCurrency),
        );

        const header = `Payslips for period ${run.period_start} to ${run.period_end} (${items.length} employee${items.length !== 1 ? "s" : ""})\n`;
        const body = payslips.join("\n\n");

        return textResult(`${header}\n${body}`);
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
