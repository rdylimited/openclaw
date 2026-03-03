import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const COMPANY_TYPES = ["customer", "vendor", "both"] as const;
type CompanyType = (typeof COMPANY_TYPES)[number];

export function createCompanyManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "crm_company_manage",
    label: "CRM: Manage Companies",
    description:
      "Create, retrieve, update, list, or deactivate companies (customers, vendors, or both) with tenant isolation.",
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
        Type.String({ description: "Company UUID (required for get/update/deactivate)" }),
      ),
      name: Type.Optional(Type.String({ description: "Company name" })),
      type: Type.Optional(
        Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("both")], {
          description: "Company type",
        }),
      ),
      tax_id: Type.Optional(Type.String({ description: "Tax identification number" })),
      address: Type.Optional(
        Type.Object(
          {
            line1: Type.Optional(Type.String()),
            line2: Type.Optional(Type.String()),
            city: Type.Optional(Type.String()),
            state: Type.Optional(Type.String()),
            postal_code: Type.Optional(Type.String()),
            country: Type.Optional(Type.String()),
          },
          { description: "Mailing address (stored as JSONB)" },
        ),
      ),
      phone: Type.Optional(Type.String({ description: "Main phone number" })),
      email: Type.Optional(Type.String({ description: "Main email address" })),
      website: Type.Optional(Type.String({ description: "Website URL" })),
      notes: Type.Optional(Type.String({ description: "Free-form notes" })),
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
            const name = params.name as string | undefined;
            const type = params.type as CompanyType | undefined;

            if (!name) return errorResult("name is required for create");
            if (!type || !COMPANY_TYPES.includes(type)) {
              return errorResult(
                `type is required and must be one of: ${COMPANY_TYPES.join(", ")}`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              name,
              type,
              tax_id: (params.tax_id as string | undefined) ?? null,
              address: (params.address as Record<string, unknown> | undefined) ?? null,
              phone: (params.phone as string | undefined) ?? null,
              email: (params.email as string | undefined) ?? null,
              website: (params.website as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("companies")
              .insert(payload)
              .select()
              .single();

            if (error) return errorResult(`Failed to create company: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "company",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, type },
            });

            return jsonResult(data, `Company created: ${data.name}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("companies")
              .select()
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Company not found: ${error.message}`);

            return jsonResult(data, `Company: ${data.name}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.name !== undefined) updates.name = params.name;
            if (params.type !== undefined) updates.type = params.type;
            if (params.tax_id !== undefined) updates.tax_id = params.tax_id;
            if (params.address !== undefined) updates.address = params.address;
            if (params.phone !== undefined) updates.phone = params.phone;
            if (params.email !== undefined) updates.email = params.email;
            if (params.website !== undefined) updates.website = params.website;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("companies")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select()
              .single();

            if (error) return errorResult(`Failed to update company: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "company",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Company updated: ${data.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const type = params.type as string | undefined;

            let query = db.client
              .from("companies")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .eq("is_active", true)
              .order("name", { ascending: true })
              .range(offset, offset + limit - 1);

            if (type) query = query.eq("type", type);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list companies: ${error.message}`);

            return jsonResult(
              { companies: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} companies (page ${page})`,
            );
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data, error } = await db.client
              .from("companies")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("name")
              .single();

            if (error) return errorResult(`Failed to deactivate company: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "company",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { deactivated: true },
            });

            return jsonResult({ id, deactivated: true }, `Company deactivated: ${data.name}`);
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
