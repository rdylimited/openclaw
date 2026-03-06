import type { TenantClient } from "./supabase.js";

/**
 * Resolve a book UUID from a book code (e.g. "statutory", "internal").
 * Returns the default book if no code is provided.
 * Returns null if books aren't set up yet (backward compat).
 */
export async function resolveBookId(db: TenantClient, bookCode?: string): Promise<string | null> {
  if (bookCode) {
    const { data, error } = await db.client
      .from("books")
      .select("id")
      .eq("tenant_id", db.tenantId)
      .eq("code", bookCode)
      .eq("active", true)
      .single();

    if (error || !data) return null;
    return data.id as string;
  }

  // No code specified — return the default book
  const { data, error } = await db.client
    .from("books")
    .select("id")
    .eq("tenant_id", db.tenantId)
    .eq("is_default", true)
    .eq("active", true)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.id as string;
}
