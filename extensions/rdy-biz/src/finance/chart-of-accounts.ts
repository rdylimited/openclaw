import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

export function createChartOfAccountsTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_chart_of_accounts",
    label: "Finance: Chart of Accounts",
    description:
      "Create, retrieve, update, list, or deactivate general ledger accounts. Supports hierarchical accounts via parent_id and filtering by account type.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("update"),
          Type.Literal("deactivate"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Account UUID (required for get/update/deactivate)" }),
      ),
      code: Type.Optional(Type.String({ description: "Account code (e.g. '1001')" })),
      name: Type.Optional(Type.String({ description: "Account name" })),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("asset"),
            Type.Literal("liability"),
            Type.Literal("equity"),
            Type.Literal("revenue"),
            Type.Literal("expense"),
          ],
          { description: "Account type (filter for list or value for create)" },
        ),
      ),
      parent_id: Type.Optional(
        Type.String({ description: "Parent account UUID for hierarchical accounts" }),
      ),
      description: Type.Optional(Type.String({ description: "Account description" })),
      page: Type.Optional(Type.Number({ minimum: 1, default: 1, description: "Page number" })),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 200, default: 50, description: "Items per page" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "create": {
            const code = params.code as string | undefined;
            const name = params.name as string | undefined;
            const type = params.type as AccountType | undefined;

            if (!code) return errorResult("code is required for create");
            if (!name) return errorResult("name is required for create");
            if (!type || !ACCOUNT_TYPES.includes(type)) {
              return errorResult(
                `type is required and must be one of: ${ACCOUNT_TYPES.join(", ")}`,
              );
            }

            const payload = {
              tenant_id: db.tenantId,
              code,
              name,
              type,
              parent_id: (params.parent_id as string | undefined) ?? null,
              description: (params.description as string | undefined) ?? null,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("chart_of_accounts")
              .insert(payload)
              .select("*, parent:chart_of_accounts!parent_id(code, name)")
              .single();

            if (error) return errorResult(`Failed to create account: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "chart_of_accounts",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { code, name, type },
            });

            return jsonResult(data, `Account created: ${data.code} — ${data.name}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("chart_of_accounts")
              .select("*, parent:chart_of_accounts!parent_id(code, name)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Account not found: ${error.message}`);

            return jsonResult(data, `Account: ${data.code} — ${data.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 50;
            const offset = (page - 1) * limit;
            const type = params.type as string | undefined;

            let query = db.client
              .from("chart_of_accounts")
              .select("*, parent:chart_of_accounts!parent_id(code, name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .eq("is_active", true)
              .order("code", { ascending: true })
              .range(offset, offset + limit - 1);

            if (type) query = query.eq("type", type);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list accounts: ${error.message}`);

            return jsonResult(
              { accounts: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} accounts (page ${page})`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.code !== undefined) updates.code = params.code;
            if (params.name !== undefined) updates.name = params.name;
            if (params.type !== undefined) updates.type = params.type;
            if (params.parent_id !== undefined) updates.parent_id = params.parent_id;
            if (params.description !== undefined) updates.description = params.description;

            const { data, error } = await db.client
              .from("chart_of_accounts")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, parent:chart_of_accounts!parent_id(code, name)")
              .single();

            if (error) return errorResult(`Failed to update account: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "chart_of_accounts",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Account updated: ${data.code} — ${data.name}`);
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data, error } = await db.client
              .from("chart_of_accounts")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("code, name")
              .single();

            if (error) return errorResult(`Failed to deactivate account: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "chart_of_accounts",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { deactivated: true },
            });

            return jsonResult(
              { id, deactivated: true },
              `Account deactivated: ${data.code} — ${data.name}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, update, deactivate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
