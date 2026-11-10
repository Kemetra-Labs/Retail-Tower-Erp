### Security
- RT-1312 (F7, RT-132 owner ratification c10674): manual stock movements, transfers and counts
  (`POST /api/inventory/v1/stores/{storeId}/movements`, `/transfers`, `/stores/{storeId}/counts`)
  now require the owner, tenant_admin or store_manager role, on top of the existing store scope.
  A store_staff member is refused with the non-disclosing 404 these operations already declare,
  and nothing is recorded. Inventory reads are unchanged. No contract change.
