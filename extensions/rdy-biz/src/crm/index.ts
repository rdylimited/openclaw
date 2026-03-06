import type { BizConfig } from "../core/config.js";
import { createCompanyManageTool } from "./company-manage.js";
import { createContactExportTool } from "./contact-export.js";
import { createContactManageTool } from "./contact-manage.js";
import { createContactMergeTool } from "./contact-merge.js";
import { createContactSearchTool } from "./contact-search.js";

export function registerCrmTools(config: BizConfig) {
  return [
    createContactManageTool(config),
    createCompanyManageTool(config),
    createContactSearchTool(config),
    createContactMergeTool(config),
    createContactExportTool(config),
  ];
}
