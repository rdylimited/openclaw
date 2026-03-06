import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

// Tables with foreign keys referencing contacts and the column name used
const FK_REFERENCES: Array<{ table: string; column: string }> = [
  { table: "contact_notes", column: "contact_id" },
  { table: "invoices", column: "customer_id" },
  { table: "bills", column: "supplier_id" },
  { table: "payments", column: "contact_id" },
  { table: "shipments", column: "contact_id" },
  { table: "reservations", column: "contact_id" },
];

export function createContactMergeTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "crm_contact_merge",
    label: "CRM: Merge Contacts",
    description:
      "Merge a secondary contact into a primary contact. Copies non-null fields from secondary where primary is null, re-points all foreign key references to the primary, then deactivates the secondary.",
    parameters: Type.Object({
      primary_id: Type.String({ description: "UUID of the contact to keep as the primary record" }),
      secondary_id: Type.String({
        description: "UUID of the contact to merge into primary and deactivate",
      }),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const primaryId = params.primary_id as string | undefined;
      const secondaryId = params.secondary_id as string | undefined;

      if (!primaryId) return errorResult("primary_id is required");
      if (!secondaryId) return errorResult("secondary_id is required");
      if (primaryId === secondaryId)
        return errorResult("primary_id and secondary_id must be different");

      try {
        // Fetch both contacts to validate and compute merge patch
        const [primaryRes, secondaryRes] = await Promise.all([
          db.client
            .from("contacts")
            .select("*")
            .eq("tenant_id", db.tenantId)
            .eq("id", primaryId)
            .single(),
          db.client
            .from("contacts")
            .select("*")
            .eq("tenant_id", db.tenantId)
            .eq("id", secondaryId)
            .single(),
        ]);

        if (primaryRes.error)
          return errorResult(`Primary contact not found: ${primaryRes.error.message}`);
        if (secondaryRes.error)
          return errorResult(`Secondary contact not found: ${secondaryRes.error.message}`);

        const primary = primaryRes.data as Record<string, unknown>;
        const secondary = secondaryRes.data as Record<string, unknown>;

        // Build update patch: copy non-null secondary fields where primary is null
        const MERGEABLE_FIELDS = ["email", "phone", "company_id", "notes", "tax_id", "address"];
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

        for (const field of MERGEABLE_FIELDS) {
          if (primary[field] === null || primary[field] === undefined) {
            if (secondary[field] !== null && secondary[field] !== undefined) {
              patch[field] = secondary[field];
            }
          }
        }

        // Apply patch to primary contact (immutable update — produces new DB row state)
        if (Object.keys(patch).length > 1) {
          const { error: patchError } = await db.client
            .from("contacts")
            .update(patch)
            .eq("tenant_id", db.tenantId)
            .eq("id", primaryId);

          if (patchError)
            return errorResult(`Failed to patch primary contact: ${patchError.message}`);
        }

        // Re-point all FK references from secondary to primary
        const reattachResults: Array<{ table: string; column: string; error?: string }> = [];

        for (const { table, column } of FK_REFERENCES) {
          const { error: fkError } = await db.client
            .from(table)
            .update({ [column]: primaryId })
            .eq("tenant_id", db.tenantId)
            .eq(column, secondaryId);

          if (fkError) {
            // Log but do not abort — partial success is recoverable via audit trail
            reattachResults.push({ table, column, error: fkError.message });
          } else {
            reattachResults.push({ table, column });
          }
        }

        const failedReattach = reattachResults.filter((r) => r.error);

        // Deactivate secondary contact
        const { error: deactivateError } = await db.client
          .from("contacts")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("tenant_id", db.tenantId)
          .eq("id", secondaryId);

        if (deactivateError) {
          return errorResult(
            `FK references updated but failed to deactivate secondary: ${deactivateError.message}`,
          );
        }

        await writeAuditLog(db, {
          entity_type: "contact",
          entity_id: primaryId,
          action: "update",
          actor: _id,
          payload: {
            merge_action: "contact_merge",
            merged_from: secondaryId,
            patch_applied: patch,
            fk_reattach: reattachResults,
          },
        });

        return jsonResult(
          {
            primary_id: primaryId,
            secondary_id: secondaryId,
            patch_applied: patch,
            fk_reattach: reattachResults,
            failed_reattach: failedReattach,
            secondary_deactivated: true,
          },
          failedReattach.length > 0
            ? `Merge complete with ${failedReattach.length} FK reattach warning(s)`
            : `Merge complete: secondary contact merged into primary and deactivated`,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
