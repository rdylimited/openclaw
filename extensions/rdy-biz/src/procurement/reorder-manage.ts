import { Type } from "@sinclair/typebox";
import Decimal from "decimal.js";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createReorderManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_reorder_manage",
    label: "Procurement: Reorder Rule Management",
    description:
      "Create, retrieve, update, list, or delete reorder rules. Run trigger_check to identify items below minimum stock levels and generate suggested purchase order data.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("update"),
          Type.Literal("delete"),
          Type.Literal("trigger_check"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Reorder rule UUID (required for get/update/delete)" }),
      ),
      item_id: Type.Optional(
        Type.String({ description: "Inventory item UUID (required for create)" }),
      ),
      min_level: Type.Optional(
        Type.String({
          description:
            "Minimum stock level as decimal string; triggers reorder when at or below this",
        }),
      ),
      reorder_quantity: Type.Optional(
        Type.String({ description: "Quantity to order when restocking as decimal string" }),
      ),
      preferred_supplier_id: Type.Optional(
        Type.String({ description: "Preferred supplier UUID for auto-PO suggestions" }),
      ),
      active: Type.Optional(Type.Boolean({ description: "Whether the reorder rule is active" })),
      active_filter: Type.Optional(
        Type.Boolean({ description: "Filter by active status (for list)" }),
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
            const itemId = params.item_id as string | undefined;
            const minLevel = params.min_level as string | undefined;
            const reorderQuantity = params.reorder_quantity as string | undefined;

            if (!itemId) return errorResult("item_id is required for create");
            if (!minLevel) return errorResult("min_level is required for create");
            if (!reorderQuantity) return errorResult("reorder_quantity is required for create");

            const now = new Date().toISOString();
            const payload = {
              tenant_id: db.tenantId,
              item_id: itemId,
              min_level: money(minLevel).toFixed(4),
              reorder_quantity: money(reorderQuantity).toFixed(4),
              preferred_supplier_id: (params.preferred_supplier_id as string | undefined) ?? null,
              active: (params.active as boolean | undefined) ?? true,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("reorder_rules")
              .insert(payload)
              .select("*, item:inventory_items(name, sku)")
              .single();

            if (error) return errorResult(`Failed to create reorder rule: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "reorder_rule",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { item_id: itemId, min_level: minLevel, reorder_quantity: reorderQuantity },
            });

            return jsonResult(data, `Reorder rule created for item: ${data.item?.name ?? itemId}`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("reorder_rules")
              .select("*, item:inventory_items(id, name, sku, unit_of_measure)")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Reorder rule not found: ${error.message}`);

            return jsonResult(data, `Reorder rule for: ${data.item?.name ?? data.item_id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const activeFilter = params.active_filter as boolean | undefined;

            let query = db.client
              .from("reorder_rules")
              .select("*, item:inventory_items(id, name, sku)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1);

            if (activeFilter !== undefined) query = query.eq("active", activeFilter);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list reorder rules: ${error.message}`);

            return jsonResult(
              { reorder_rules: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} reorder rules (page ${page})`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

            if (params.min_level !== undefined)
              updates.min_level = money(params.min_level as string).toFixed(4);
            if (params.reorder_quantity !== undefined)
              updates.reorder_quantity = money(params.reorder_quantity as string).toFixed(4);
            if (params.preferred_supplier_id !== undefined)
              updates.preferred_supplier_id = params.preferred_supplier_id;
            if (params.active !== undefined) updates.active = params.active;

            const { data, error } = await db.client
              .from("reorder_rules")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*, item:inventory_items(name, sku)")
              .single();

            if (error) return errorResult(`Failed to update reorder rule: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "reorder_rule",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Reorder rule updated for: ${data.item?.name ?? data.item_id}`);
          }

          case "delete": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for delete");

            const { data: existing, error: fetchError } = await db.client
              .from("reorder_rules")
              .select("item_id")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Reorder rule not found: ${fetchError.message}`);

            const { error } = await db.client
              .from("reorder_rules")
              .delete()
              .eq("tenant_id", db.tenantId)
              .eq("id", id);

            if (error) return errorResult(`Failed to delete reorder rule: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "reorder_rule",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { item_id: existing.item_id },
            });

            return jsonResult({ deleted: true, id }, `Reorder rule deleted`);
          }

          case "trigger_check": {
            const { data: rules, error: rulesError } = await db.client
              .from("reorder_rules")
              .select("*, item:inventory_items(id, name, sku, unit_of_measure, cost_price)")
              .eq("tenant_id", db.tenantId)
              .eq("active", true);

            if (rulesError)
              return errorResult(`Failed to fetch reorder rules: ${rulesError.message}`);
            if (!rules || rules.length === 0) {
              return jsonResult(
                { items_needing_reorder: [], total: 0, suggested_pos: [] },
                "No active reorder rules found",
              );
            }

            const itemIds = rules.map((r) => r.item_id as string).filter(Boolean);

            const { data: levels, error: levelsError } = await db.client
              .from("stock_levels")
              .select("item_id, quantity, warehouse_id")
              .eq("tenant_id", db.tenantId)
              .in("item_id", itemIds);

            if (levelsError)
              return errorResult(`Failed to fetch stock levels: ${levelsError.message}`);

            const stockByItem = new Map<string, Decimal>();
            for (const level of levels ?? []) {
              const itemId = level.item_id as string;
              const current = stockByItem.get(itemId) ?? money("0");
              stockByItem.set(itemId, current.plus(money(level.quantity ?? "0")));
            }

            const itemsNeedingReorder = rules
              .map((rule) => {
                const currentStock = stockByItem.get(rule.item_id as string) ?? money("0");
                const minLevel = money(rule.min_level ?? "0");
                const reorderQty = money(rule.reorder_quantity ?? "0");
                const isLow = currentStock.lessThanOrEqualTo(minLevel);
                return {
                  rule_id: rule.id,
                  item_id: rule.item_id,
                  item_name: (rule.item as { name?: string } | null)?.name ?? rule.item_id,
                  item_sku: (rule.item as { sku?: string } | null)?.sku ?? null,
                  unit_of_measure:
                    (rule.item as { unit_of_measure?: string } | null)?.unit_of_measure ?? null,
                  current_stock: currentStock.toFixed(4),
                  min_level: minLevel.toFixed(4),
                  reorder_quantity: reorderQty.toFixed(4),
                  preferred_supplier_id: rule.preferred_supplier_id ?? null,
                  suggested_order_qty: reorderQty.toFixed(4),
                  is_low: isLow,
                };
              })
              .filter((item) => item.is_low);

            const supplierGroups = new Map<string, typeof itemsNeedingReorder>();
            const noSupplierItems: typeof itemsNeedingReorder = [];

            for (const item of itemsNeedingReorder) {
              if (item.preferred_supplier_id) {
                const group = supplierGroups.get(item.preferred_supplier_id) ?? [];
                group.push(item);
                supplierGroups.set(item.preferred_supplier_id, group);
              } else {
                noSupplierItems.push(item);
              }
            }

            const suggestedPos = Array.from(supplierGroups.entries()).map(
              ([supplierId, items]) => ({
                suggested_supplier_id: supplierId,
                items: items.map((i) => ({
                  item_id: i.item_id,
                  item_name: i.item_name,
                  quantity: i.suggested_order_qty,
                  description: `Reorder for ${i.item_name} (${i.item_sku ?? i.item_id})`,
                })),
              }),
            );

            return jsonResult(
              {
                items_needing_reorder: itemsNeedingReorder,
                total: itemsNeedingReorder.length,
                suggested_pos: suggestedPos,
                items_without_supplier: noSupplierItems,
              },
              `Reorder check complete: ${itemsNeedingReorder.length} item(s) need reordering, ${suggestedPos.length} suggested PO(s)`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, update, delete, trigger_check`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
