### Changed
- RT-1463 (step 3 of the catalog split): public ports for sales and the product catalog.
  - `catalog/sales/index.ts` is the sales port that the ERP posting code imports (`SaleTendersNotVisibleError`,
    `SaleResponsibilitiesNotVisibleError`, `replaySaleReturns`).
  - New catalog reads in `catalog/product-lookups.ts`: `tenantProductVisible`, `productNamesByIds` and
    `productTrackingProfiles`.
  - `readStoreProductTracking` moves to `catalog/store-resolution/`.
  - The ERP item map, negative-on-hand and sale capture now ask catalog for those reads instead of naming
    `tenant_products`.
  - The Tracking Profile lock check reads `stock_movements` itself and asks sales whether a sale line exists
    through a new inverted port, `PRODUCT_SALE_LINES_PORT`. Sales provides it from a `@Global()` module that
    only `app.module.ts` imports. The profile lock taken before the check keeps it consistent.
  - SQL semantics, routes, existing DI tokens and behaviour are unchanged.
