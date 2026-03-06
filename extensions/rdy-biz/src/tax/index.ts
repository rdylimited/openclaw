import type { BizConfig } from "../core/config.js";
import { createTaxCalculateTool } from "./calculate.js";
import { createFilingPrepareTool } from "./filing-prepare.js";
import { createTaxRateManageTool } from "./rate-manage.js";
import { createTaxReportTool } from "./report.js";
import { createWithholdingTrackTool } from "./withholding-track.js";

export function registerTaxTools(config: BizConfig) {
  return [
    createTaxRateManageTool(config),
    createTaxCalculateTool(config),
    createFilingPrepareTool(config),
    createWithholdingTrackTool(config),
    createTaxReportTool(config),
  ];
}
