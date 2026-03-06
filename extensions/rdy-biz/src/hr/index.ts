import type { BizConfig } from "../core/config.js";
import { createAttendanceLogTool } from "./attendance-log.js";
import { createContractManageTool } from "./contract-manage.js";
import { createEmployeeManageTool } from "./employee-manage.js";
import { createExpenseClaimTool } from "./expense-claim.js";
import { createLeaveManageTool } from "./leave-manage.js";
import { createPayrollRunTool } from "./payroll-run.js";
import { createPayslipGenerateTool } from "./payslip-generate.js";

export function registerHrTools(config: BizConfig) {
  return [
    createEmployeeManageTool(config),
    createContractManageTool(config),
    createPayrollRunTool(config),
    createPayslipGenerateTool(config),
    createLeaveManageTool(config),
    createAttendanceLogTool(config),
    createExpenseClaimTool(config),
  ];
}
