### Changed
- RT-1463 (step 2 of the catalog split): sale code and inventory stop importing each other's internals.
  - The tracked-selling gate (`isTrackedSellingEnabled`, plus `readTrackedSellingOn`, which reads
    `tenant_inventory_settings`) moves to `inventory/tracked-selling/` and is exported from
    `inventory/index.ts`.
  - `isEnvFlagOn` moves to `common/env-flag.ts`.
  - The `sale_line_findings` writer moves to `inventory/tracking-resolution/`, and the module map now
    gives `sale_line_findings` to `inventory`, which reads and writes it.
  - The Tracking Profile lock `lockProductProfiles` moves to `catalog/tracking-profile/`.
  - Shipment Transfer emission now reaches the ERP posting tables through a new inverted port,
    `TRANSFER_ERP_PORT` (`inventory/shipment-transfers/transfer-erp.port.ts`). The ERP posting side
    implements it and provides it from a `@Global()` module that only `app.module.ts` imports.
  - `trackingModesOfProducts` moves to `catalog/product-lookups.ts`.
  - SQL, routes, existing DI tokens and behaviour are unchanged. The module-boundaries baseline shrinks
    by 5 lines.
