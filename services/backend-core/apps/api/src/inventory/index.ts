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
