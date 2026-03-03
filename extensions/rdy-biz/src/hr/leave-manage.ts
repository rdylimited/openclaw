import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createLeaveManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_leave_manage",
    label: "HR: Manage Leave",
    description:
      "Request, approve, reject, or cancel leave requests, and query leave balances for employees.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("request"),
          Type.Literal("approve"),
          Type.Literal("reject"),
          Type.Literal("cancel"),
          Type.Literal("get_balance"),
          Type.Literal("list"),
        ],
        { description: "Operation to perform" },
      ),
      request_id: Type.Optional(
        Type.String({ description: "Leave request UUID (required for approve/reject/cancel)" }),
      ),
      employee_id: Type.Optional(
        Type.String({
          description: "Employee UUID (required for request/get_balance; filter for list)",
        }),
      ),
      leave_type: Type.Optional(
        Type.String({ description: "Leave type (e.g. annual, sick, maternity)" }),
      ),
      start_date: Type.Optional(Type.String({ description: "Leave start date (YYYY-MM-DD)" })),
      end_date: Type.Optional(Type.String({ description: "Leave end date (YYYY-MM-DD)" })),
      days: Type.Optional(
        Type.Number({ minimum: 0.5, description: "Number of leave days requested" }),
      ),
      notes: Type.Optional(Type.String({ description: "Additional notes for the request" })),
      year: Type.Optional(
        Type.Number({ description: "Year for get_balance (defaults to current year)" }),
      ),
      status: Type.Optional(
        Type.String({
          description: "Status filter for list (pending, approved, rejected, cancelled)",
        }),
      ),
      date_from: Type.Optional(
        Type.String({ description: "Filter list: start date from (YYYY-MM-DD)" }),
      ),
      date_to: Type.Optional(
        Type.String({ description: "Filter list: start date to (YYYY-MM-DD)" }),
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
          case "request": {
            const employee_id = params.employee_id as string | undefined;
            const leave_type = params.leave_type as string | undefined;
            const start_date = params.start_date as string | undefined;
            const end_date = params.end_date as string | undefined;
            const days = params.days as number | undefined;

            if (!employee_id) return errorResult("employee_id is required for request");
            if (!leave_type) return errorResult("leave_type is required for request");
            if (!start_date) return errorResult("start_date is required for request");
            if (!end_date) return errorResult("end_date is required for request");
            if (!days || days <= 0)
              return errorResult("days must be a positive number for request");

            // Check leave balance
            const year = new Date(start_date).getFullYear();

            const { data: balance, error: balanceError } = await db.client
              .from("leave_balances")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .eq("leave_type", leave_type)
              .eq("year", year)
              .single();

            if (balanceError || !balance) {
              return errorResult(
                `No leave balance found for employee ${employee_id}, type '${leave_type}', year ${year}`,
              );
            }

            if (balance.remaining < days) {
              return errorResult(
                `Insufficient leave balance. Requested: ${days} days, Available: ${balance.remaining} days`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              employee_id,
              leave_type,
              start_date,
              end_date,
              days,
              notes: (params.notes as string | undefined) ?? null,
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("leave_requests")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create leave request: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "leave_request",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { employee_id, leave_type, start_date, end_date, days },
            });

            return jsonResult(
              data,
              `Leave request created: ${days} days of ${leave_type} from ${start_date}`,
            );
          }

          case "approve": {
            const request_id = params.request_id as string | undefined;
            if (!request_id) return errorResult("request_id is required for approve");

            // Fetch the request to get employee, type, days, year
            const { data: req, error: reqError } = await db.client
              .from("leave_requests")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .single();

            if (reqError || !req)
              return errorResult(`Leave request not found: ${reqError?.message}`);
            if (req.status !== "pending") {
              return errorResult(`Cannot approve a request with status '${req.status}'`);
            }

            // Update the request status
            const { data: updated, error: updateError } = await db.client
              .from("leave_requests")
              .update({ status: "approved", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .select("*")
              .single();

            if (updateError)
              return errorResult(`Failed to approve leave request: ${updateError.message}`);

            // Decrement remaining balance and increment used
            const year = new Date(req.start_date).getFullYear();
            const { error: balanceError } = await db.client.rpc("decrement_leave_balance", {
              p_tenant_id: db.tenantId,
              p_employee_id: req.employee_id,
              p_leave_type: req.leave_type,
              p_year: year,
              p_days: req.days,
            });

            // Fallback: manual update if RPC not available
            if (balanceError) {
              const { data: bal } = await db.client
                .from("leave_balances")
                .select("remaining, used")
                .eq("tenant_id", db.tenantId)
                .eq("employee_id", req.employee_id)
                .eq("leave_type", req.leave_type)
                .eq("year", year)
                .single();

              if (bal) {
                await db.client
                  .from("leave_balances")
                  .update({
                    remaining: bal.remaining - req.days,
                    used: bal.used + req.days,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("tenant_id", db.tenantId)
                  .eq("employee_id", req.employee_id)
                  .eq("leave_type", req.leave_type)
                  .eq("year", year);
              }
            }

            await writeAuditLog(db, {
              entity_type: "leave_request",
              entity_id: request_id,
              action: "approve",
              actor: _id,
              payload: { employee_id: req.employee_id, days: req.days },
            });

            return jsonResult(
              updated,
              `Leave request approved: ${req.days} days of ${req.leave_type}`,
            );
          }

          case "reject": {
            const request_id = params.request_id as string | undefined;
            if (!request_id) return errorResult("request_id is required for reject");

            const { data: req, error: reqError } = await db.client
              .from("leave_requests")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .single();

            if (reqError || !req)
              return errorResult(`Leave request not found: ${reqError?.message}`);
            if (req.status !== "pending") {
              return errorResult(`Cannot reject a request with status '${req.status}'`);
            }

            const { data, error } = await db.client
              .from("leave_requests")
              .update({ status: "rejected", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .select("id, employee_id, leave_type, days, status")
              .single();

            if (error) return errorResult(`Failed to reject leave request: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "leave_request",
              entity_id: request_id,
              action: "reject",
              actor: _id,
              payload: {},
            });

            return jsonResult(data, `Leave request rejected`);
          }

          case "cancel": {
            const request_id = params.request_id as string | undefined;
            if (!request_id) return errorResult("request_id is required for cancel");

            const { data: req, error: reqError } = await db.client
              .from("leave_requests")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .single();

            if (reqError || !req)
              return errorResult(`Leave request not found: ${reqError?.message}`);
            if (req.status === "cancelled") return errorResult("Request is already cancelled");

            const wasApproved = req.status === "approved";

            const { data, error } = await db.client
              .from("leave_requests")
              .update({ status: "cancelled", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", request_id)
              .select("id, employee_id, leave_type, days, status")
              .single();

            if (error) return errorResult(`Failed to cancel leave request: ${error.message}`);

            // Restore balance if it was previously approved
            if (wasApproved) {
              const year = new Date(req.start_date).getFullYear();
              const { data: bal } = await db.client
                .from("leave_balances")
                .select("remaining, used")
                .eq("tenant_id", db.tenantId)
                .eq("employee_id", req.employee_id)
                .eq("leave_type", req.leave_type)
                .eq("year", year)
                .single();

              if (bal) {
                await db.client
                  .from("leave_balances")
                  .update({
                    remaining: bal.remaining + req.days,
                    used: Math.max(0, bal.used - req.days),
                    updated_at: new Date().toISOString(),
                  })
                  .eq("tenant_id", db.tenantId)
                  .eq("employee_id", req.employee_id)
                  .eq("leave_type", req.leave_type)
                  .eq("year", year);
              }
            }

            await writeAuditLog(db, {
              entity_type: "leave_request",
              entity_id: request_id,
              action: "void",
              actor: _id,
              payload: { balance_restored: wasApproved },
            });

            return jsonResult(
              data,
              `Leave request cancelled${wasApproved ? " (balance restored)" : ""}`,
            );
          }

          case "get_balance": {
            const employee_id = params.employee_id as string | undefined;
            if (!employee_id) return errorResult("employee_id is required for get_balance");

            const year = (params.year as number | undefined) ?? new Date().getFullYear();

            const { data, error } = await db.client
              .from("leave_balances")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("employee_id", employee_id)
              .eq("year", year)
              .order("leave_type", { ascending: true });

            if (error) return errorResult(`Failed to fetch leave balances: ${error.message}`);

            return jsonResult(
              { employee_id, year, balances: data ?? [] },
              `Leave balances for employee ${employee_id} (${year}): ${(data ?? []).length} types`,
            );
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const employee_id = params.employee_id as string | undefined;
            const status = params.status as string | undefined;
            const date_from = params.date_from as string | undefined;
            const date_to = params.date_to as string | undefined;

            let query = db.client
              .from("leave_requests")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("start_date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (employee_id) query = query.eq("employee_id", employee_id);
            if (status) query = query.eq("status", status);
            if (date_from) query = query.gte("start_date", date_from);
            if (date_to) query = query.lte("start_date", date_to);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list leave requests: ${error.message}`);

            return jsonResult(
              { leave_requests: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} leave requests (page ${page})`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: request, approve, reject, cancel, get_balance, list`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
