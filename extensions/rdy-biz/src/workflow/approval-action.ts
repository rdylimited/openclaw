import { Type } from "@sinclair/typebox";
import { processApprovalAction } from "../core/approval-engine.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const VALID_ACTIONS = ["approve", "reject", "request_changes"] as const;
type ApprovalAction = (typeof VALID_ACTIONS)[number];

export function createApprovalActionTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "wf_approval_action",
    label: "Workflow: Take Approval Action",
    description:
      "Approve, reject, or request changes on a pending approval. " +
      "Advances the approval chain to the next step when approved, or finalises the approval when the last step is reached. " +
      "Rejection or change requests immediately close the approval.",
    parameters: Type.Object({
      approval_id: Type.String({
        description: "UUID of the approval record to act on",
      }),
      action: Type.Union(
        [Type.Literal("approve"), Type.Literal("reject"), Type.Literal("request_changes")],
        { description: "Action to take on the approval" },
      ),
      actor_id: Type.String({
        description: "User ID of the person taking the action",
      }),
      comment: Type.Optional(
        Type.String({
          description:
            "Optional comment explaining the decision (recommended for rejections and change requests)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const approvalId = params.approval_id as string | undefined;
      const action = params.action as ApprovalAction | undefined;
      const actorId = params.actor_id as string | undefined;
      const comment = params.comment as string | undefined;

      if (!approvalId) return errorResult("approval_id is required");
      if (!action || !VALID_ACTIONS.includes(action)) {
        return errorResult(`action is required and must be one of: ${VALID_ACTIONS.join(", ")}`);
      }
      if (!actorId) return errorResult("actor_id is required");

      try {
        const result = await processApprovalAction(db, {
          approvalId,
          action,
          actorId,
          comment,
        });

        const summary = result.complete
          ? `Approval ${result.status} and complete (approval ID: ${approvalId})`
          : `Approval step recorded — awaiting next approver (approval ID: ${approvalId})`;

        return jsonResult(
          {
            status: result.status,
            complete: result.complete,
          },
          summary,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
