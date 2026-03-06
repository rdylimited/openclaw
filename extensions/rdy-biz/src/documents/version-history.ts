import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { createTenantClient } from "../core/supabase.js";
import { jsonResult, errorResult, type ToolResult } from "../core/types.js";

export function createVersionHistoryTool(config: BizConfig) {
  return {
    name: "doc_version_history",
    label: "Version History",
    description:
      "Retrieve the complete version history for a document, including version numbers, who made changes, timestamps, and storage paths.",
    parameters: Type.Object({
      document_id: Type.String({
        description: "UUID of the document to retrieve version history for",
      }),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const documentId = params["document_id"] as string | undefined;
      if (!documentId) return errorResult("document_id is required");

      const db = createTenantClient(config);

      try {
        const { data: versions, error } = await db.client
          .from("document_versions")
          .select("version, changed_by, created_at, storage_path")
          .eq("tenant_id", db.tenantId)
          .eq("document_id", documentId)
          .order("version", { ascending: false });

        if (error) {
          return errorResult(`Failed to retrieve version history: ${error.message}`);
        }

        const result = {
          document_id: documentId,
          total_versions: versions?.length ?? 0,
          versions: versions ?? [],
        };

        return jsonResult(
          result,
          `Found ${result.total_versions} version(s) for document ${documentId}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Version history retrieval failed: ${message}`);
      }
    },
  };
}
