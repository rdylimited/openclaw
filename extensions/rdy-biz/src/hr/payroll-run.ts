import { Type } from "@sinclair/typebox";
import Decimal from "decimal.js";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney, formatMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";
import { getPayrollStrategy } from "./payroll/index.js";

export function createPayrollRunTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_payroll_run",
    label: "HR: Payroll Run",
    description:
      "Create, calculate, approve, pay, get, or list payroll runs. Calculate computes gross, deductions, tax, and net for each active employee based on their contract jurisdiction (HK, CN, etc.).",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("calculate"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("approve"),
          Type.Literal("pay"),
        ],
        { description: "Operation to perform" },
      ),
      payroll_run_id: Type.Optional(
        Type.String({ description: "Payroll run UUID (required for calculate/get/approve/pay)" }),
      ),
      period_start: Type.Optional(
        Type.String({ description: "Pay period start date (YYYY-MM-DD), required for create" }),
      ),
      period_end: Type.Optional(
        Type.String({ description: "Pay period end date (YYYY-MM-DD), required for create" }),
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
            const period_start = params.period_start as string | undefined;
            const period_end = params.period_end as string | undefined;

            if (!period_start) return errorResult("period_start is required for create");
            if (!period_end) return errorResult("period_end is required for create");

            const payload = {
              tenant_id: db.tenantId,
              period_start,
              period_end,
              status: "draft",
              total_gross: "0",
              total_deductions: "0",
              total_tax: "0",
              total_net: "0",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("payroll_runs")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create payroll run: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "payroll_run",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { period_start, period_end },
            });

            return jsonResult(data, `Payroll run created: ${period_start} to ${period_end}`);
          }

          case "calculate": {
            const payroll_run_id = params.payroll_run_id as string | undefined;
            if (!payroll_run_id) return errorResult("payroll_run_id is required for calculate");

            const { data: runData, error: runError } = await db.client
              .from("payroll_runs")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", payroll_run_id)
              .single();

            if (runError) return errorResult(`Payroll run not found: ${runError.message}`);

            const { data: employees, error: empError } = await db.client
              .from("employees")
              .select("id, employee_number, contact:contacts(name)")
              .eq("tenant_id", db.tenantId)
              .eq("status", "active");

            if (empError) return errorResult(`Failed to fetch employees: ${empError.message}`);
            if (!employees || employees.length === 0) {
              return errorResult("No active employees found");
            }

            const today = runData.period_end;
            const itemsInserted: unknown[] = [];

            for (const emp of employees) {
              const { data: contracts, error: contractError } = await db.client
                .from("contracts")
                .select("*")
                .eq("tenant_id", db.tenantId)
                .eq("employee_id", emp.id)
                .eq("status", "active")
                .lte("start_date", today)
                .order("start_date", { ascending: false })
                .limit(1);

              if (contractError || !contracts || contracts.length === 0) continue;

              const contract = contracts[0];
              if (contract.end_date && contract.end_date < today) continue;

              const gross = money(contract.salary);
              const jurisdiction = (contract.jurisdiction as string) ?? config.taxJurisdiction;

              // Use strategy pattern for jurisdiction-specific deductions
              const strategy = getPayrollStrategy(jurisdiction);
              const deductions = await strategy.compute({
                db,
                grossSalary: gross,
                employeeId: emp.id,
                contractId: contract.id,
                periodStart: runData.period_start,
                periodEnd: runData.period_end,
                config: config as unknown as Record<string, unknown>,
              });

              const net = gross.minus(deductions.totalEmployee);

              // Build deductions object for JSONB storage
              const deductionsData: Record<string, string> = {};
              let taxAmount = new Decimal(0);
              for (const item of deductions.items) {
                deductionsData[item.label] = item.amount.toFixed(2);
                if (item.category === "tax") {
                  taxAmount = taxAmount.plus(item.amount);
                }
              }

              const itemPayload = {
                tenant_id: db.tenantId,
                payroll_run_id,
                employee_id: emp.id,
                contract_id: contract.id,
                gross: gross.toFixed(2),
                deductions: deductionsData,
                mpf_employer: deductions.totalEmployer.toFixed(2),
                tax: taxAmount.toFixed(2),
                net: net.toFixed(2),
                currency: contract.salary_currency ?? config.defaultCurrency,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };

              const { data: itemData, error: itemError } = await db.client
                .from("payroll_items")
                .insert(itemPayload)
                .select("*")
                .single();

              if (itemError)
                return errorResult(
                  `Failed to insert payroll item for employee ${emp.id}: ${itemError.message}`,
                );

              itemsInserted.push(itemData);
            }

            // Compute totals
            const { data: allItems, error: allItemsError } = await db.client
              .from("payroll_items")
              .select("gross, tax, net, deductions")
              .eq("tenant_id", db.tenantId)
              .eq("payroll_run_id", payroll_run_id);

            if (allItemsError)
              return errorResult(`Failed to fetch payroll items: ${allItemsError.message}`);

            const totalGross = sumMoney((allItems ?? []).map((i) => i.gross ?? "0"));
            const totalTax = sumMoney((allItems ?? []).map((i) => i.tax ?? "0"));
            const totalNet = sumMoney((allItems ?? []).map((i) => i.net ?? "0"));

            const totalDeductionsVal = (allItems ?? []).reduce((acc: Decimal, i) => {
              const deductionObj = i.deductions as Record<string, string> | null;
              if (!deductionObj) return acc;
              return Object.values(deductionObj).reduce((sum, val) => sum.plus(money(val)), acc);
            }, new Decimal(0));

            const runUpdates = {
              status: "calculated",
              total_gross: totalGross.toFixed(2),
              total_deductions: totalDeductionsVal.toFixed(2),
              total_tax: totalTax.toFixed(2),
              total_net: totalNet.toFixed(2),
              updated_at: new Date().toISOString(),
            };

            const { data: updatedRun, error: updateError } = await db.client
              .from("payroll_runs")
              .update(runUpdates)
              .eq("tenant_id", db.tenantId)
              .eq("id", payroll_run_id)
              .select("*")
              .single();

            if (updateError)
              return errorResult(`Failed to update payroll run totals: ${updateError.message}`);

            await writeAuditLog(db, {
              entity_type: "payroll_run",
              entity_id: payroll_run_id,
              action: "update",
              actor: _id,
              payload: {
                status: "calculated",
                employees_processed: itemsInserted.length,
                total_gross: totalGross.toFixed(2),
                total_net: totalNet.toFixed(2),
              },
            });

            return jsonResult(
              { payroll_run: updatedRun, items_processed: itemsInserted.length },
              `Payroll calculated: ${itemsInserted.length} employees, gross ${formatMoney(totalGross, config.defaultCurrency)}, net ${formatMoney(totalNet, config.defaultCurrency)}`,
            );
          }

          case "get": {
            const payroll_run_id = params.payroll_run_id as string | undefined;
            if (!payroll_run_id) return errorResult("payroll_run_id is required for get");

            const { data: run, error: runError } = await db.client
              .from("payroll_runs")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", payroll_run_id)
              .single();

            if (runError) return errorResult(`Payroll run not found: ${runError.message}`);

            const { data: items, error: itemsError } = await db.client
              .from("payroll_items")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("payroll_run_id", payroll_run_id);

            if (itemsError)
              return errorResult(`Failed to fetch payroll items: ${itemsError.message}`);

            return jsonResult(
              { run, items: items ?? [] },
              `Payroll run: ${run.period_start} to ${run.period_end} (${run.status})`,
            );
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;

            const { data, error, count } = await db.client
              .from("payroll_runs")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("period_start", { ascending: false })
              .range(offset, offset + limit - 1);

            if (error) return errorResult(`Failed to list payroll runs: ${error.message}`);

            return jsonResult(
              { payroll_runs: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} payroll runs (page ${page})`,
            );
          }

          case "approve": {
            const payroll_run_id = params.payroll_run_id as string | undefined;
            if (!payroll_run_id) return errorResult("payroll_run_id is required for approve");

            const { data, error } = await db.client
              .from("payroll_runs")
              .update({ status: "approved", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", payroll_run_id)
              .select("id, period_start, period_end, status")
              .single();

            if (error) return errorResult(`Failed to approve payroll run: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "payroll_run",
              entity_id: payroll_run_id,
              action: "approve",
              actor: _id,
              payload: { status: "approved" },
            });

            return jsonResult(
              data,
              `Payroll run approved: ${data.period_start} to ${data.period_end}`,
            );
          }

          case "pay": {
            const payroll_run_id = params.payroll_run_id as string | undefined;
            if (!payroll_run_id) return errorResult("payroll_run_id is required for pay");

            const { data, error } = await db.client
              .from("payroll_runs")
              .update({
                status: "paid",
                paid_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", payroll_run_id)
              .select("id, period_start, period_end, status")
              .single();

            if (error) return errorResult(`Failed to mark payroll run as paid: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "payroll_run",
              entity_id: payroll_run_id,
              action: "update",
              actor: _id,
              payload: { status: "paid" },
            });

            return jsonResult(
              data,
              `Payroll run marked as paid: ${data.period_start} to ${data.period_end}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, calculate, get, list, approve, pay`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
