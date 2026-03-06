import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const TAX_TYPES = ["GST", "VAT", "WHT", "income", "profits", "sales"] as const;
type TaxType = (typeof TAX_TYPES)[number];

export function createTaxRateManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "tax_rate_manage",
    label: "Tax: Manage Tax Rates",
    description:
      "Create, retrieve, update, list, or deactivate tax rates (GST, VAT, WHT, income, profits, sales) with jurisdiction and effective date support.",
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
        Type.String({ description: "Tax rate UUID (required for get/update/deactivate)" }),
      ),
      name: Type.Optional(Type.String({ description: "Descriptive name for the tax rate" })),
      type: Type.Optional(
        Type.Union(
          TAX_TYPES.map((t) => Type.Literal(t)) as [
            ReturnType<typeof Type.Literal>,
            ...ReturnType<typeof Type.Literal>[],
          ],
          { description: `Tax type: ${TAX_TYPES.join(", ")}` },
        ),
      ),
      rate: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 1,
          description: "Tax rate as decimal (e.g. 0.05 for 5%)",
        }),
      ),
      jurisdiction: Type.Optional(
        Type.String({ description: "Jurisdiction code (e.g. HK, US, GB)" }),
      ),
      effective_from: Type.Optional(
        Type.String({ format: "date", description: "Effective from date (YYYY-MM-DD)" }),
      ),
      effective_to: Type.Optional(
        Type.String({
          format: "date",
          description: "Effective to date (YYYY-MM-DD, null = indefinite)",
        }),
      ),
      active: Type.Optional(Type.Boolean({ description: "Filter by active status (list only)" })),
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
            const type = params.type as TaxType | undefined;
            const rate = params.rate as number | undefined;
            const jurisdiction = params.jurisdiction as string | undefined;
            const effective_from = params.effective_from as string | undefined;

            if (!name) return errorResult("name is required for create");
            if (!type || !TAX_TYPES.includes(type)) {
              return errorResult(`type is required and must be one of: ${TAX_TYPES.join(", ")}`);
            }
            if (rate === undefined || rate === null)
              return errorResult("rate is required for create");
            if (!jurisdiction) return errorResult("jurisdiction is required for create");
            if (!effective_from) return errorResult("effective_from is required for create");

            const payload = {
              tenant_id: db.tenantId,
              name,
              type,
              rate: String(rate),
              jurisdiction,
              effective_from,
              effective_to: (params.effective_to as string | undefined) ?? null,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("tax_rates")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create tax rate: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_rate",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, type, rate, jurisdiction },
            });

            return jsonResult(
              data,
              `Tax rate created: ${data.name} (${data.type} @ ${Number(data.rate) * 100}%)`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("tax_rates")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Tax rate not found: ${error.message}`);

            return jsonResult(
              data,
              `Tax rate: ${data.name} (${data.type} @ ${Number(data.rate) * 100}%)`,
            );
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const typeFilter = params.type as string | undefined;
            const jurisdictionFilter = params.jurisdiction as string | undefined;
            const activeFilter = params.active as boolean | undefined;

            let query = db.client
              .from("tax_rates")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("type", { ascending: true })
              .order("name", { ascending: true })
              .range(offset, offset + limit - 1);

            if (typeFilter) query = query.eq("type", typeFilter);
            if (jurisdictionFilter) query = query.eq("jurisdiction", jurisdictionFilter);
            if (activeFilter !== undefined) query = query.eq("is_active", activeFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list tax rates: ${error.message}`);

            return jsonResult(
              { tax_rates: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} tax rates (page ${page})`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.name !== undefined) updates.name = params.name;
            if (params.type !== undefined) updates.type = params.type;
            if (params.rate !== undefined) updates.rate = String(params.rate);
            if (params.jurisdiction !== undefined) updates.jurisdiction = params.jurisdiction;
            if (params.effective_from !== undefined) updates.effective_from = params.effective_from;
            if (params.effective_to !== undefined) updates.effective_to = params.effective_to;

            const { data, error } = await db.client
              .from("tax_rates")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update tax rate: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_rate",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Tax rate updated: ${data.name}`);
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data, error } = await db.client
              .from("tax_rates")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("name")
              .single();

            if (error) return errorResult(`Failed to deactivate tax rate: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "tax_rate",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { deactivated: true },
            });

            return jsonResult({ id, deactivated: true }, `Tax rate deactivated: ${data.name}`);
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
