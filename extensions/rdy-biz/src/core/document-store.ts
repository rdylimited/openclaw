import type { TenantClient } from "./supabase.js";

export type DocumentMeta = {
  id?: string;
  type: string;
  name: string;
  mime_type: string;
  storage_path: string;
  version: number;
  source_type?: string;
  source_id?: string;
};

export async function storeDocument(
  db: TenantClient,
  file: Buffer | Uint8Array,
  meta: DocumentMeta,
): Promise<string> {
  const path = `${db.tenantId}/${meta.type}/${Date.now()}-${meta.name}`;

  const { error: uploadError } = await db.client.storage
    .from("biz-documents")
    .upload(path, file, { contentType: meta.mime_type });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { data, error } = await db.client
    .from("documents")
    .insert({
      tenant_id: db.tenantId,
      ...meta,
      storage_path: path,
      version: meta.version ?? 1,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Document record failed: ${error.message}`);

  return data.id;
}

export async function getDocumentUrl(
  db: TenantClient,
  documentId: string,
  expiresIn = 3600,
): Promise<string> {
  const { data: doc, error } = await db.client
    .from("documents")
    .select("storage_path")
    .eq("tenant_id", db.tenantId)
    .eq("id", documentId)
    .single();
  if (error || !doc) throw new Error(`Document not found: ${documentId}`);

  const { data } = await db.client.storage
    .from("biz-documents")
    .createSignedUrl(doc.storage_path, expiresIn);
  if (!data?.signedUrl) throw new Error("Failed to generate signed URL");

  return data.signedUrl;
}
