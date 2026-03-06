import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const CONTACT_TYPES = ["customer", "vendor", "employee"] as const;
type ContactType = (typeof CONTACT_TYPES)[number];

export function createContactManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "crm_contact_manage",
    label: "CRM: Manage Contacts",
    description:
      "Create, retrieve, update, list, or deactivate contacts (customers, vendors, employees) with tenant isolation.",
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
        Type.String({ description: "Contact UUID (required for get/update/deactivate)" }),
      ),
      name: Type.Optional(Type.String({ description: "Full name of the contact" })),
      type: Type.Optional(
        Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("employee")], {
          description: "Contact type filter or type for new contact",
        }),
      ),
      email: Type.Optional(Type.String({ description: "Email address" })),
      phone: Type.Optional(Type.String({ description: "Phone number" })),
      company_id: Type.Optional(Type.String({ description: "Associated company UUID" })),
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
            const type = params.type as ContactType | undefined;

            if (!name) return errorResult("name is required for create");
            if (!type || !CONTACT_TYPES.includes(type)) {
              return errorResult(
                `type is required and must be one of: ${CONTACT_TYPES.join(", ")}`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              name,
              type,
              email: (params.email as string | undefined) ?? null,
              phone: (params.phone as string | undefined) ?? null,
              company_id: (params.company_id as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("contacts")
              .insert(payload)
              .select("*, company:companies(name)")
              .single();

            if (error) return errorResult(`Failed to create contact: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "contact",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, type },
            });

            return jsonResult(data, `Contact created: ${data.name}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("contacts")
              .select("*, company:companies(name)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Contact not found: ${error.message}`);

            return jsonResult(data, `Contact: ${data.name}`);
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.name !== undefined) updates.name = params.name;
            if (params.type !== undefined) updates.type = params.type;
            if (params.email !== undefined) updates.email = params.email;
            if (params.phone !== undefined) updates.phone = params.phone;
            if (params.company_id !== undefined) updates.company_id = params.company_id;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("contacts")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, company:companies(name)")
              .single();

            if (error) return errorResult(`Failed to update contact: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "contact",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Contact updated: ${data.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const type = params.type as string | undefined;

            let query = db.client
              .from("contacts")
              .select("*, company:companies(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .eq("is_active", true)
              .order("name", { ascending: true })
              .range(offset, offset + limit - 1);

            if (type) query = query.eq("type", type);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list contacts: ${error.message}`);

            return jsonResult(
              { contacts: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} contacts (page ${page})`,
            );
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data, error } = await db.client
              .from("contacts")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("name")
              .single();

            if (error) return errorResult(`Failed to deactivate contact: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "contact",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { deactivated: true },
            });

            return jsonResult({ id, deactivated: true }, `Contact deactivated: ${data.name}`);
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
