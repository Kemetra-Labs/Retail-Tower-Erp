/**
 * The public surface of `inventory` (RT-1453): the only file other api modules import (besides
 * `inventory.module.ts`). Everything else in this directory is internal. Add an export here when
 * another module needs it; a port that touches the database takes the caller's `PoolClient`.
 * `tools/module-boundaries` enforces this.
 */
export { countOpenCountSessionsOfStore, listOpenCountSessionsOfStore } from "./store-count-sessions";
/**
 * RT-1513: the dispatch of a shipment Transfer was just confirmed by its `posted` ack. Release the receipt legs that were
 * waiting for it (each receipt's work item is created only once its dispatch is confirmed). Runs on the ack's client, in
 * the ack's transaction, with the tenant's feed sequence lock already held.
 */
export { releaseReceiptLegs as releaseTransferReceiptLegs } from "./shipment-transfers/shipment-transfer.posting";
/**
 * RT-1513: the frozen wire bodies of the two transfer ERP legs (posting-feed.yaml 1.17.0-draft). The feed projection
 * rebuilds a leg from its frozen rows with the same functions emission hashed it with, so the offered item always
 * matches its stored `payloadHash`.
 */
export { dispatchBody as transferDispatchBody, receiveBody as transferReceiveBody } from "./shipment-transfers/shipment-transfer.rules";
/**
 * RT-1513: the frozen head and lines of one transfer leg, read by the posting feed projection (catalog) so that it names no
 * inventory table itself.
 */
export { loadTransferLeg } from "./shipment-transfers/shipment-transfer.feed";
/**
 * RT-1517: the legacy instant-transfer legs still `not_posted` (the ERPNext drift they left), read by the operator drift
 * report CLI. Read only, on the caller's client.
 */
export { listLegacyTransferDrift, type LegacyTransferDriftRow } from "./shipment-transfers/legacy-transfer-drift";
/**
 * RT-1516: the raw facts of the delayed-transfer health alert (open Transfer ages, the tenant threshold and the transfer
 * work items not yet confirmed), read by `console-system-status` on its guarded query, under the tenant's RLS.
 */
export {
  readShipmentTransferHealth,
  type HealthQuery,
  type ShipmentTransferHealthRaw,
} from "./shipment-transfers/shipment-transfer.health";
/**
 * RT-1463: the tracked-selling gate (deployment flag AND the tenant's switch in `tenant_inventory_settings`), read by
 * sale capture, the posting feed and the Tracking Profile setter on the caller's client.
 */
export { isTrackedSellingEnabled, readTrackedSellingOn } from "./tracked-selling/tracked-selling-gate";
/** RT-1463: the append-only `sale_line_findings` writer, used by sale capture on its own transaction client. */
export { writeSaleLineFindings } from "./tracking-resolution/sale-line-findings.writer";
/**
 * RT-1463: what the shipment Transfer emission needs from the ERP posting side, as an inverted port. The ERP posting side
 * provides `TRANSFER_ERP_PORT` from a `@Global()` module that only `app.module.ts` imports.
 */
export {
  TRANSFER_ERP_PORT,
  type TransferErpPort,
  type TransferWarehouseRefs,
} from "./shipment-transfers/transfer-erp.port";
