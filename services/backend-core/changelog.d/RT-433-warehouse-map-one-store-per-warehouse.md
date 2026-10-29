### Changed
- RT-433 `[GATED]`, owner approval by RT-290 comment 11717 Q4: one ERPNext
  Warehouse may be mapped by at most one store (RT-290 M-2/M-3).
  - Migration 0075 first checks the data and fails with the tenant, Warehouse
    ref and every store:purpose when an active ref is held more than once; it
    never picks a winner. It then replaces the non-unique
    `idx_erpnext_warehouse_map_ref` with the unique
    `UQ_idx_erpnext_warehouse_map_ref_active`. Retired mappings do not count.
  - Setting a mapping to a Warehouse another active mapping holds returns
    409 `conflict` with its own message.
  - The posting precondition now requires an active `stock` warehouse map,
    the same purpose the resolution freeze joins, so a store with only a
    `returns` map is `permanently_rejected` / `unmapped_store` at creation
    instead of failing to freeze and retrying.
