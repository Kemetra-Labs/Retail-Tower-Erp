### Changed
- RT-1453: store deletion (preview and write) reads a store's active ERPNext warehouse mappings through a new `catalog`
  port (`listActiveWarehouseRefsOfStore`), its single-store members through a new `memberships` port
  (`listSpecificAccessMembersOfStore`; "only live store" is decided against the `stores` table in `stores/`), and its Offer
  Pack footprint through a new `offers` port (`countOffersInPackOfStore`), all on the caller's client. The deletion write
  reaches `rebuildOfferPackForStoreChange` through `offers/index.ts` instead of a deep import. `stores/deletion` no longer
  names `erpnext_warehouse_map`, `memberships`, `roles`, `store_access` or `offer_pack_eligible_products`. No HTTP
  contract change.
