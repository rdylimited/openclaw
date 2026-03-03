import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney, moneyEqual } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type JournalLine = {
  account_id: string;
  debit: string;
  credit: string;
  description?: string;
};

export function createJournalEntryTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_journal_entry",
    label: "Finance: Journal Entry",
    description:
      "Create, retrieve, list, post, or reverse double-entry journal entries. Validates that total debits equal total credits before insert.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("post"),
          Type.Literal("reverse"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Journal entry UUID (required for get/post/reverse)" }),
      ),
      date: Type.Optional(Type.String({ description: "Entry date (YYYY-MM-DD)" })),
      memo: Type.Optional(Type.String({ description: "Entry memo / description" })),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            account_id: Type.String({ description: "Chart of accounts UUID" }),
            debit: Type.String({ description: "Debit amount as decimal string (use '0' if none)" }),
            credit: Type.String({
              description: "Credit amount as decimal string (use '0' if none)",
            }),
            description: Type.Optional(Type.String({ description: "Line description" })),
          }),
          { description: "Journal lines — must balance (total debits == total credits)" },
        ),
      ),
      status: Type.Optional(
        Type.Union([Type.Literal("draft"), Type.Literal("posted")], {
          description: "Status filter for list",
        }),
      ),
      date_from: Type.Optional(Type.String({ description: "Start date filter (YYYY-MM-DD)" })),
      date_to: Type.Optional(Type.String({ description: "End date filter (YYYY-MM-DD)" })),
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
            const date = params.date as string | undefined;
            const memo = params.memo as string | undefined;
            const lines = params.lines as JournalLine[] | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!date) return errorResult("date is required for create");
            if (!lines || lines.length < 2)
              return errorResult("lines is required and must have at least 2 entries");

            // Validate double-entry balance
            const totalDebits = sumMoney(lines.map((l) => l.debit ?? "0"));
            const totalCredits = sumMoney(lines.map((l) => l.credit ?? "0"));

            if (!moneyEqual(totalDebits, totalCredits)) {
              return errorResult(
                `Journal entry does not balance: total debits ${totalDebits.toFixed(2)} != total credits ${totalCredits.toFixed(2)}`,
              );
            }

            if (moneyEqual(totalDebits, "0")) {
              return errorResult("Journal entry must have non-zero amounts");
            }

            const now = new Date().toISOString();

            const entryPayload = {
              tenant_id: db.tenantId,
              date,
              memo: memo ?? null,
              currency,
              status: "draft",
              total_debit: totalDebits.toFixed(2),
              total_credit: totalCredits.toFixed(2),
              created_at: now,
              updated_at: now,
            };

            const { data: entry, error: entryError } = await db.client
              .from("journal_entries")
              .insert(entryPayload)
              .select("*")
              .single();

            if (entryError)
              return errorResult(`Failed to create journal entry: ${entryError.message}`);

            const linePayloads = lines.map((l) => ({
              tenant_id: db.tenantId,
              journal_entry_id: entry.id,
              account_id: l.account_id,
              debit: money(l.debit ?? "0").toFixed(2),
              credit: money(l.credit ?? "0").toFixed(2),
              description: l.description ?? null,
              created_at: now,
            }));

            const { data: insertedLines, error: lineError } = await db.client
              .from("journal_lines")
              .insert(linePayloads)
              .select("*");

            if (lineError)
              return errorResult(`Failed to create journal lines: ${lineError.message}`);

            await writeAuditLog(db, {
              entity_type: "journal_entry",
              entity_id: entry.id,
              action: "create",
              actor: _id,
              payload: { date, memo, currency, line_count: lines.length },
            });

            return jsonResult(
              { entry, lines: insertedLines },
              `Journal entry created (draft): ${entry.id} — ${totalDebits.toFixed(2)} ${currency}`,
            );
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: entry, error: entryError } = await db.client
              .from("journal_entries")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (entryError) return errorResult(`Journal entry not found: ${entryError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("journal_lines")
              .select("*, account:chart_of_accounts(code, name, type)")
              .eq("tenant_id", db.tenantId)
              .eq("journal_entry_id", id)
              .order("created_at", { ascending: true });

            if (lineError)
              return errorResult(`Failed to fetch journal lines: ${lineError.message}`);

            return jsonResult({ entry, lines: lines ?? [] }, `Journal entry: ${entry.id}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const status = params.status as string | undefined;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("journal_entries")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (status) query = query.eq("status", status);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error) return errorResult(`Failed to list journal entries: ${error.message}`);

            return jsonResult(
              { entries: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} journal entries (page ${page})`,
            );
          }

          case "post": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for post");

            const { data: existing, error: fetchError } = await db.client
              .from("journal_entries")
              .select("status")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Journal entry not found: ${fetchError.message}`);
            if (existing.status === "posted") return errorResult("Journal entry is already posted");

            const { data, error } = await db.client
              .from("journal_entries")
              .update({
                status: "posted",
                updated_at: new Date().toISOString(),
                posted_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to post journal entry: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "journal_entry",
              entity_id: id,
              action: "post",
              actor: _id,
              payload: { posted_at: data.posted_at },
            });

            return jsonResult(data, `Journal entry posted: ${id}`);
          }

          case "reverse": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for reverse");

            const { data: original, error: fetchError } = await db.client
              .from("journal_entries")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (fetchError) return errorResult(`Journal entry not found: ${fetchError.message}`);
            if (original.status !== "posted")
              return errorResult("Only posted journal entries can be reversed");

            const { data: originalLines, error: linesFetchError } = await db.client
              .from("journal_lines")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("journal_entry_id", id);

            if (linesFetchError)
              return errorResult(`Failed to fetch journal lines: ${linesFetchError.message}`);

            const now = new Date().toISOString();
            const reversalDate = (params.date as string) ?? new Date().toISOString().slice(0, 10);

            const reversalPayload = {
              tenant_id: db.tenantId,
              date: reversalDate,
              memo: `Reversal of ${id}${original.memo ? `: ${original.memo}` : ""}`,
              currency: original.currency,
              status: "draft",
              total_debit: original.total_debit,
              total_credit: original.total_credit,
              reversal_of: id,
              created_at: now,
              updated_at: now,
            };

            const { data: reversal, error: reversalError } = await db.client
              .from("journal_entries")
              .insert(reversalPayload)
              .select("*")
              .single();

            if (reversalError)
              return errorResult(`Failed to create reversal entry: ${reversalError.message}`);

            const reversalLinePayloads = (originalLines ?? []).map(
              (l: Record<string, unknown>) => ({
                tenant_id: db.tenantId,
                journal_entry_id: reversal.id,
                account_id: l.account_id,
                // Swap debit and credit
                debit: l.credit,
                credit: l.debit,
                description: l.description ?? null,
                created_at: now,
              }),
            );

            const { data: reversalLines, error: reversalLineError } = await db.client
              .from("journal_lines")
              .insert(reversalLinePayloads)
              .select("*");

            if (reversalLineError)
              return errorResult(`Failed to create reversal lines: ${reversalLineError.message}`);

            await writeAuditLog(db, {
              entity_type: "journal_entry",
              entity_id: reversal.id,
              action: "reverse",
              actor: _id,
              payload: { reversal_of: id },
            });

            return jsonResult(
              { reversal, lines: reversalLines },
              `Reversal entry created (draft): ${reversal.id} — reversal of ${id}`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, post, reverse`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
