import { Type } from "@sinclair/typebox";
import { writeAuditLog } from "../core/audit.js";
import { resolveBookId } from "../core/book.js";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

export function createBudgetManageTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_budget_manage",
    label: "Finance: Budget Management",
    description:
      "Create budgets, add account lines, list budgets, and compare budgeted vs actual amounts from journal entries.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("create"),
          Type.Literal("get"),
          Type.Literal("list"),
          Type.Literal("add_line"),
          Type.Literal("compare"),
        ],
        { description: "Operation to perform" },
      ),
      id: Type.Optional(
        Type.String({ description: "Budget UUID (required for get/add_line/compare)" }),
      ),
      name: Type.Optional(Type.String({ description: "Budget name (required for create)" })),
      period_start: Type.Optional(
        Type.String({ description: "Budget period start date (YYYY-MM-DD, required for create)" }),
      ),
      period_end: Type.Optional(
        Type.String({ description: "Budget period end date (YYYY-MM-DD, required for create)" }),
      ),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency code" }),
      ),
      account_id: Type.Optional(
        Type.String({ description: "Chart of accounts UUID (required for add_line)" }),
      ),
      amount: Type.Optional(
        Type.String({ description: "Budgeted amount as decimal string (required for add_line)" }),
      ),
      notes: Type.Optional(Type.String({ description: "Budget notes" })),
      book: Type.Optional(
        Type.String({
          description:
            "Book code for compare (e.g. 'statutory', 'internal'). Defaults to default book.",
        }),
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
          case "create": {
            const name = params.name as string | undefined;
            const periodStart = params.period_start as string | undefined;
            const periodEnd = params.period_end as string | undefined;
            const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

            if (!name) return errorResult("name is required for create");
            if (!periodStart) return errorResult("period_start is required for create");
            if (!periodEnd) return errorResult("period_end is required for create");
            if (periodStart >= periodEnd)
              return errorResult("period_end must be after period_start");

            const now = new Date().toISOString();

            const payload = {
              tenant_id: db.tenantId,
              name,
              period_start: periodStart,
              period_end: periodEnd,
              currency,
              notes: (params.notes as string | undefined) ?? null,
              created_at: now,
              updated_at: now,
            };

            const { data, error } = await db.client
              .from("budgets")
              .insert(payload)
              .select("*")
              .single();

            if (error) return errorResult(`Failed to create budget: ${error.message}`);

            await writeAuditLog(db, {
              entity_type: "budget",
              entity_id: data.id,
              action: "create",
              actor: _id,
              payload: { name, period_start: periodStart, period_end: periodEnd },
            });

            return jsonResult(data, `Budget created: ${name} (${periodStart} to ${periodEnd})`);
          }

          case "get": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for get");

            const { data: budget, error: budgetError } = await db.client
              .from("budgets")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (budgetError) return errorResult(`Budget not found: ${budgetError.message}`);

            const { data: lines, error: lineError } = await db.client
              .from("budget_lines")
              .select("*, account:chart_of_accounts(code, name, type)")
              .eq("tenant_id", db.tenantId)
              .eq("budget_id", id)
              .order("created_at", { ascending: true });

            if (lineError) return errorResult(`Failed to fetch budget lines: ${lineError.message}`);

            return jsonResult({ budget, lines: lines ?? [] }, `Budget: ${budget.name}`);
          }

          case "list": {
            const page = (params.page as number | undefined) ?? 1;
            const limit = (params.limit as number | undefined) ?? 25;
            const offset = (page - 1) * limit;

            const { data, error, count } = await db.client
              .from("budgets")
              .select("*", { count: "exact" })
              .eq("tenant_id", db.tenantId)
              .order("period_start", { ascending: false })
              .range(offset, offset + limit - 1);

            if (error) return errorResult(`Failed to list budgets: ${error.message}`);

            return jsonResult(
              { budgets: data ?? [], total: count ?? 0, page, limit },
              `Found ${count ?? 0} budgets (page ${page})`,
            );
          }

          case "add_line": {
            const id = params.id as string | undefined;
            const accountId = params.account_id as string | undefined;
            const amount = params.amount as string | undefined;

            if (!id) return errorResult("id is required for add_line");
            if (!accountId) return errorResult("account_id is required for add_line");
            if (!amount) return errorResult("amount is required for add_line");

            const parsedAmount = money(amount);
            if (parsedAmount.lte(0)) return errorResult("amount must be positive");

            // Verify budget exists
            const { data: budget, error: budgetError } = await db.client
              .from("budgets")
              .select("id, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (budgetError) return errorResult(`Budget not found: ${budgetError.message}`);

            // Verify account exists
            const { data: account, error: accountError } = await db.client
              .from("chart_of_accounts")
              .select("id, code, name")
              .eq("tenant_id", db.tenantId)
              .eq("id", accountId)
              .single();

            if (accountError) return errorResult(`Account not found: ${accountError.message}`);

            const now = new Date().toISOString();

            const linePayload = {
              tenant_id: db.tenantId,
              budget_id: id,
              account_id: accountId,
              amount: parsedAmount.toFixed(2),
              notes: (params.notes as string | undefined) ?? null,
              created_at: now,
              updated_at: now,
            };

            const { data: line, error: lineError } = await db.client
              .from("budget_lines")
              .insert(linePayload)
              .select("*, account:chart_of_accounts(code, name)")
              .single();

            if (lineError) return errorResult(`Failed to add budget line: ${lineError.message}`);

            return jsonResult(
              line,
              `Budget line added: ${account.code} ${account.name} — ${parsedAmount.toFixed(2)} to budget "${budget.name}"`,
            );
          }

          case "compare": {
            const id = params.id as string | undefined;
            if (!id) return errorResult("id is required for compare");

            const { data: budget, error: budgetError } = await db.client
              .from("budgets")
              .select("*")
              .eq("tenant_id", db.tenantId)
              .eq("id", id)
              .single();

            if (budgetError) return errorResult(`Budget not found: ${budgetError.message}`);

            const { data: budgetLines, error: lineError } = await db.client
              .from("budget_lines")
              .select("*, account:chart_of_accounts(id, code, name, type)")
              .eq("tenant_id", db.tenantId)
              .eq("budget_id", id);

            if (lineError) return errorResult(`Failed to fetch budget lines: ${lineError.message}`);

            if (!budgetLines || budgetLines.length === 0) {
              return jsonResult(
                { budget, comparison: [] },
                `Budget "${budget.name}" has no lines to compare`,
              );
            }

            const accountIds = budgetLines.map(
              (l: Record<string, unknown>) => l.account_id as string,
            );

            // Resolve book for filtering
            const bookCode = params.book as string | undefined;
            const bookId = await resolveBookId(db, bookCode);

            // Fetch actual amounts from journal_lines for the budget period
            // Bug fix: removed .eq("tenant_id", db.tenantId) on journal_lines
            // — tenant isolation comes through the journal_entries join
            let actualQuery = db.client
              .from("journal_lines")
              .select(
                "account_id, debit, credit, journal_entry:journal_entries!journal_entry_id(date, status, book_id)",
              )
              .in("account_id", accountIds)
              .gte("journal_entry.date", budget.period_start)
              .lte("journal_entry.date", budget.period_end)
              .eq("journal_entry.status", "posted")
              .eq("journal_entry.tenant_id", db.tenantId);

            if (bookId) {
              actualQuery = actualQuery.eq("journal_entry.book_id", bookId);
            }

            const { data: actualLines, error: actualError } = await actualQuery;

            if (actualError)
              return errorResult(`Failed to fetch actual amounts: ${actualError.message}`);

            // Group actual amounts by account_id
            const actualByAccount: Record<string, { debit: string; credit: string }[]> = {};
            for (const line of actualLines ?? []) {
              const accountId = line.account_id as string;
              if (!actualByAccount[accountId]) actualByAccount[accountId] = [];
              actualByAccount[accountId].push({ debit: line.debit, credit: line.credit });
            }

            const comparison = budgetLines.map((bl: Record<string, unknown>) => {
              const acctId = bl.account_id as string;
              const acctInfo = bl.account as Record<string, unknown>;
              const lines = actualByAccount[acctId] ?? [];
              const totalDebits = sumMoney(lines.map((l) => l.debit ?? "0"));
              const totalCredits = sumMoney(lines.map((l) => l.credit ?? "0"));

              // For expense/asset accounts: net = debits - credits (debit normal)
              // For revenue/liability/equity accounts: net = credits - debits (credit normal)
              const isDebitNormal = ["expense", "asset"].includes(acctInfo.type as string);
              const actualNet = isDebitNormal
                ? totalDebits.minus(totalCredits)
                : totalCredits.minus(totalDebits);

              const budgeted = money(bl.amount as string);
              const variance = budgeted.minus(actualNet);
              const variancePct = budgeted.isZero()
                ? null
                : variance.div(budgeted).times(100).toFixed(2);

              return {
                account_id: acctId,
                account_code: acctInfo.code,
                account_name: acctInfo.name,
                account_type: acctInfo.type,
                budgeted: budgeted.toFixed(2),
                actual: actualNet.toFixed(2),
                variance: variance.toFixed(2),
                variance_pct: variancePct,
                over_budget: variance.lt(0),
              };
            });

            const totalBudgeted = sumMoney(comparison.map((c) => c.budgeted));
            const totalActual = sumMoney(comparison.map((c) => c.actual));
            const totalVariance = totalBudgeted.minus(totalActual);

            return jsonResult(
              {
                budget,
                comparison,
                totals: {
                  budgeted: totalBudgeted.toFixed(2),
                  actual: totalActual.toFixed(2),
                  variance: totalVariance.toFixed(2),
                },
              },
              `Budget comparison for "${budget.name}": ${comparison.length} accounts compared`,
            );
          }

          default:
            return errorResult(
              `Unknown action: ${action}. Must be one of: create, get, list, add_line, compare`,
            );
        }
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
