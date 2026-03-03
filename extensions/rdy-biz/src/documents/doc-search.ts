import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { jsonResult, errorResult, type ToolResult } from "../core/types.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function createDocSearchTool(config: BizConfig) {
  return {
    name: "doc_doc_search",
    label: "Document Search",
    description:
      "Search documents with optional filters on name, type, and date range. Returns paginated results.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Partial name search (case-insensitive ILIKE match)",
        }),
      ),
      type: Type.Optional(
        Type.String({
          description: "Filter by document type (exact match)",
        }),
      ),
      date_from: Type.Optional(
        Type.String({
          description: "ISO date lower bound for created_at (inclusive, YYYY-MM-DD)",
        }),
      ),
      date_to: Type.Optional(
        Type.String({
          description: "ISO date upper bound for created_at (inclusive, YYYY-MM-DD)",
        }),
      ),
      page: Type.Optional(
        Type.Number({
          minimum: 1,
          default: DEFAULT_PAGE,
          description: "Page number (1-based)",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: "Items per page (max 100)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const query = params["query"] as string | undefined;
      const type = params["type"] as string | undefined;
      const dateFrom = params["date_from"] as string | undefined;
      const dateTo = params["date_to"] as string | undefined;
      const page = Math.max(1, (params["page"] as number | undefined) ?? DEFAULT_PAGE);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, (params["limit"] as number | undefined) ?? DEFAULT_LIMIT),
      );
      const offset = (page - 1) * limit;

      const db = createTenantClient(config);

      try {
        let dbQuery = db.client
          .from("documents")
          .select("*", { count: "exact" })
          .eq("tenant_id", db.tenantId)
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (query) {
          dbQuery = dbQuery.ilike("name", `%${query}%`);
        }

        if (type) {
          dbQuery = dbQuery.eq("type", type);
        }

        if (dateFrom) {
          dbQuery = dbQuery.gte("created_at", `${dateFrom}T00:00:00.000Z`);
        }

        if (dateTo) {
          dbQuery = dbQuery.lte("created_at", `${dateTo}T23:59:59.999Z`);
        }

        const { data, count, error } = await dbQuery;

        if (error) return errorResult(`Search failed: ${error.message}`);

        const totalCount = count ?? 0;
        const totalPages = Math.ceil(totalCount / limit);

        const result = {
          data: data ?? [],
          meta: {
            total: totalCount,
            page,
            limit,
            total_pages: totalPages,
            has_next_page: page < totalPages,
            has_prev_page: page > 1,
          },
        };

        return jsonResult(
          result,
          `Found ${totalCount} document(s) (page ${page} of ${totalPages})`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Document search failed: ${message}`);
      }
    },
  };
}
