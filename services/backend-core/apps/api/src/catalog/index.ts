/**
 * The public surface of `catalog` (RT-1453): the only file other api modules import (besides
 * `catalog.module.ts`). Everything else in this directory is internal. Add an export here when
 * another module needs it; a port that touches the database takes the caller's `PoolClient`.
 * `tools/module-boundaries` enforces this.
 */
export { listActiveWarehouseRefsOfStore } from "./erpnext-warehouse-map/store-warehouse-refs";
export {
  batchRefsOfIdentities,
  confirmedItemRefs,
  hasActiveTransitWarehouse,
  insertTransferLeg,
  postingLegStatus,
  trackingModesOfProducts,
  transferWarehouseRefs,
} from "./erpnext-posting/transfer-posting.port";
export { isTenantProduct } from "./product-lookups";
