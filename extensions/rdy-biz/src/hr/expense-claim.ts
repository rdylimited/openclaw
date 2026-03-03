import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createExpenseClaimTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "hr_expense_claim",
    label: "HR: Expense Claims",
    description:
      "Create, retrieve, update, list, submit, approve, reject, or reimburse employee expense claims.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("submit"),
          Type.Literal("approve"),
          Type.Literal("reject"),
          Type.Literal("reimburse"),
        ],
        { description: "Operation to perform" },
      ),
      claim_id: Type.Optional(
        Type.String({
          description:
            "Expense claim UUID (required for get/update/submit/approve/reject/reimburse)",
        }),
      ),
      employee_id: Type.Optional(
        Type.String({ description: "Employee UUID (required for create; filter for list)" }),
      ),
      date: Type.Optional(Type.String({ description: "Claim date (YYYY-MM-DD)" })),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            description: Type.String({ description: "Item description" }),
            amount: Type.String({ description: "Amount as decimal string" }),
            category: Type.String({
              description: "Expense category (e.g. travel, meals, supplies)",
            }),
            receipt_id: Type.Optional(
              Type.String({ description: "Optional receipt/attachment ID" }),
            ),
          }),
          { description: "List of expense line items" },
        ),
      ),
      total: Type.Optional(Type.String({ description: "Total claim amount as decimal string" })),
      status: Type.Optional(
        Type.String({
          description: "Status filter for list (draft, submitted, approved, rejected, reimbursed)",
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
          case "create": {
            const employee_id = params.employee_id as string | undefined;
            const date = params.date as string | undefined;
            const items = params.items as unknown[] | undefined;
            const total = params.total as string | undefined;

            if (!employee_id) return errorResult("employee_id is required for create");
            if (!date) return errorResult("date is required for create");
            if (!items || items.length === 0)
              return errorResult("items must be a non-empty array for create");
            if (!total) return errorResult("total is required for create");

            const payload = {
              tenant_id: db.tenantId,
              employee_id,
              date,
              items,
              total,
              status: "draft",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("expense_claims")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create expense claim: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { employee_id, date, total },
            });

            return jsonResult(data, `Expense claim created: ${total} on ${date}`);
          }

          case "get": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for get");

            const { data, error } = await db.client
              .from("expense_claims")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .single();

            if (error) return errorResult(`Expense claim not found: ${error.message}`);

            return jsonResult(data, `Expense claim: ${data.id} (${data.status})`);
          }

          case "update": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for update");

            // Only draft claims can be updated
            const { data: existing, error: fetchError } = await db.client
              .from("expense_claims")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .single();

            if (fetchError || !existing)
              return errorResult(`Expense claim not found: ${fetchError?.message}`);
            if (existing.status !== "draft") {
              return errorResult(
                `Only draft claims can be updated. Current status: '${existing.status}'`,
              );
            }

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.date !== undefined) updates.date = params.date;
            if (params.items !== undefined) updates.items = params.items;
            if (params.total !== undefined) updates.total = params.total;

            const { data, error } = await db.client
              .from("expense_claims")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update expense claim: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: claim_id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Expense claim updated: ${data.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const employee_id = params.employee_id as string | undefined;
            const status = params.status as string | undefined;

            let query = db.client
              .from("expense_claims")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (employee_id) query = query.eq("employee_id", employee_id);
            if (status) query = query.eq("status", status);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list expense claims: ${error.message}`);

            return jsonResult(
              { expense_claims: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} expense claims (page ${page})`,
            );
          }

          case "submit": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for submit");

            const { data, error } = await db.client
              .from("expense_claims")
              .update({ status: "submitted", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .eq("status", "draft")
              .select("id, employee_id, total, status")
              .single();

            if (error) return errorResult(`Failed to submit expense claim: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: claim_id,
              action: "update",
              actor: _id,
              payload: { status: "submitted" },
            });

            return jsonResult(data, `Expense claim submitted: ${data.total}`);
          }

          case "approve": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for approve");

            const { data, error } = await db.client
              .from("expense_claims")
              .update({ status: "approved", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .select("id, employee_id, total, status")
              .single();

            if (error) return errorResult(`Failed to approve expense claim: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: claim_id,
              action: "approve",
              actor: _id,
              payload: { status: "approved" },
            });

            return jsonResult(data, `Expense claim approved: ${data.total}`);
          }

          case "reject": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for reject");

            const { data, error } = await db.client
              .from("expense_claims")
              .update({ status: "rejected", updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .select("id, employee_id, total, status")
              .single();

            if (error) return errorResult(`Failed to reject expense claim: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: claim_id,
              action: "reject",
              actor: _id,
              payload: { status: "rejected" },
            });

            return jsonResult(data, `Expense claim rejected`);
          }

          case "reimburse": {
            const claim_id = params.claim_id as string | undefined;
            if (!claim_id) return errorResult("claim_id is required for reimburse");

            const { data, error } = await db.client
              .from("expense_claims")
              .update({
                status: "reimbursed",
                reimbursed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", claim_id)
              .select("id, employee_id, total, status")
              .single();

            if (error)
              return errorResult(`Failed to mark expense claim as reimbursed: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "expense_claim",
              entity_id: claim_id,
              action: "update",
              actor: _id,
              payload: { status: "reimbursed" },
            });

            return jsonResult(data, `Expense claim reimbursed: ${data.total}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, submit, approve, reject, reimburse`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
