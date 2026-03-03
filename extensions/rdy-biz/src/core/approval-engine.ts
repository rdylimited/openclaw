import { writeAuditLog } from "./audit.js";
import type { TenantClient } from "./supabase.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested";

export async function submitForApproval(
  db: TenantClient,
  params: {
    documentType: string;
    documentId: string;
    submittedBy: string;
    amount?: string;
  },
): Promise<{ approvalId: string; status: ApprovalStatus; autoApproved: boolean }> {
  // Check approval rules
  const { data: rules } = await db.client
    .from("approval_rules")
    .select("*")
    .eq("tenant_id", db.tenantId)
    .eq("document_type", params.documentType)
    .order("threshold_amount", { ascending: true });

  const matchingRule = rules?.find((r: any) => {
    if (!r.threshold_amount || !params.amount) return true;
    return parseFloat(params.amount) <= parseFloat(r.threshold_amount);
  });

  // Auto-approve if below threshold
  if (
    matchingRule?.auto_approve_below &&
    params.amount &&
    parseFloat(params.amount) < parseFloat(matchingRule.auto_approve_below)
  ) {
    const { data, error } = await db.client
      .from("approvals")
      .insert({
        tenant_id: db.tenantId,
        document_type: params.documentType,
        document_id: params.documentId,
        status: "approved",
        submitted_by: params.submittedBy,
        approver_chain: matchingRule.approver_chain ?? [],
        current_step: -1,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new Error(`Approval submit failed: ${error.message}`);

    await writeAuditLog(db, {
      entity_type: "approval",
      entity_id: data.id,
      action: "approve",
      actor: "system",
      payload: { reason: "auto_approved", amount: params.amount },
    });

    return { approvalId: data.id, status: "approved", autoApproved: true };
  }

  // Create pending approval
  const chain = matchingRule?.approver_chain ?? [];
  const { data, error } = await db.client
    .from("approvals")
    .insert({
      tenant_id: db.tenantId,
      document_type: params.documentType,
      document_id: params.documentId,
      status: "pending",
      submitted_by: params.submittedBy,
      approver_chain: chain,
      current_step: 0,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Approval submit failed: ${error.message}`);

  // Create first approval step
  if (chain.length > 0) {
    await db.client.from("approval_steps").insert({
      approval_id: data.id,
      step: 0,
      approver_id: chain[0],
      action: "pending",
      created_at: new Date().toISOString(),
    });
  }

  return { approvalId: data.id, status: "pending", autoApproved: false };
}

export async function processApprovalAction(
  db: TenantClient,
  params: {
    approvalId: string;
    action: "approve" | "reject" | "request_changes";
    actorId: string;
    comment?: string;
  },
): Promise<{ status: ApprovalStatus; complete: boolean }> {
  const { data: approval, error } = await db.client
    .from("approvals")
    .select("*")
    .eq("tenant_id", db.tenantId)
    .eq("id", params.approvalId)
    .single();
  if (error || !approval) throw new Error(`Approval not found: ${params.approvalId}`);
  if (approval.status !== "pending") throw new Error(`Approval is already ${approval.status}`);

  // Record the step action
  await db.client.from("approval_steps").insert({
    approval_id: params.approvalId,
    step: approval.current_step,
    approver_id: params.actorId,
    action: params.action,
    comment: params.comment,
    created_at: new Date().toISOString(),
  });

  if (params.action === "reject" || params.action === "request_changes") {
    const newStatus = params.action === "reject" ? "rejected" : "changes_requested";
    await db.client.from("approvals").update({ status: newStatus }).eq("id", params.approvalId);

    await writeAuditLog(db, {
      entity_type: "approval",
      entity_id: params.approvalId,
      action: "reject",
      actor: params.actorId,
      payload: { comment: params.comment },
    });

    return { status: newStatus, complete: true };
  }

  // Approve — check if more steps remain
  const nextStep = approval.current_step + 1;
  const chain = approval.approver_chain ?? [];

  if (nextStep < chain.length) {
    await db.client
      .from("approvals")
      .update({ current_step: nextStep })
      .eq("id", params.approvalId);

    await db.client.from("approval_steps").insert({
      approval_id: params.approvalId,
      step: nextStep,
      approver_id: chain[nextStep],
      action: "pending",
      created_at: new Date().toISOString(),
    });

    return { status: "pending", complete: false };
  }

  // Final approval
  await db.client
    .from("approvals")
    .update({ status: "approved", current_step: nextStep })
    .eq("id", params.approvalId);

  await writeAuditLog(db, {
    entity_type: "approval",
    entity_id: params.approvalId,
    action: "approve",
    actor: params.actorId,
  });

  return { status: "approved", complete: true };
}
