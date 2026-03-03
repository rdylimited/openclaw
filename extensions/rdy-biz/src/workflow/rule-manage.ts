import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createRuleManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "wf_rule_manage",
    label: "Workflow: Manage Approval Rules",
    description:
      "Create, retrieve, update, list, or delete approval rules. " +
      "Rules define which documents require approval, the approver chain, " +
      "auto-approve thresholds, and whether approvers act sequentially or in parallel.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("update"),
          Type.Literal("delete"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Rule UUID — required for get, update, delete" }),
      ),
      document_type: Type.Optional(
        Type.String({
          description:
            "Document type this rule applies to (e.g. invoice, purchase_order, expense_claim). Required for create.",
        }),
      ),
      threshold_amount: Type.Optional(
        Type.String({
          description:
            "Maximum document amount (decimal string) this rule applies to. " +
            "The lowest matching threshold is used when multiple rules exist for the same document type.",
        }),
      ),
      approver_chain: Type.Optional(
        Type.Array(Type.String(), {
          description: "Ordered list of approver user IDs. Required for create.",
        }),
      ),
      auto_approve_below: Type.Optional(
        Type.String({
          description:
            "Documents with an amount strictly below this decimal value are auto-approved without human review.",
        }),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("sequential"), Type.Literal("parallel")], {
          description:
            "sequential — approvers act one after another in chain order. " +
            "parallel — all approvers are notified simultaneously (first response wins). Default: sequential.",
        }),
      ),
      page: Type.Optional(
        Type.Number({ minimum: 1, default: 1, description: "Page number — used with list" }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Items per page — used with list",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "create": {
            const documentType = params.document_type as string | undefined;
            const approverChain = params.approver_chain as string[] | undefined;

            if (!documentType) return errorResult("document_type is required for create");
            if (!approverChain || approverChain.length === 0) {
              return errorResult(
                "approver_chain must be a non-empty array of approver IDs for create",
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              document_type: documentType,
              threshold_amount: (params.threshold_amount as string | undefined) ?? null,
              approver_chain: approverChain,
              auto_approve_below: (params.auto_approve_below as string | undefined) ?? null,
              mode: (params.mode as string | undefined) ?? "sequential",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("approval_rules")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create approval rule: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "approval_rule",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { document_type: documentType },
            });

            return jsonResult(data, `Approval rule created for document type: ${documentType}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("approval_rules")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error || !data) {
              return errorResult(`Approval rule not found: ${error?.message ?? id}`);
            }

            return jsonResult(data, `Approval rule: ${data.document_type}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const documentType = params.document_type as string | undefined;

            let query = db.client
              .from("approval_rules")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("document_type", { ascending: true })
              .order("threshold_amount", { ascending: true })
              .range(offset, offset + limit - 1);

            if (documentType) query = query.eq("document_type", documentType);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list approval rules: ${error.message}`);

            return jsonResult(
              { rules: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} approval rule(s) (page ${page})`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.document_type !== undefined) updates.document_type = params.document_type;
            if (params.threshold_amount !== undefined)
              updates.threshold_amount = params.threshold_amount;
            if (params.approver_chain !== undefined) updates.approver_chain = params.approver_chain;
            if (params.auto_approve_below !== undefined)
              updates.auto_approve_below = params.auto_approve_below;
            if (params.mode !== undefined) updates.mode = params.mode;

            const { data, error } = await db.client
              .from("approval_rules")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update approval rule: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "approval_rule",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Approval rule updated: ${data.document_type}`);
          }

          case "delete": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for delete");

            const { data: existing, error: fetchError } = await db.client
              .from("approval_rules")
              .select("document_type")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError || !existing) {
              return errorResult(`Approval rule not found: ${fetchError?.message ?? id}`);
            }

            const { error: deleteError } = await db.client
              .from("approval_rules")
              .delete()
              .eq("tenant_id", db.tenantId)
              .eq("id", id);

            if (deleteError)
              return errorResult(`Failed to delete approval rule: ${deleteError.message}`);

            await writeAuditLog(db, {
              entity_type: "approval_rule",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { document_type: existing.document_type },
            });

            return jsonResult(
              { id, deleted: true, document_type: existing.document_type },
              `Approval rule deleted for document type: ${existing.document_type}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, update, delete`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
