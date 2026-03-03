import type { BizConfig } from "../core/config.js";
import { createBomCostCalcTool } from "./bom-cost-calc.js";
import { createBomManageTool } from "./bom-manage.js";
import { createGoodsReceiveTool } from "./goods-receive.js";
import { createInventoryCheckTool } from "./inventory-check.js";
import { createPurchaseOrderTool } from "./purchase-order.js";
import { createReorderManageTool } from "./reorder-manage.js";
import { createSupplierManageTool } from "./supplier-manage.js";
import { createSupplierQuoteTool } from "./supplier-quote.js";

export function registerProcurementTools(config: BizConfig) {
  return [
    createPurchaseOrderTool(config),
    createSupplierManageTool(config),
    createSupplierQuoteTool(config),
    createGoodsReceiveTool(config),
    createBomManageTool(config),
    createBomCostCalcTool(config),
    createInventoryCheckTool(config),
    createReorderManageTool(config),
  ];
}
