import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import type { BizConfig } from "../core/config.js";
import { money } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type BankTransaction = {
  date: string;
  description: string;
  amount: string;
  type: "debit" | "credit";
  reference?: string;
};

export function createBankReconcileTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_bank_reconcile",
    label: "Finance: Bank Reconciliation",
    description:
      "Import bank transactions, list unreconciled items, match to journal entries, and mark as reconciled.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("import_transactions"),
          Type.Literal("list_unreconciled"),
          Type.Literal("match"),
          Type.Literal("reconcile"),
        ],
        { description: "Operation to perform" },
      ),
      bank_account_id: Type.Optional(Type.String({ description: "Bank account UUID" })),
      transaction_id: Type.Optional(
        Type.String({ description: "Bank transaction UUID (required for match/reconcile)" }),
      ),
      journal_entry_id: Type.Optional(
        Type.String({ description: "Journal entry UUID to match against (required for match)" }),
      ),
      transactions: Type.Optional(
        Type.Array(
          Type.Object({
            date: Type.String({ description: "Transaction date (YYYY-MM-DD)" }),
            description: Type.String({ description: "Transaction description" }),
            amount: Type.String({ description: "Amount as decimal string (positive)" }),
            type: Type.Union([Type.Literal("debit"), Type.Literal("credit")], {
              description: "debit = money out, credit = money in",
            }),
            reference: Type.Optional(Type.String({ description: "Bank reference number" })),
          }),
          { description: "Bank transactions to import (for import_transactions)" },
        ),
      ),
      date_from: Type.Optional(
        Type.String({ description: "Start date filter for list_unreconciled (YYYY-MM-DD)" }),
      ),
      date_to: Type.Optional(
        Type.String({ description: "End date filter for list_unreconciled (YYYY-MM-DD)" }),
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
          case "import_transactions": {
            const bankAccountId = params.bank_account_id as string | undefined;
            const transactions = params.transactions as BankTransaction[] | undefined;

            if (!bankAccountId)
              return errorResult("bank_account_id is required for import_transactions");
            if (!transactions || transactions.length === 0) {
              return errorResult("transactions is required and must not be empty");
            }

            // Verify bank account belongs to tenant
            const { data: account, error: accountError } = await db.client
              .from("bank_accounts")
              .select("id, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", bankAccountId)
              .single();

            if (accountError) return errorResult(`Bank account not found: ${accountError.message}`);

            const now = new Date().toISOString();

            const transactionPayloads = transactions.map((t) => ({
              tenant_id: db.tenantId,
              bank_account_id: bankAccountId,
              date: t.date,
              description: t.description,
              amount: money(t.amount).toFixed(2),
              type: t.type,
              reference: t.reference ?? null,
              reconciled: false,
              matched_journal_id: null,
              created_at: now,
            }));

            const { data: inserted, error: insertError } = await db.client
              .from("bank_transactions")
              .insert(transactionPayloads)
              .select("*");

            if (insertError)
              return errorResult(`Failed to import transactions: ${insertError.message}`);

            await writeAuditLog(db, {
              entity_type: "bank_account",
              entity_id: bankAccountId,
              action: "update",
              actor: _id,
              payload: { imported_count: transactions.length },
            });

            return jsonResult(
              { imported: inserted?.length ?? 0, bank_account: account.name },
              `Imported ${inserted?.length ?? 0} transactions to ${account.name}`,
            );
          }

          case "list_unreconciled": {
            const bankAccountId = params.bank_account_id as string | undefined;
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;
            const dateFrom = params.date_from as string | undefined;
            const dateTo = params.date_to as string | undefined;

            let query = db.client
              .from("bank_transactions")
              .select("*, bank_account:bank_accounts(name)", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .eq("reconciled", false)
              .order("date", { ascending: false })
              .range(offset, offset + limit - 1);

            if (bankAccountId) query = query.eq("bank_account_id", bankAccountId);
            if (dateFrom) query = query.gte("date", dateFrom);
            if (dateTo) query = query.lte("date", dateTo);

            const { data, error, count } = await query;

            if (error)
              return errorResult(`Failed to list unreconciled transactions: ${error.message}`);

            return jsonResult(
              { transactions: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} unreconciled transactions`,
            );
          }

          case "match": {
            const transactionId = params.transaction_id as string | undefined;
            const journalEntryId = params.journal_entry_id as string | undefined;

            if (!transactionId) return errorResult("transaction_id is required for match");
            if (!journalEntryId) return errorResult("journal_entry_id is required for match");

            // Verify transaction belongs to tenant
            const { data: txn, error: txnError } = await db.client
              .from("bank_transactions")
              .select("id, reconciled")
              .eq("tenant_id", db.tenantId)
              .eq("id", transactionId)
              .single();

            if (txnError) return errorResult(`Transaction not found: ${txnError.message}`);
            if (txn.reconciled) return errorResult("Transaction is already reconciled");

            // Verify journal entry belongs to tenant
            const { data: je, error: jeError } = await db.client
              .from("journal_entries")
              .select("id, status")
              .eq("tenant_id", db.tenantId)
              .eq("id", journalEntryId)
              .single();

            if (jeError) return errorResult(`Journal entry not found: ${jeError.message}`);

            const { data, error } = await db.client
              .from("bank_transactions")
              .update({
                matched_journal_id: journalEntryId,
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", transactionId)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to match transaction: ${error.message}`);

            return jsonResult(
              data,
              `Transaction matched to journal entry: ${journalEntryId} (status: ${je.status})`,
            );
          }

          case "reconcile": {
            const transactionId = params.transaction_id as string | undefined;
            if (!transactionId) return errorResult("transaction_id is required for reconcile");

            const { data: txn, error: txnError } = await db.client
              .from("bank_transactions")
              .select("id, reconciled, matched_journal_id")
              .eq("tenant_id", db.tenantId)
              .eq("id", transactionId)
              .single();

            if (txnError) return errorResult(`Transaction not found: ${txnError.message}`);
            if (txn.reconciled) return errorResult("Transaction is already reconciled");

            const { data, error } = await db.client
              .from("bank_transactions")
              .update({
                reconciled: true,
                reconciled_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("tenant_id", db.tenantId)
              .eq("id", transactionId)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to reconcile transaction: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "bank_transaction",
              entity_id: transactionId,
              action: "approve",
              actor: _id,
              payload: { reconciled: true, matched_journal_id: data.matched_journal_id },
            });

            return jsonResult(data, `Transaction reconciled: ${transactionId}`);
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: import_transactions, list_unreconciled, match, reconcile`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
