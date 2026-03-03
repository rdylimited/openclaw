import type { BizConfig } from "../core/config.js";
import { createApprovalActionTool } from "./approval-action.js";
import { createApprovalStatusTool } from "./approval-status.js";
import { createApprovalSubmitTool } from "./approval-submit.js";
import { createRuleManageTool } from "./rule-manage.js";

export function registerWorkflowTools(config: BizConfig) {
  return [
    createApprovalSubmitTool(config),
    createApprovalActionTool(config),
    createApprovalStatusTool(config),
    createRuleManageTool(config),
  ];
}
