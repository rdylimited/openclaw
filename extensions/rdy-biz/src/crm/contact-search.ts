import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createContactSearchTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "crm_contact_search",
    label: "CRM: Search Contacts",
    description:
      "Full-text search across contacts by name, email, or phone with optional type filter.",
    parameters: Type.Object({
      query: Type.String({ description: "Search term matched against name, email, and phone" }),
      type: Type.Optional(
        Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("employee")], {
          description: "Filter results to a specific contact type",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Maximum results to return",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const query = params.query as string | undefined;
      if (!query || query.trim().length === 0) {
        return errorResult("query is required and must not be empty");
      }

      const limit = (params.limit as number | undefined) ?? 25;
      const type = params.type as string | undefined;
      const term = `%${query.trim()}%`;

      try {
        let baseQuery = db.client
          .from("contacts")
          .select("*, company:companies(name)")
          .eq("tenant_id", db.tenantId)
          .eq("is_active", true)
          .or(`name.ilike.${term},email.ilike.${term},phone.ilike.${term}`)
          .order("name", { ascending: true })
          .limit(limit);

        if (type) baseQuery = baseQuery.eq("type", type);

        const { data, error } = await baseQuery;

        if (error) return errorResult(`Search failed: ${error.message}`);

        const results = data ?? [];

        return jsonResult(
          { contacts: results, total: results.length, query, type: type ?? null },
          `Found ${results.length} contact${results.length !== 1 ? "s" : ""} matching "${query}"`,
        );
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
