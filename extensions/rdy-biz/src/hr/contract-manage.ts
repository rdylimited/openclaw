import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const CONTRACT_TYPES = ["permanent", "fixed_term", "part_time", "contractor"] as const;
const PAY_FREQUENCIES = ["weekly", "biweekly", "monthly"] as const;

export function createContractManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_contract_manage",
    label: "HR: Manage Contracts",
    description:
      "Create, retrieve, list, or terminate employee contracts including salary and pay frequency details.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("terminate"),
        ],
        { description: "Operation to perform" },
      ),
      contract_id: Type.Optional(
        Type.String({ description: "Contract UUID (required for get/terminate)" }),
      ),
      employee_id: Type.Optional(
        Type.String({ description: "Employee UUID (required for create; filter for list)" }),
      ),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("permanent"),
            Type.Literal("fixed_term"),
            Type.Literal("part_time"),
            Type.Literal("contractor"),
          ],
          { description: "Contract type" },
        ),
      ),
      start_date: Type.Optional(Type.String({ description: "Contract start date (YYYY-MM-DD)" })),
      end_date: Type.Optional(
        Type.String({ description: "Contract end date (YYYY-MM-DD), optional for permanent" }),
      ),
      salary: Type.Optional(Type.String({ description: "Salary amount as decimal string" })),
      salary_currency: Type.Optional(
        Type.String({ description: "ISO 4217 currency code (e.g. HKD)" }),
      ),
      pay_frequency: Type.Optional(
        Type.Union([Type.Literal("weekly"), Type.Literal("biweekly"), Type.Literal("monthly")], {
          description: "Pay frequency",
        }),
      ),
      terms: Type.Optional(Type.Unknown({ description: "Additional contract terms (JSONB)" })),
      status: Type.Optional(
        Type.String({ description: "Status filter for list (active, terminated)" }),
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
            const employee_id = params.employee_id as string | undefined;
            const type = params.type as string | undefined;
            const start_date = params.start_date as string | undefined;
            const salary = params.salary as string | undefined;
            const salary_currency = params.salary_currency as string | undefined;
            const pay_frequency = params.pay_frequency as string | undefined;

            if (!employee_id) return errorResult("employee_id is required for create");
            if (!type || !CONTRACT_TYPES.includes(type as (typeof CONTRACT_TYPES)[number])) {
              return errorResult(
                `type is required and must be one of: ${CONTRACT_TYPES.join(", ")}`,
              );
            }
            if (!start_date) return errorResult("start_date is required for create");
            if (!salary) return errorResult("salary is required for create");
            if (!salary_currency) return errorResult("salary_currency is required for create");
            if (
              !pay_frequency ||
              !PAY_FREQUENCIES.includes(pay_frequency as (typeof PAY_FREQUENCIES)[number])
            ) {
              return errorResult(
                `pay_frequency is required and must be one of: ${PAY_FREQUENCIES.join(", ")}`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              employee_id,
              type,
              start_date,
              end_date: (params.end_date as string | undefined) ?? null,
              salary,
              salary_currency,
              pay_frequency,
              terms: (params.terms as Record<string, unknown> | undefined) ?? null,
              status: "active",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("contracts")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create contract: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "contract",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { employee_id, type, start_date, salary_currency },
            });

            return jsonResult(data, `Contract created for employee ${employee_id}`);
          }

          case "get": {
            const contract_id = params.contract_id as string | undefined;
            if (!contract_id) return errorResult("contract_id is required for get");

            const { data, error } = await db.client
              .from("contracts")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", contract_id)
              .single();

            if (error) return errorResult(`Contract not found: ${error.message}`);

            return jsonResult(data, `Contract: ${data.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const employee_id = params.employee_id as string | undefined;
            const status = params.status as string | undefined;

            let query = db.client
              .from("contracts")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("start_date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (employee_id) query = query.eq("employee_id", employee_id);
            if (status) query = query.eq("status", status);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list contracts: ${error.message}`);

            return jsonResult(
              { contracts: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} contracts (page ${page})`,
            );
          }

          case "terminate": {
            const contract_id = params.contract_id as string | undefined;
            if (!contract_id) return errorResult("contract_id is required for terminate");

            const updates = {
              status: "terminated",
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("contracts")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", contract_id)
              .select("id, employee_id")
              .single();

            if (error) return errorResult(`Failed to terminate contract: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "contract",
              entity_id: contract_id,
              action: "update",
              actor: _id,
              payload: { status: "terminated" },
            });

            return jsonResult(
              { id: data.id, status: "terminated" },
              `Contract terminated for employee ${data.employee_id}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, terminate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
