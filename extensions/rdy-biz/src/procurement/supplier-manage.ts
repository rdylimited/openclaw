import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createSupplierManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_supplier_manage",
    label: "Procurement: Supplier Management",
    description:
      "Create, retrieve, update, list, or deactivate suppliers. Stores payment terms, lead times, and ratings linked to company records.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("deactivate"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Supplier UUID (required for get/update/deactivate)" }),
      ),
      company_id: Type.Optional(
        Type.String({ description: "Company UUID to link to this supplier" }),
      ),
      payment_terms: Type.Optional(
        Type.String({ description: "Payment terms (e.g. 'Net 30', 'COD')" }),
      ),
      rating: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 5,
          description: "Supplier rating from 1 (poor) to 5 (excellent)",
        }),
      ),
      lead_time_days: Type.Optional(
        Type.Number({ minimum: 0, description: "Typical lead time in days" }),
      ),
      notes: Type.Optional(Type.String({ description: "Internal notes about the supplier" })),
      active: Type.Optional(
        Type.Boolean({ description: "Filter active/inactive suppliers (for list)" }),
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
            const companyId = params.company_id as string | undefined;
            if (!companyId) return errorResult("company_id is required for create");

            const now = new Date().toISOString();
            const payload = {
              tenant_id: db.tenantId,
              company_id: companyId,
              payment_terms: (params.payment_terms as string | undefined) ?? null,
              rating: (params.rating as number | undefined) ?? null,
              lead_time_days: (params.lead_time_days as number | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              active: true,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("suppliers")
              .insert(payload)
              .select("*, company:companies(name)")
              .single();

            if (error) return errorResult(`Failed to create supplier: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "supplier",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { company_id: companyId },
            });

            return jsonResult(
              data,
              `Supplier created for company: ${data.company?.name ?? companyId}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("suppliers")
              .select("*, company:companies(name, email, phone)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Supplier not found: ${error.message}`);

            return jsonResult(data, `Supplier: ${data.company?.name ?? id}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.payment_terms !== undefined) updates.payment_terms = params.payment_terms;
            if (params.rating !== undefined) updates.rating = params.rating;
            if (params.lead_time_days !== undefined) updates.lead_time_days = params.lead_time_days;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("suppliers")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, company:companies(name)")
              .single();

            if (error) return errorResult(`Failed to update supplier: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "supplier",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Supplier updated: ${data.company?.name ?? id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const active = params.active as boolean | undefined;

            let query = db.client
              .from("suppliers")
              .select("*, company:companies(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (active !== undefined) query = query.eq("active", active);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list suppliers: ${error.message}`);

            return jsonResult(
              { suppliers: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} suppliers (page ${page})`,
            );
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data: existing, error: fetchError } = await db.client
              .from("suppliers")
              .select("active, company_id")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Supplier not found: ${fetchError.message}`);
            if (!existing.active) return errorResult("Supplier is already inactive");

            const { data, error } = await db.client
              .from("suppliers")
              .update({ active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, company:companies(name)")
              .single();

            if (error) return errorResult(`Failed to deactivate supplier: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "supplier",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: { active: false },
            });

            return jsonResult(data, `Supplier deactivated: ${data.company?.name ?? id}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, update, list, deactivate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
