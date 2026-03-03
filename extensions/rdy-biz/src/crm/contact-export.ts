import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, textResult, jsonResult, errorResult } from "../core/types.js";

const CSV_HEADERS = ["id", "name", "type", "email", "phone", "company_name", "notes", "created_at"];

function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Wrap in quotes if the field contains commas, quotes, or newlines
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCSV(row: Record<string, unknown>): string {
  return CSV_HEADERS.map((header) => {
    if (header === "company_name") {
      const company = row.company as Record<string, unknown> | null;
      return escapeCSVField(company?.name ?? null);
    }
    return escapeCSVField(row[header]);
  }).join(",");
}

export function createContactExportTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "crm_contact_export",
    label: "CRM: Export Contacts",
    description: "Export all active contacts as CSV or JSON, with optional type filter.",
    parameters: Type.Object({
      type: Type.Optional(
        Type.Union([Type.Literal("customer"), Type.Literal("vendor"), Type.Literal("employee")], {
          description: "Filter exported contacts by type",
        }),
      ),
      format: Type.Optional(
        Type.Union([Type.Literal("csv"), Type.Literal("json")], {
          description: 'Output format: "csv" (default) or "json"',
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const format = (params.format as string | undefined) ?? "csv";
      const type = params.type as string | undefined;

      if (format !== "csv" && format !== "json") {
        return errorResult(`format must be "csv" or "json", got: ${format}`);
      }

      try {
        let query = db.client
          .from("contacts")
          .select("id, name, type, email, phone, notes, created_at, company:companies(name)")
          .eq("tenant_id", db.tenantId)
          .eq("is_active", true)
          .order("name", { ascending: true });

        if (type) query = query.eq("type", type);

        const { data, error } = await query;

        if (error) return errorResult(`Failed to query contacts: ${error.message}`);

        const rows = (data ?? []) as Array<Record<string, unknown>>;

        if (format === "json") {
          const normalized = rows.map((row) => ({
            id: row.id,
            name: row.name,
            type: row.type,
            email: row.email ?? null,
            phone: row.phone ?? null,
            company_name: (row.company as Record<string, unknown> | null)?.name ?? null,
            notes: row.notes ?? null,
            created_at: row.created_at,
          }));

          return jsonResult(
            normalized,
            `Exported ${normalized.length} contact${normalized.length !== 1 ? "s" : ""}`,
          );
        }

        // CSV format
        const headerRow = CSV_HEADERS.join(",");
        const dataRows = rows.map(rowToCSV);
        const csv = [headerRow, ...dataRows].join("\n");

        return textResult(csv, {
          format: "csv",
          rows: rows.length,
          type: type ?? "all",
        });
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
