import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createApprovalStatusTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "wf_approval_status",
    label: "Workflow: Approval Status",
    description:
      "Query approval records. Use 'get' to fetch a single approval with all its steps, " +
      "'list' to browse approvals filtered by document type or status, " +
      "or 'pending_for_me' to find approvals where the current step is waiting on a specific actor.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("get"), Type.Literal("list"), Type.Literal("pending_for_me")],
        { description: "Operation to perform" },
      ),
      approval_id: Type.Optional(Type.String({ description: "Approval UUID — required for get" })),
      actor_id: Type.Optional(
        Type.String({
          description: "User ID to check pending approvals for — required for pending_for_me",
        }),
      ),
      document_type: Type.Optional(
        Type.String({
          description: "Filter by document type (e.g. invoice, purchase_order) — used with list",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("pending"),
            Type.Literal("approved"),
            Type.Literal("rejected"),
            Type.Literal("changes_requested"),
          ],
          { description: "Filter by approval status — used with list" },
        ),
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
          case "get": {
            const approvalId = params.approval_id as string | undefined;
            if (!approvalId) return errorResult("approval_id is required for get");

            const { data: approval, error: approvalError } = await db.client
              .from("approvals")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", approvalId)
              .single();

            if (approvalError || !approval) {
              return errorResult(`Approval not found: ${approvalError?.message ?? approvalId}`);
            }

            const { data: steps, error: stepsError } = await db.client
              .from("approval_steps")
              .select("*")
              .eq("approval_id", approvalId)
              .order("step", { ascending: true });

            if (stepsError) {
              return errorResult(`Failed to fetch approval steps: ${stepsError.message}`);
            }

            return jsonResult(
              { ...approval, steps: steps ?? [] },
              `Approval ${approvalId} — status: ${approval.status}`,
            );
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const documentType = params.document_type as string | undefined;
            const status = params.status as string | undefined;

            let query = db.client
              .from("approvals")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (documentType) query = query.eq("document_type", documentType);
            if (status) query = query.eq("status", status);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list approvals: ${error.message}`);

            return jsonResult(
              { approvals: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} approvals (page ${page})`,
            );
          }

          case "pending_for_me": {
            const actorId = params.actor_id as string | undefined;
            if (!actorId) return errorResult("actor_id is required for pending_for_me");

            // Find approval_steps where action is 'pending' and approver_id matches actor
            const { data: pendingSteps, error: stepsError } = await db.client
              .from("approval_steps")
              .select("approval_id, step")
              .eq("approver_id", actorId)
              .eq("action", "pending");

            if (stepsError) {
              return errorResult(`Failed to query pending steps: ${stepsError.message}`);
            }

            if (!pendingSteps || pendingSteps.length === 0) {
              return jsonResult({ approvals: [], total: 0 }, `No pending approvals for ${actorId}`);
            }

            const approvalIds = pendingSteps.map((s: { approval_id: string }) => s.approval_id);

            // Fetch the parent approvals that are still in 'pending' status
            const { data: approvals, error: approvalsError } = await db.client
              .from("approvals")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("status", "pending")
              .in("id", approvalIds)
              .order("created_at", { ascending: true });

            if (approvalsError) {
              return errorResult(`Failed to fetch approvals: ${approvalsError.message}`);
            }

            return jsonResult(
              { approvals: approvals ?? [], total: approvals?.length ?? 0 },
              `Found ${approvals?.length ?? 0} approval(s) pending action from ${actorId}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: get, list, pending_for_me`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
