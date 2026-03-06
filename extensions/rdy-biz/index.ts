import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { BizConfigSchema } from "./src/core/config.js";
import { registerCrmTools } from "./src/crm/index.js";
import { registerDocumentTools } from "./src/documents/index.js";
import { registerFinanceTools } from "./src/finance/index.js";
import { registerHrTools } from "./src/hr/index.js";
import { registerOperationsTools } from "./src/operations/index.js";
import { registerProcurementTools } from "./src/procurement/index.js";
import { registerTaxTools } from "./src/tax/index.js";
import { registerWorkflowTools } from "./src/workflow/index.js";

const bizPlugin = {
  id: "rdy-biz",
  name: "RDY Business Suite",
  description:
    "Business operations: CRM, documents, finance, procurement, operations, HR, tax, workflows (54 tools)",
  configSchema: BizConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = BizConfigSchema.parse(api.pluginConfig);
    api.logger.info(`[rdy-biz] Registering tools for tenant ${config.tenantId}`);

    const allTools = [
      ...registerCrmTools(config),
      ...registerDocumentTools(config),
      ...registerFinanceTools(config),
      ...registerProcurementTools(config),
      ...registerOperationsTools(config),
      ...registerHrTools(config),
      ...registerTaxTools(config),
      ...registerWorkflowTools(config),
    ];

    for (const tool of allTools) {
      api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
    }

    api.logger.info(`[rdy-biz] Registered ${allTools.length} tools`);
  },
};

export default bizPlugin;
