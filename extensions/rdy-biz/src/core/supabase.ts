import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BizConfig } from "./config.js";

export type TenantClient = {
  client: SupabaseClient;
  tenantId: string;
  query: <T>(table: string) => ReturnType<SupabaseClient["from"]>;
  rpc: SupabaseClient["rpc"];
};

const clientCache = new Map<string, SupabaseClient>();

export function createTenantClient(config: BizConfig): TenantClient {
  const key = `${config.supabaseUrl}:${config.tenantId}`;
  let client = clientCache.get(key);
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      db: { schema: "biz" },
      global: {
        headers: { "x-tenant-id": config.tenantId },
      },
    });
    clientCache.set(key, client);
  }

  return {
    client,
    tenantId: config.tenantId,
    query: (table: string) => client!.from(table).select("*").eq("tenant_id", config.tenantId),
    rpc: client.rpc.bind(client),
  };
}
