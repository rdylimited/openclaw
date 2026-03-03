import { Type } from "@sinclair/typebox";
import { submitForApproval } from "../core/approval-engine.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createApprovalSubmitTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "wf_approval_submit",
    label: "Workflow: Submit for Approval",
    description:
      "Submit a document (invoice, purchase order, expense claim, etc.) into the approval workflow. " +
      "Applies matching approval rules to determine the approver chain. " +
      "Documents below the auto-approve threshold are approved immediately.",
    parameters: Type.Object({
      document_type: Type.String({
        description:
          "Type of document being submitted (e.g. invoice, purchase_order, expense_claim)",
      }),
      document_id: Type.String({
        description: "UUID of the document to submit for approval",
      }),
      submitted_by: Type.String({
        description: "User ID or name of the person submitting the document",
      }),
      amount: Type.Optional(
        Type.String({
          description:
            "Document amount as a decimal string (e.g. '5000.00'). Used for threshold matching.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const documentType = params.document_type as string | undefined;
      const documentId = params.document_id as string | undefined;
      const submittedBy = params.submitted_by as string | undefined;
      const amount = params.amount as string | undefined;

      if (!documentType) return errorResult("document_type is required");
      if (!documentId) return errorResult("document_id is required");
      if (!submittedBy) return errorResult("submitted_by is required");

      try {
        const result = await submitForApproval(db, {
          documentType,
          documentId,
          submittedBy,
          amount,
        });

        const summary = result.autoApproved
          ? `Document auto-approved (approval ID: ${result.approvalId})`
          : `Document submitted for approval (approval ID: ${result.approvalId}, status: ${result.status})`;

        return jsonResult(
          {
            approvalId: result.approvalId,
            status: result.status,
            autoApproved: result.autoApproved,
          },
          summary,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
