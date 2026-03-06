import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createSupplierQuoteTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_supplier_quote",
    label: "Procurement: Supplier Quotations",
    description:
      "Create, retrieve, list, or compare supplier quotations. Supports side-by-side comparison of multiple quotes for the same items.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("compare"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(Type.String({ description: "Quotation UUID (required for get)" })),
      supplier_id: Type.Optional(Type.String({ description: "Supplier UUID" })),
      items: Type.Optional(
        Type.Array(
          Type.Object({
            item_id: Type.Optional(Type.String({ description: "Inventory item UUID" })),
            description: Type.String({ description: "Item description" }),
            quantity: Type.String({ description: "Requested quantity as decimal string" }),
            unit_price: Type.String({ description: "Quoted unit price as decimal string" }),
            currency: Type.Optional(
              Type.String({ minLength: 3, maxLength: 3, description: "Line item currency" }),
            ),
          }),
          { description: "Quoted items (JSONB array)" },
        ),
      ),
      valid_until: Type.Optional(Type.String({ description: "Quote validity date (YYYY-MM-DD)" })),
      total: Type.Optional(Type.String({ description: "Total quoted amount as decimal string" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      notes: Type.Optional(Type.String({ description: "Notes on the quotation" })),
      quote_ids: Type.Optional(
        Type.Array(Type.String(), {
          description: "Array of quotation UUIDs to compare (for compare action)",
        }),
      ),
      supplier_id_filter: Type.Optional(
        Type.String({ description: "Filter by supplier UUID (for list)" }),
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
            const supplierId = params.supplier_id as string | undefined;
            const items = params.items as unknown[] | undefined;
            const total = params.total as string | undefined;

            if (!supplierId) return errorResult("supplier_id is required for create");
            if (!items || items.length === 0)
              return errorResult("items is required and must not be empty");
            if (!total) return errorResult("total is required for create");

            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;
            const now = new Date().toISOString();

            const payload = {
              tenant_id: db.tenantId,
              supplier_id: supplierId,
              items,
              valid_until: (params.valid_until as string | undefined) ?? null,
              total,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("supplier_quotations")
              .insert(payload)
              .select("*, supplier:suppliers(id, company:companies(name))")
              .single();

            if (error) return errorResult(`Failed to create supplier quotation: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "supplier_quotation",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { supplier_id: supplierId, total, currency },
            });

            return jsonResult(data, `Supplier quotation created — ${currency} ${total}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("supplier_quotations")
              .select("*, supplier:suppliers(id, company:companies(name))")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Supplier quotation not found: ${error.message}`);

            return jsonResult(data, `Supplier quotation: ${data.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const supplierIdFilter = params.supplier_id_filter as string | undefined;

            let query = db.client
              .from("supplier_quotations")
              .select("*, supplier:suppliers(id, company:companies(name))", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (supplierIdFilter) query = query.eq("supplier_id", supplierIdFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list supplier quotations: ${error.message}`);

            return jsonResult(
              { quotations: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} supplier quotations (page ${page})`,
            );
          }

          case "compare": {
            const quoteIds = params.quote_ids as string[] | undefined;
            if (!quoteIds || quoteIds.length < 2) {
              return errorResult(
                "quote_ids is required and must contain at least 2 UUIDs for compare",
              );
            }

            const { data, error } = await db.client
              .from("supplier_quotations")
              .select("*, supplier:suppliers(id, company:companies(name))")
              .eq("tenant_id", db.tenantId)
              .in("id", quoteIds);

            if (error)
              return errorResult(`Failed to fetch quotations for comparison: ${error.message}`);
            if (!data || data.length === 0)
              return errorResult("No quotations found for provided IDs");

            const comparison = data.map((q) => ({
              quote_id: q.id,
              supplier_name:
                (q.supplier as { company?: { name?: string } } | null)?.company?.name ??
                q.supplier_id,
              currency: q.currency,
              total: q.total,
              valid_until: q.valid_until,
              items_count: Array.isArray(q.items) ? q.items.length : 0,
              notes: q.notes,
            }));

            const sorted = [...comparison].sort((a, b) => {
              const aTotal = parseFloat(a.total ?? "0");
              const bTotal = parseFloat(b.total ?? "0");
              return aTotal - bTotal;
            });

            return jsonResult(
              { quotes: sorted, raw: data },
              `Compared ${data.length} quotations — lowest total: ${sorted[0]?.supplier_name} at ${sorted[0]?.currency} ${sorted[0]?.total}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, compare`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
