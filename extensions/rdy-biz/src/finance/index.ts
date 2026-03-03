import type { BizConfig } from "../core/config.js";
import { createBalanceSheetTool } from "./balance-sheet.js";
import { createBankReconcileTool } from "./bank-reconcile.js";
import { createBillManageTool } from "./bill-manage.js";
import { createBudgetManageTool } from "./budget-manage.js";
import { createChartOfAccountsTool } from "./chart-of-accounts.js";
import { createCreditNoteTool } from "./credit-note.js";
import { createInvoiceManageTool } from "./invoice-manage.js";
import { createJournalEntryTool } from "./journal-entry.js";
import { createPaymentRecordTool } from "./payment-record.js";
import { createQuotationManageTool } from "./quotation-manage.js";

export function registerFinanceTools(config: BizConfig) {
  return [
    createChartOfAccountsTool(config),
    createJournalEntryTool(config),
    createInvoiceManageTool(config),
    createBillManageTool(config),
    createQuotationManageTool(config),
    createPaymentRecordTool(config),
    createBankReconcileTool(config),
    createCreditNoteTool(config),
    createBudgetManageTool(config),
    createBalanceSheetTool(config),
  ];
}
