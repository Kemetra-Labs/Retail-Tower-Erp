### Added
- RT-1574: the tenant's ERPNext transit warehouse can now be mapped. Three
  owner / tenant_admin operations in `catalog/erpnext-warehouse-map.yaml`
  1.2.0-draft (additive): `GET` and `POST /api/v1/catalog/erpnext-transit-warehouse-mapping`
  and `POST .../{id}/retire`, on their own `ErpnextTransitWarehouseMapping`
  schema (no store). They write the `purpose = 'transit'` row of migration 0125
  (one active per tenant), which shipment transfers need before they can be
  switched on (`transit_warehouse_unmapped`). The 014 store-mapping list leaves
  the transit row out and the 014 retire answers 404 for it, so their schema is
  unchanged.
