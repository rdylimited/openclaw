import type { BizConfig } from "../core/config.js";
import { createDocGenerateTool } from "./doc-generate.js";
import { createDocSearchTool } from "./doc-search.js";
import { createOcrScanTool } from "./ocr-scan.js";
import { createReceiptProcessTool } from "./receipt-process.js";
import { createTemplateManageTool } from "./template-manage.js";
import { createVersionHistoryTool } from "./version-history.js";

export function registerDocumentTools(config: BizConfig) {
  return [
    createOcrScanTool(config),
    createReceiptProcessTool(config),
    createTemplateManageTool(config),
    createDocGenerateTool(config),
    createVersionHistoryTool(config),
    createDocSearchTool(config),
  ];
}
