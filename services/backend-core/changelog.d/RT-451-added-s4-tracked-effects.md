### Added
- RT-451 slice S4, tracked effects (RT-50 G7-9, G7-10, Q9): the sale, void and return
  Inventory Effect writers read the classification capture stored (S3), never the live
  tracked-selling switch. A `batch` line classified `valid` or `flagged` (G7-9 rows 1 to 3)
  moves `-q` at the store's primary location, `sellable`, at its tracking identity
  (`stock_movements.tracking_identity_id`). A `tracking_unresolved` sale is processed with no
  effect on any line and no `sale_post` intent, and its void or return writes no restore while
  it has no effect. A void compensates the exact identity position. A return line takes the
  identity of the original effect and lands in `return_inspection` whatever the landing policy,
  or in `recall_hold` when the identity has ever been under a recall hold (owner answer
  2026-11-11, RT-451 comment 16538); it locks the identities FOR KEY SHARE before reading the
  recall state, so a recall in flight is seen. Serial lines and lines captured while tracked
  selling was off stay skipped as `tracked_product`. No migration and no contract change.
  Tracked selling stays off: no tenant can switch it on in this build.
