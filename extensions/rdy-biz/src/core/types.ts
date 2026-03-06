import { Type, type Static } from "@sinclair/typebox";

// Reusable parameter fragments
export const TenantId = Type.String({ description: "Tenant ID (auto-injected)" });
export const Uuid = Type.String({ format: "uuid", description: "UUID identifier" });
export const IsoDate = Type.String({ format: "date", description: "ISO date (YYYY-MM-DD)" });
export const IsoDateTime = Type.String({ format: "date-time", description: "ISO datetime" });
export const CurrencyCode = Type.String({
  minLength: 3,
  maxLength: 3,
  description: "ISO 4217 currency code",
});
export const MoneyAmount = Type.String({
  description: "Decimal amount as string (e.g. '1234.56')",
});

// Pagination
export const PaginationParams = Type.Object({
  page: Type.Optional(Type.Number({ minimum: 1, default: 1, description: "Page number" })),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 100, default: 25, description: "Items per page" }),
  ),
});

// Common result types
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

export function jsonResult(data: unknown, summary?: string): ToolResult {
  const text = summary
    ? `${summary}\n\n${JSON.stringify(data, null, 2)}`
    : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], details: { data } };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: true } };
}
