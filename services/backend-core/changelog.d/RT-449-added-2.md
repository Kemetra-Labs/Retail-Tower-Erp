### Added
- RT-449 `[GATED]` new `inventory/inventory-safety-feed.yaml` 1.0.0-draft and
  `inventory.yaml` 1.8.0-draft (RT-50 Gate 7 F2, PR 2 of 2; authorized in RT-449
  comment 13434, rulings H5, H6, H8): the POS inventory safety feed
  (`GET /api/pos/v1/inventory-safety/snapshot` and `/deltas`, device bearer):
  every active tracking hold of the tenant as a snapshot plus a delta by
  Inventory Safety Revision, with the effective Safety TTL on every answer; a
  delta answers the current state of each hold its revision steps touched (a
  recall step expands to its holds), and `since` above the current revision is
  409 `snapshot_required`. The Safety TTL setting (`GET`/`PUT
  /api/inventory/v1/settings/safety-ttl`): 60–900 seconds, NULL = 900, set by
  owner or tenant_admin, audited; a change does not step the revision. The
  computed safety findings (`GET /api/inventory/v1/safety/findings`): every
  active hold and every expired lot still in `sellable` (judged against the
  store's local business date, sellable through the expiry date), critical;
  `expiring_lot` reserved until RT-50 B1; a store_manager sees its stores only.
  No migration. Nothing writes tracking identities until RT-453 (F6), so the
  feed and the findings stay empty until then.
