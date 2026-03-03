import { Type } from "@sinclair/typebox";
import type { BizConfig } from "../core/config.js";
import { money, sumMoney } from "../core/money.js";
import { createTenantClient } from "../core/supabase.js";
import { type ToolResult, jsonResult, errorResult } from "../core/types.js";

type AccountBalance = {
  account_id: string;
  code: string;
  name: string;
  type: string;
  balance: string;
};

type PeriodAccountBalance = AccountBalance & {
  balance_comparison?: string;
};

async function computeAccountBalances(
  db: ReturnType<typeof createTenantClient>,
  asOfDate: string,
): Promise<PeriodAccountBalance[]> {
  // Fetch all posted journal lines up to as_of_date joined to accounts
  const { data, error } = await db.client
    .from("journal_lines")
    .select(
      "account_id, debit, credit, account:chart_of_accounts!account_id(code, name, type), journal_entry:journal_entries!journal_entry_id(date, status)",
    )
    .eq("tenant_id", db.tenantId)
    .lte("journal_entry.date", asOfDate)
    .eq("journal_entry.status", "posted");

  if (error) throw new Error(`Failed to fetch journal lines: ${error.message}`);

  // Group by account
  const grouped: Record<
    string,
    { code: string; name: string; type: string; debits: string[]; credits: string[] }
  > = {};

  for (const line of data ?? []) {
    const acctId = line.account_id as string;
    const acct = line.account as Record<string, unknown>;
    if (!grouped[acctId]) {
      grouped[acctId] = {
        code: acct.code as string,
        name: acct.name as string,
        type: acct.type as string,
        debits: [],
        credits: [],
      };
    }
    grouped[acctId].debits.push((line.debit as string) ?? "0");
    grouped[acctId].credits.push((line.credit as string) ?? "0");
  }

  return Object.entries(grouped).map(([accountId, info]) => {
    const totalDebits = sumMoney(info.debits);
    const totalCredits = sumMoney(info.credits);

    // Debit-normal: assets, expenses — balance = debits - credits
    // Credit-normal: liabilities, equity, revenue — balance = credits - debits
    const isDebitNormal = ["asset", "expense"].includes(info.type);
    const balance = isDebitNormal
      ? totalDebits.minus(totalCredits)
      : totalCredits.minus(totalDebits);

    return {
      account_id: accountId,
      code: info.code,
      name: info.name,
      type: info.type,
      balance: balance.toFixed(2),
    };
  });
}

export function createBalanceSheetTool(config: BizConfig) {
  const db = createTenantClient(config);

  return {
    name: "fin_balance_sheet",
    label: "Finance: Balance Sheet",
    description:
      "Generate a balance sheet report as of a given date, grouping accounts by type (assets, liabilities, equity). Optionally compare against a second date.",
    parameters: Type.Object({
      as_of_date: Type.String({
        description: "Report date (YYYY-MM-DD) — balances calculated up to this date",
      }),
      comparison_date: Type.Optional(
        Type.String({
          description: "Optional comparison date (YYYY-MM-DD) — shows two periods side-by-side",
        }),
      ),
      currency: Type.Optional(
        Type.String({ minLength: 3, maxLength: 3, description: "ISO 4217 currency for display" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
      const asOfDate = params.as_of_date as string | undefined;
      const comparisonDate = params.comparison_date as string | undefined;
      const currency = (params.currency as string | undefined) ?? config.defaultCurrency;

      if (!asOfDate) return errorResult("as_of_date is required");

      try {
        const currentBalances = await computeAccountBalances(db, asOfDate);

        let comparisonBalances: PeriodAccountBalance[] | null = null;
        if (comparisonDate) {
          comparisonBalances = await computeAccountBalances(db, comparisonDate);
        }

        // Merge comparison balances into current if provided
        const mergedBalances: PeriodAccountBalance[] = currentBalances.map((b) => {
          if (!comparisonBalances) return b;
          const comp = comparisonBalances.find((c) => c.account_id === b.account_id);
          return { ...b, balance_comparison: comp?.balance ?? "0.00" };
        });

        // Also add accounts present in comparison but not in current
        if (comparisonBalances) {
          for (const comp of comparisonBalances) {
            if (!mergedBalances.find((m) => m.account_id === comp.account_id)) {
              mergedBalances.push({
                ...comp,
                balance_comparison: comp.balance,
                balance: "0.00",
              });
            }
          }
        }

        // Group by account type
        const assets = mergedBalances.filter((b) => b.type === "asset");
        const liabilities = mergedBalances.filter((b) => b.type === "liability");
        const equity = mergedBalances.filter((b) => b.type === "equity");

        // Sort each group by code
        const sortByCode = (a: AccountBalance, b: AccountBalance) => a.code.localeCompare(b.code);
        assets.sort(sortByCode);
        liabilities.sort(sortByCode);
        equity.sort(sortByCode);

        const totalAssets = sumMoney(assets.map((a) => a.balance));
        const totalLiabilities = sumMoney(liabilities.map((l) => l.balance));
        const totalEquity = sumMoney(equity.map((e) => e.balance));
        const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);
        const isBalanced = money(totalAssets.toFixed(2)).equals(
          money(totalLiabilitiesAndEquity.toFixed(2)),
        );

        const totals: Record<string, string> = {
          total_assets: totalAssets.toFixed(2),
          total_liabilities: totalLiabilities.toFixed(2),
          total_equity: totalEquity.toFixed(2),
          total_liabilities_and_equity: totalLiabilitiesAndEquity.toFixed(2),
          balanced: isBalanced ? "yes" : "no (check for unposted entries or missing accounts)",
        };

        if (comparisonDate && comparisonBalances) {
          const compAssets = comparisonBalances.filter((b) => b.type === "asset");
          const compLiabilities = comparisonBalances.filter((b) => b.type === "liability");
          const compEquity = comparisonBalances.filter((b) => b.type === "equity");

          totals.comparison_total_assets = sumMoney(compAssets.map((a) => a.balance)).toFixed(2);
          totals.comparison_total_liabilities = sumMoney(
            compLiabilities.map((l) => l.balance),
          ).toFixed(2);
          totals.comparison_total_equity = sumMoney(compEquity.map((e) => e.balance)).toFixed(2);
        }

        const report = {
          report: "Balance Sheet",
          as_of_date: asOfDate,
          comparison_date: comparisonDate ?? null,
          currency,
          assets,
          liabilities,
          equity,
          totals,
        };

        const summary = comparisonDate
          ? `Balance Sheet as of ${asOfDate} vs ${comparisonDate} — Assets: ${currency} ${totalAssets.toFixed(2)}, Liabilities: ${currency} ${totalLiabilities.toFixed(2)}, Equity: ${currency} ${totalEquity.toFixed(2)}`
          : `Balance Sheet as of ${asOfDate} — Assets: ${currency} ${totalAssets.toFixed(2)}, Liabilities: ${currency} ${totalLiabilities.toFixed(2)}, Equity: ${currency} ${totalEquity.toFixed(2)}`;

        return jsonResult(report, summary);
      } catch (err) {
        return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
