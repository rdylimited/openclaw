import type { BizConfig } from "../core/config.js";
import { createAssetManageTool } from "./asset-manage.js";
import { createDeliveryNoteTool } from "./delivery-note.js";
import { createReservationAvailabilityTool } from "./reservation-availability.js";
import { createReservationManageTool } from "./reservation-manage.js";
import { createShipmentTrackTool } from "./shipment-track.js";
import { createWarehouseManageTool } from "./warehouse-manage.js";

export function registerOperationsTools(config: BizConfig) {
  return [
    createShipmentTrackTool(config),
    createDeliveryNoteTool(config),
    createReservationManageTool(config),
    createReservationAvailabilityTool(config),
    createAssetManageTool(config),
    createWarehouseManageTool(config),
  ];
}
