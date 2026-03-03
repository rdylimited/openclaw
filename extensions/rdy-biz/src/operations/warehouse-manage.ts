import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type StockLevelRow = {
  id: string;
  quantity: number;
};

export function createWarehouseManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_warehouse_manage",
    label: "Operations: Manage Warehouses",
    description:
      "Create, retrieve, list, update, deactivate warehouses, and transfer stock between warehouses with movement tracking.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("update"),
          Type.Literal("deactivate"),
          Type.Literal("transfer_stock"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Warehouse UUID (required for get, update, deactivate)" }),
      ),
      name: Type.Optional(Type.String({ description: "Warehouse name" })),
      code: Type.Optional(Type.String({ description: "Short warehouse code (e.g. WH-01)" })),
      address: Type.Optional(Type.String({ description: "Physical address" })),
      notes: Type.Optional(Type.String({ description: "Free-form notes" })),
      from_warehouse_id: Type.Optional(
        Type.String({ description: "Source warehouse UUID (required for transfer_stock)" }),
      ),
      to_warehouse_id: Type.Optional(
        Type.String({ description: "Destination warehouse UUID (required for transfer_stock)" }),
      ),
      item_id: Type.Optional(
        Type.String({
          description: "Inventory item UUID to transfer (required for transfer_stock)",
        }),
      ),
      quantity: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Quantity to transfer (required for transfer_stock)",
        }),
      ),
      reason: Type.Optional(Type.String({ description: "Reason for stock transfer" })),
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
            if (!name) return errorResult("name is required for create");

            const payload = {
              tenant_id: db.tenantId,
              name,
              code: (params.code as string | undefined) ?? null,
              address: (params.address as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("warehouses")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create warehouse: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "warehouse",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, code: payload.code },
            });

            return jsonResult(data, `Warehouse created: ${data.name} (${data.id})`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data, error } = await db.client
              .from("warehouses")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (error) return errorResult(`Warehouse not found: ${error.message}`);

            return jsonResult(data, `Warehouse: ${data.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;

            const { data, error, count } = await db.client
              .from("warehouses")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .eq("is_active", true)
              .order("name", { ascending: true })
              .range(offset, offset + limit - 1);

            if (error) return errorResult(`Failed to list warehouses: ${error.message}`);

            return jsonResult(
              { warehouses: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} warehouses (page ${page})`,
            );
          }

          case "update": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for update");

            const updates: Record<string, unknown> = {
              updated_at: new Date().toISOString(),
            };

            if (params.name !== undefined) updates.name = params.name;
            if (params.code !== undefined) updates.code = params.code;
            if (params.address !== undefined) updates.address = params.address;
            if (params.notes !== undefined) updates.notes = params.notes;

            const { data, error } = await db.client
              .from("warehouses")
              .update(updates)
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to update warehouse: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "warehouse",
              entity_id: id,
              action: "update",
              actor: _id,
              payload: updates,
            });

            return jsonResult(data, `Warehouse updated: ${data.name}`);
          }

          case "deactivate": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for deactivate");

            const { data, error } = await db.client
              .from("warehouses")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("name")
              .single();

            if (error) return errorResult(`Failed to deactivate warehouse: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "warehouse",
              entity_id: id,
              action: "delete",
              actor: _id,
              payload: { deactivated: true },
            });

            return jsonResult({ id, deactivated: true }, `Warehouse deactivated: ${data.name}`);
          }

          case "transfer_stock": {
            const from_warehouse_id = params.from_warehouse_id as string | undefined;
            const to_warehouse_id = params.to_warehouse_id as string | undefined;
            const item_id = params.item_id as string | undefined;
            const quantity = params.quantity as number | undefined;

            if (!from_warehouse_id)
              return errorResult("from_warehouse_id is required for transfer_stock");
            if (!to_warehouse_id)
              return errorResult("to_warehouse_id is required for transfer_stock");
            if (!item_id) return errorResult("item_id is required for transfer_stock");
            if (!quantity || quantity < 1)
              return errorResult("quantity must be at least 1 for transfer_stock");

            if (from_warehouse_id === to_warehouse_id) {
              return errorResult("from_warehouse_id and to_warehouse_id must be different");
            }

            // Fetch current stock at source warehouse
            const { data: sourceStock, error: sourceError } = await db.client
              .from("stock_levels")
              .select("id, quantity")
              .eq("tenant_id", db.tenantId)
              .eq("warehouse_id", from_warehouse_id)
              .eq("item_id", item_id)
              .maybeSingle();

            if (sourceError)
              return errorResult(`Failed to fetch source stock level: ${sourceError.message}`);

            const sourceQty = (sourceStock as StockLevelRow | null)?.quantity ?? 0;
            if (sourceQty < quantity) {
              return errorResult(
                `Insufficient stock at source warehouse — available: ${sourceQty}, requested: ${quantity}`,
              );
            }

            // Decrement source stock
            const newSourceQty = sourceQty - quantity;
            const { error: decrementError } = await db.client
              .from("stock_levels")
              .update({ quantity: newSourceQty, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", (sourceStock as StockLevelRow).id);

            if (decrementError)
              return errorResult(`Failed to decrement source stock: ${decrementError.message}`);

            // Fetch current stock at destination warehouse
            const { data: destStock, error: destFetchError } = await db.client
              .from("stock_levels")
              .select("id, quantity")
              .eq("tenant_id", db.tenantId)
              .eq("warehouse_id", to_warehouse_id)
              .eq("item_id", item_id)
              .maybeSingle();

            if (destFetchError)
              return errorResult(
                `Failed to fetch destination stock level: ${destFetchError.message}`,
              );

            const destQty = (destStock as StockLevelRow | null)?.quantity ?? 0;
            const newDestQty = destQty + quantity;

            if (destStock) {
              // Update existing record
              const { error: incrementError } = await db.client
                .from("stock_levels")
                .update({ quantity: newDestQty, updated_at: new Date().toISOString() })
                .eq("tenant_id", db.tenantId)
                .eq("id", (destStock as StockLevelRow).id);

              if (incrementError)
                return errorResult(
                  `Failed to increment destination stock: ${incrementError.message}`,
                );
            } else {
              // Upsert new record for destination
              const { error: upsertError } = await db.client.from("stock_levels").insert({
                tenant_id: db.tenantId,
                warehouse_id: to_warehouse_id,
                item_id,
                quantity: newDestQty,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });

              if (upsertError)
                return errorResult(
                  `Failed to create destination stock record: ${upsertError.message}`,
                );
            }

            // Record stock movement
            const movement = {
              tenant_id: db.tenantId,
              from_warehouse_id,
              to_warehouse_id,
              item_id,
              quantity,
              reason: (params.reason as string | undefined) ?? null,
              moved_at: new Date().toISOString(),
            };

            const { data: movementData, error: movementError } = await db.client
              .from("stock_movements")
              .insert(movement)
              .select("*")
              .single();

            if (movementError)
              return errorResult(`Failed to record stock movement: ${movementError.message}`);

            await writeAuditLog(db, {
              entity_type: "stock_movement",
              entity_id: movementData.id,
              action: "create",
              actor: _id,
              payload: { from_warehouse_id, to_warehouse_id, item_id, quantity },
            });

            return jsonResult(
              {
                movement: movementData,
                source_balance: newSourceQty,
                destination_balance: newDestQty,
              },
              `Stock transfer complete — ${quantity} units of item ${item_id} moved from ${from_warehouse_id} to ${to_warehouse_id}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, update, deactivate, transfer_stock`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
