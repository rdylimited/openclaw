import type { TenantClient } from "./supabase.js";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "approve"
  | "reject"
  | "void"
  | "post"
  | "reverse";

export type AuditEntry = {
  entity_type: string;
  entity_id: string;
  action: AuditAction;
  actor: string;
  payload?: Record<string, unknown>;
};

export async function writeAuditLog(db: TenantClient, entry: AuditEntry): Promise<void> {
  const { error } = await db.client.from("audit_log").insert({
    tenant_id: db.tenantId,
    ...entry,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Audit log write failed: ${error.message}`);
}

export async function getAuditTrail(
  db: TenantClient,
  entityType: string,
  entityId: string,
): Promise<AuditEntry[]> {
  const { data, error } = await db.client
    .from("audit_log")
    .select("*")
    .eq("tenant_id", db.tenantId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Audit trail read failed: ${error.message}`);
  return data ?? [];
}
