import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createInventoryCheckTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_inventory_check",
    label: "Procurement: Inventory Check",
    description:
      "Check stock levels for a specific item across all warehouses, view all items in a warehouse, or generate a low stock report based on reorder rules.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("check_item"),
          Type.Literal("check_warehouse"),
          Type.Literal("low_stock_report"),
        ],
        { description: "Operation to perform" },
      ),
      item_id: Type.Optional(
        Type.String({ description: "Inventory item UUID (required for check_item)" }),
      ),
      warehouse_id: Type.Optional(
        Type.String({ description: "Warehouse UUID (required for check_warehouse)" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      try {
        switch (action) {
          case "check_item": {
            const itemId = params.item_id as string | undefined;
            if (!itemId) return errorResult("item_id is required for check_item");

            const { data: item, error: itemError } = await db.client
              .from("inventory_items")
              .select("id, name, sku, unit_of_measure, cost_price")
              .eq("tenant_id", db.tenantId)
              .eq("id", itemId)
              .single();

            if (itemError) return errorResult(`Inventory item not found: ${itemError.message}`);

            const { data: levels, error: levelError } = await db.client
              .from("stock_levels")
              .select("*, warehouse:warehouses(id, name, code)")
              .eq("tenant_id", db.tenantId)
              .eq("item_id", itemId);

            if (levelError)
              return errorResult(`Failed to fetch stock levels: ${levelError.message}`);

            const totalQty = (levels ?? []).reduce(
              (acc, l) => acc.plus(money(l.quantity ?? "0")),
              money("0"),
            );

            return jsonResult(
              {
                item,
                warehouses: levels ?? [],
                total_quantity: totalQty.toFixed(4),
              },
              `Stock for "${item.name}" (${item.sku ?? itemId}): ${totalQty.toFixed(2)} total across ${(levels ?? []).length} location(s)`,
            );
          }

          case "check_warehouse": {
            const warehouseId = params.warehouse_id as string | undefined;
            if (!warehouseId) return errorResult("warehouse_id is required for check_warehouse");

            const { data: warehouse, error: warehouseError } = await db.client
              .from("warehouses")
              .select("id, name, code")
              .eq("tenant_id", db.tenantId)
              .eq("id", warehouseId)
              .single();

            if (warehouseError)
              return errorResult(`Warehouse not found: ${warehouseError.message}`);

            const { data: levels, error: levelError } = await db.client
              .from("stock_levels")
              .select("*, item:inventory_items(id, name, sku, unit_of_measure, cost_price)")
              .eq("tenant_id", db.tenantId)
              .eq("warehouse_id", warehouseId)
              .order("created_at", { ascending: true });

            if (levelError)
              return errorResult(`Failed to fetch stock levels: ${levelError.message}`);

            const totalLines = (levels ?? []).length;
            const totalItems = (levels ?? []).reduce(
              (acc, l) => acc.plus(money(l.quantity ?? "0")),
              money("0"),
            );

            return jsonResult(
              {
                warehouse,
                stock_lines: levels ?? [],
                total_lines: totalLines,
                total_quantity: totalItems.toFixed(4),
              },
              `Warehouse "${warehouse.name}" (${warehouse.code ?? warehouseId}): ${totalLines} item(s), ${totalItems.toFixed(2)} total units`,
            );
          }

          case "low_stock_report": {
            const { data: rules, error: rulesError } = await db.client
              .from("reorder_rules")
              .select("*, item:inventory_items(id, name, sku, unit_of_measure)")
              .eq("tenant_id", db.tenantId)
              .eq("active", true);

            if (rulesError)
              return errorResult(`Failed to fetch reorder rules: ${rulesError.message}`);
            if (!rules || rules.length === 0) {
              return jsonResult({ low_stock_items: [], total: 0 }, "No active reorder rules found");
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

            const lowStockItems = rules
              .map((rule) => {
                const currentStock = stockByItem.get(rule.item_id as string) ?? money("0");
                const minLevel = money(rule.min_level ?? "0");
                const reorderQty = money(rule.reorder_quantity ?? "0");
                const isLow = currentStock.lessThanOrEqualTo(minLevel);
                return {
                  item_id: rule.item_id,
                  item_name: (rule.item as { name?: string } | null)?.name ?? rule.item_id,
                  item_sku: (rule.item as { sku?: string } | null)?.sku ?? null,
                  current_stock: currentStock.toFixed(4),
                  min_level: minLevel.toFixed(4),
                  reorder_quantity: reorderQty.toFixed(4),
                  preferred_supplier_id: rule.preferred_supplier_id ?? null,
                  is_low: isLow,
                };
              })
              .filter((item) => item.is_low);

            return jsonResult(
              { low_stock_items: lowStockItems, total: lowStockItems.length },
              `Low stock report: ${lowStockItems.length} item(s) below minimum level`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: check_item, check_warehouse, low_stock_report`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
