import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createEmployeeManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_employee_manage",
    label: "HR: Manage Employees",
    description:
      "Create, retrieve, update, list, or terminate employees with department and contact linking.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("terminate"),
        ],
        { description: "Operation to perform" },
      ),
      employee_id: Type.Optional(
        Type.String({ description: "Employee UUID (required for get/update/terminate)" }),
      ),
      contact_id: Type.Optional(Type.String({ description: "Contact UUID to link to employee" })),
      employee_number: Type.Optional(Type.String({ description: "Unique employee number" })),
      department_id: Type.Optional(Type.String({ description: "Department UUID" })),
      position: Type.Optional(Type.String({ description: "Job position / title" })),
      hire_date: Type.Optional(Type.String({ description: "Hire date (YYYY-MM-DD)" })),
      termination_date: Type.Optional(
        Type.String({ description: "Termination date (YYYY-MM-DD)" }),
      ),
      status: Type.Optional(
        Type.String({ description: "Employee status filter (active, terminated)" }),
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
            const employee_number = params.employee_number as string | undefined;
            const position = params.position as string | undefined;
            const hire_date = params.hire_date as string | undefined;

            if (!employee_number) return errorResult("employee_number is required for create");
            if (!position) return errorResult("position is required for create");
            if (!hire_date) return errorResult("hire_date is required for create");

            const payload = {
              tenant_id: db.tenantId,
              contact_id: (params.contact_id as string | undefined) ?? null,
              employee_number,
              department_id: (params.department_id as string | undefined) ?? null,
              position,
              hire_date,
              status: "active",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("employees")
              .insert(payload)
              .select("*, department:departments(name), contact:contacts(name, email, phone)")
              .single();

            if (error) return errorResult(`Failed to create employee: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "employee",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { employee_number, position, hire_date },
            });

            return jsonResult(data, `Employee created: ${data.employee_number}`);
          }

          case "get": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for get");

            const { data, error } = await db.client
              .from("employees")
              .select("*, department:departments(name), contact:contacts(name, email, phone)")
              .eq("tenant_id", db.tenantId)
              .eq("id", employee_id)
              .single();

            if (error) return errorResult(`Employee not found: ${error.message}`);

            return jsonResult(data, `Employee: ${data.employee_number}`);
          }

          case "update": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.contact_id !== undefined) updates.contact_id = params.contact_id;
            if (params.employee_number !== undefined)
              updates.employee_number = params.employee_number;
            if (params.department_id !== undefined) updates.department_id = params.department_id;
            if (params.position !== undefined) updates.position = params.position;
            if (params.hire_date !== undefined) updates.hire_date = params.hire_date;
            if (params.status !== undefined) updates.status = params.status;

            const { data, error } = await db.client
              .from("employees")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", employee_id)
              .select("*, department:departments(name), contact:contacts(name, email, phone)")
              .single();

            if (error) return errorResult(`Failed to update employee: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "employee",
              entity_id: employee_id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Employee updated: ${data.employee_number}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const department_id = params.department_id as string | undefined;
            const status = params.status as string | undefined;

            let query = db.client
              .from("employees")
              .select("*, department:departments(name), contact:contacts(name, email, phone)", {
                count: "exact",
              })
              .eq("tenant_id", db.tenantId)
              .order("employee_number", { ascending: true })
              .range(offset, offset + limit - 1);

            if (department_id) query = query.eq("department_id", department_id);
            if (status) query = query.eq("status", status);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list employees: ${error.message}`);

            return jsonResult(
              { employees: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} employees (page ${page})`,
            );
          }

          case "terminate": {
            const employee_id = params.employee_id as string | undefined;
            const termination_date = params.termination_date as string | undefined;

            if (!employee_id) return errorResult("employee_id is required for terminate");
            if (!termination_date) return errorResult("termination_date is required for terminate");

            const updates = {
              status: "terminated",
              termination_date,
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("employees")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", employee_id)
              .select("employee_number")
              .single();

            if (error) return errorResult(`Failed to terminate employee: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "employee",
              entity_id: employee_id,
              action: "update",
              actor: _id,
              payload: { status: "terminated", termination_date },
            });

            return jsonResult(
              { id: employee_id, status: "terminated", termination_date },
              `Employee terminated: ${data.employee_number}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, terminate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
