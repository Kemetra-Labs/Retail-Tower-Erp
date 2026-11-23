/**
 * The public surface of `catalog` (RT-1453): the only file other api modules import (besides
 * `catalog.module.ts`). Everything else in this directory is internal. Add an export here when
 * another module needs it; a port that touches the database takes the caller's `PoolClient`.
 * `tools/module-boundaries` enforces this.
 */
export { listActiveWarehouseRefsOfStore } from "./erpnext-warehouse-map/store-warehouse-refs";
export {
  isTenantProduct,
  liveProductsOfCategories,
  tenantProductLiveness,
  trackingModesOfProducts,
} from "./product-lookups";
export { catalogChangeLogHead, legacyPriceHistoryCount, readLegacyPrices } from "./legacy-price-reads";
export { lockProductProfiles } from "./tracking-profile/tracking-profile-lock";
export { readStoreProductTracking, type StoreProductTracking } from "./store-resolution/store-product-tracking";
export { productNamesByIds, productTrackingProfiles, tenantProductVisible } from "./product-lookups";
export { PRODUCT_SALE_LINES_PORT, type ProductSaleLinesPort } from "./tracking-profile/product-sale-lines.port";
/**
 * RT-1577: one keyset page of a store's sellable catalogue with each product's low-stock level, read by the POS
 * availability snapshot (inventory) on the caller's client. The same product set as the catalogue read-down.
 */
export { readStoreSellablePage } from "./store-resolution/store-sellable-page";
