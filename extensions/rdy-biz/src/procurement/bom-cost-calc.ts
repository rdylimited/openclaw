import { Type } from "@sinclair/typebox";
import Decimal from "decimal.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient, type TenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type BomLineRaw = {
  id: string;
  item_id: string | null;
  description: string | null;
  quantity: string;
  child_bom_id: string | null;
  level: number;
  sort_order: number;
  component?: { name?: string; sku?: string; cost_price?: string | null } | null;
};

type CostBreakdownItem = {
  item_id: string | null;
  item_name: string;
  quantity: string;
  unit_price: string;
  line_cost: string;
  level: number;
  children?: CostBreakdownItem[];
};

async function calcBomCostRecursive(
  db: TenantClient,
  bomId: string,
  parentQtyMultiplier: Decimal,
  depth: number,
): Promise<{ items: CostBreakdownItem[]; total: Decimal }> {
  if (depth > 10) {
    return { items: [], total: new Decimal(0) };
  }

  const { data: lines, error } = await db.client
    .from("bom_lines")
    .select("*, component:inventory_items(name, sku, cost_price)")
    .eq("tenant_id", db.tenantId)
    .eq("bom_id", bomId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`Failed to fetch BOM lines for bom_id=${bomId}: ${error.message}`);
  if (!lines || lines.length === 0) return { items: [], total: new Decimal(0) };

  const items: CostBreakdownItem[] = [];
  let total = new Decimal(0);

  for (const line of lines as BomLineRaw[]) {
    const lineQty = money(line.quantity).times(parentQtyMultiplier);

    if (line.child_bom_id) {
      const sub = await calcBomCostRecursive(db, line.child_bom_id, lineQty, depth + 1);
      const subTotal = sub.total;
      total = total.plus(subTotal);

      const componentName =
        line.component?.name ?? line.description ?? `Sub-assembly (${line.child_bom_id})`;

      items.push({
        item_id: line.item_id,
        item_name: componentName,
        quantity: lineQty.toFixed(4),
        unit_price: "0.00",
        line_cost: subTotal.toFixed(2),
        level: line.level ?? depth,
        children: sub.items,
      });
    } else {
      const costPrice = line.component?.cost_price ?? "0";
      const unitPrice = money(costPrice);
      const lineCost = lineQty.times(unitPrice);
      total = total.plus(lineCost);

      const itemName = line.component?.name ?? line.description ?? line.item_id ?? "Unknown item";

      items.push({
        item_id: line.item_id,
        item_name: itemName,
        quantity: lineQty.toFixed(4),
        unit_price: unitPrice.toFixed(2),
        line_cost: lineCost.toFixed(2),
        level: line.level ?? depth,
      });
    }
  }

  return { items, total };
}

export function createBomCostCalcTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "proc_bom_cost_calc",
    label: "Procurement: BOM Cost Calculator",
    description:
      "Calculate the total cost of a bill of materials by recursively fetching all component lines and their cost prices from inventory. Supports multi-level BOMs with sub-assemblies.",
    parameters: Type.Object({
      bom_id: Type.String({ description: "BOM header UUID to calculate cost for" }),
      quantity: Type.Optional(
        Type.String({
          description: "Production quantity multiplier as decimal string (default: '1')",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const bomId = params.bom_id as string | undefined;
      if (!bomId) return errorResult("bom_id is required");

      const qty = money((params.quantity as string | undefined) ?? "1");

      try {
        const { data: header, error: headerError } = await db.client
          .from("bom_headers")
          .select("*, item:inventory_items(name, sku)")
          .eq("tenant_id", db.tenantId)
          .eq("id", bomId)
          .single();

        if (headerError) return errorResult(`BOM not found: ${headerError.message}`);

        const { items, total } = await calcBomCostRecursive(db, bomId, qty, 0);
        const totalCost = total.toFixed(2);

        return jsonResult(
          {
            bom_id: bomId,
            bom_name: header.name,
            finished_product: header.item?.name ?? null,
            quantity: qty.toFixed(4),
            currency: config.defaultCurrency,
            breakdown: items,
            total_cost: totalCost,
          },
          `BOM cost for "${header.name}" (qty: ${qty.toFixed(0)}): ${config.defaultCurrency} ${totalCost}`,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
