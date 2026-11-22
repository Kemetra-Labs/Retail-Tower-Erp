/**
 * RT-1463 — the ERP posting side's implementation of Inventory's inverted port `TRANSFER_ERP_PORT`
 * (`inventory/shipment-transfers/transfer-erp.port.ts`). The functions are the RT-1513 transfer posting
 * reads and the leg write, unchanged (`transfer-posting.port.ts`).
 */
import type { TransferErpPort } from "../../inventory";
import {
  batchRefsOfIdentities,
  confirmedItemRefs,
  hasActiveTransitWarehouse,
  insertTransferLeg,
  postingLegStatus,
  transferWarehouseRefs,
} from "./transfer-posting.port";

export const transferErpAdapter: TransferErpPort = {
  transferWarehouseRefs,
  hasActiveTransitWarehouse,
  confirmedItemRefs,
  batchRefsOfIdentities,
  insertTransferLeg,
  postingLegStatus,
};
