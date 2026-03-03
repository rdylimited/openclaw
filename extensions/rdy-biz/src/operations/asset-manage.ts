import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

const ASSET_STATUSES = ["active", "disposed", "fully_depreciated"] as const;
type AssetStatus = (typeof ASSET_STATUSES)[number];

type DepreciationRow = {
  accumulated: string;
  period: string;
};

export function createAssetManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "ops_asset_manage",
    label: "Operations: Manage Assets",
    description:
      "Create, retrieve, list, dispose, and depreciate fixed assets. Depreciation uses straight-line method and tracks accumulated depreciation and book value.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("dispose"),
          Type.Literal("depreciate"),
        ],
        { description: "Operation to perform" },
      ),
      asset_id: Type.Optional(
        Type.String({ description: "Asset UUID (required for get, dispose, depreciate)" }),
      ),
      name: Type.Optional(Type.String({ description: "Asset name" })),
      category: Type.Optional(
        Type.String({ description: "Asset category (e.g. equipment, vehicle, furniture)" }),
      ),
      purchase_date: Type.Optional(Type.String({ description: "Purchase date (YYYY-MM-DD)" })),
      cost: Type.Optional(
        Type.String({ description: "Original cost as decimal string (e.g. '50000.00')" }),
      ),
      salvage_value: Type.Optional(
        Type.String({
          description: "Expected salvage/residual value as decimal string (e.g. '5000.00')",
        }),
      ),
      useful_life_months: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Useful life in months (for straight-line depreciation)",
        }),
      ),
      location: Type.Optional(Type.String({ description: "Physical location of the asset" })),
      notes: Type.Optional(Type.String({ description: "Free-form notes" })),
      period: Type.Optional(
        Type.String({
          description: "Depreciation period date (YYYY-MM-DD) — typically the last day of a month",
        }),
      ),
      status: Type.Optional(
        Type.Union(
          [Type.Literal("active"), Type.Literal("disposed"), Type.Literal("fully_depreciated")],
          { description: "Status filter for list" },
        ),
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
            const name = params.name as string | undefined;
            if (!name) return errorResult("name is required for create");

            const cost = params.cost as string | undefined;
            if (!cost) return errorResult("cost is required for create");

            const salvage_value = params.salvage_value as string | undefined;
            if (!salvage_value) return errorResult("salvage_value is required for create");

            const useful_life_months = params.useful_life_months as number | undefined;
            if (!useful_life_months)
              return errorResult("useful_life_months is required for create");

            const purchase_date = params.purchase_date as string | undefined;
            if (!purchase_date) return errorResult("purchase_date is required for create");

            // Validate monetary values
            try {
              money(cost);
              money(salvage_value);
            } catch {
              return errorResult("cost and salvage_value must be valid decimal numbers");
            }

            const payload = {
              tenant_id: db.tenantId,
              name,
              category: (params.category as string | undefined) ?? null,
              purchase_date,
              cost,
              salvage_value,
              useful_life_months,
              location: (params.location as string | undefined) ?? null,
              notes: (params.notes as string | undefined) ?? null,
              status: "active" as AssetStatus,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            const { data, error } = await db.client
              .from("assets")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create asset: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "asset",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, cost, useful_life_months },
            });

            return jsonResult(data, `Asset created: ${data.name} (${data.id})`);
          }

          case "get": {
            const asset_id = params.asset_id as string | undefined;
            if (!asset_id) return errorResult("asset_id is required for get");

            const { data, error } = await db.client
              .from("assets")
              .select("*, depreciation:asset_depreciation(*)")
              .eq("tenant_id", db.tenantId)
              .eq("id", asset_id)
              .single();

            if (error) return errorResult(`Asset not found: ${error.message}`);

            return jsonResult(data, `Asset: ${data.name} — status: ${data.status}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const status = params.status as string | undefined;
            const category = params.category as string | undefined;

            let query = db.client
              .from("assets")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("name", { ascending: true })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (category) query = query.eq("category", category);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list assets: ${error.message}`);

            return jsonResult(
              { assets: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} assets (page ${page})`,
            );
          }

          case "dispose": {
            const asset_id = params.asset_id as string | undefined;
            if (!asset_id) return errorResult("asset_id is required for dispose");

            const { data, error } = await db.client
              .from("assets")
              .update({ status: "disposed" as AssetStatus, updated_at: new Date().toISOString() })
              .eq("tenant_id", db.tenantId)
              .eq("id", asset_id)
              .select("name, status")
              .single();

            if (error) return errorResult(`Failed to dispose asset: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "asset",
              entity_id: asset_id,
              action: "update",
              actor: _id,
              payload: { status: "disposed" },
            });

            return jsonResult({ asset_id, status: data.status }, `Asset disposed: ${data.name}`);
          }

          case "depreciate": {
            const asset_id = params.asset_id as string | undefined;
            if (!asset_id) return errorResult("asset_id is required for depreciate");

            const period = params.period as string | undefined;
            if (!period) return errorResult("period is required for depreciate (YYYY-MM-DD)");

            // Fetch asset details
            const { data: asset, error: assetError } = await db.client
              .from("assets")
              .select("id, name, cost, salvage_value, useful_life_months, status")
              .eq("tenant_id", db.tenantId)
              .eq("id", asset_id)
              .single();

            if (assetError) return errorResult(`Asset not found: ${assetError.message}`);

            if (asset.status === "disposed") {
              return errorResult("Cannot depreciate a disposed asset");
            }

            if (asset.status === "fully_depreciated") {
              return errorResult("Asset is already fully depreciated");
            }

            const costDec = money(asset.cost);
            const salvageDec = money(asset.salvage_value);
            const months = asset.useful_life_months as number;

            // Monthly straight-line depreciation
            const monthlyAmount = costDec.minus(salvageDec).dividedBy(months);

            // Fetch last depreciation record to get accumulated amount
            const { data: lastDep, error: depError } = await db.client
              .from("asset_depreciation")
              .select("accumulated, period")
              .eq("tenant_id", db.tenantId)
              .eq("asset_id", asset_id)
              .order("period", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (depError)
              return errorResult(`Failed to fetch depreciation history: ${depError.message}`);

            // Check duplicate period
            if (lastDep && (lastDep as DepreciationRow).period === period) {
              return errorResult(`Depreciation already recorded for period ${period}`);
            }

            const priorAccumulated = lastDep
              ? money((lastDep as DepreciationRow).accumulated)
              : money("0");

            const newAccumulated = priorAccumulated.plus(monthlyAmount);
            const bookValue = costDec.minus(newAccumulated);

            // Cap book value at salvage value
            const effectiveBookValue = bookValue.lessThan(salvageDec) ? salvageDec : bookValue;
            const effectiveAccumulated = costDec.minus(effectiveBookValue);
            const effectiveAmount = effectiveAccumulated.minus(priorAccumulated);

            const depRecord = {
              tenant_id: db.tenantId,
              asset_id,
              period,
              amount: effectiveAmount.toFixed(2),
              accumulated: effectiveAccumulated.toFixed(2),
              book_value: effectiveBookValue.toFixed(2),
              created_at: new Date().toISOString(),
            };

            const { data: inserted, error: insertError } = await db.client
              .from("asset_depreciation")
              .insert(depRecord)
              .select("*")
              .single();

            if (insertError)
              return errorResult(`Failed to record depreciation: ${insertError.message}`);

            // Mark asset as fully depreciated if book value reached salvage value
            let newStatus: AssetStatus = "active";
            if (effectiveBookValue.lessThanOrEqualTo(salvageDec)) {
              newStatus = "fully_depreciated";
              await db.client
                .from("assets")
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq("tenant_id", db.tenantId)
                .eq("id", asset_id);
            }

            await writeAuditLog(db, {
              entity_type: "asset",
              entity_id: asset_id,
              action: "update",
              actor: _id,
              payload: {
                period,
                amount: depRecord.amount,
                accumulated: depRecord.accumulated,
                book_value: depRecord.book_value,
              },
            });

            return jsonResult(
              { ...inserted, asset_status: newStatus },
              `Depreciation recorded for ${asset.name} — period: ${period}, amount: ${depRecord.amount}, book value: ${depRecord.book_value}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, dispose, depreciate`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
