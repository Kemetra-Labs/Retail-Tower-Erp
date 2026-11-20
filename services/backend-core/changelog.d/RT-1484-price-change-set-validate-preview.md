### Added
- RT-1484 `[GATED: contract]` (RT-282 PR-10a, PR-4b), owner authorization on RT-1484 (comment
  17829 and the lead's decisions in comments 17875, 17881 and 17882): the runtime of
  `consoleValidatePriceChangeSet` and `consoleGetPriceChangeSetPreview` in
  `pricing/price-change-sets.yaml` 1.0.0-draft, which lose their `x-runtime-status:
  contract-only` markers. `validate` materializes a draft's items at the tenant's head revision
  (Book, Zone and Store scopes; item and frozen category selectors; helpers resolved from the
  inherited price, rounded half-up), reaches each line's live Stores (a Zone line through the
  memberships visible at the head, the default Zone for the rest; the per-Store instant is the
  later of the line and membership starts, in the Store's time zone for `store_local`), classifies
  each line by its most severe finding (`invalid`, `past_dated`, `replaces`, `conflicts_pending`,
  `shadowed`, `invalidates_dependent`, `new`), drops unchanged lines, and stores the 0123
  validation, lines, preview rows and Zone-membership changes with `targetStoreSetHash` and
  `previewHash` in the transaction that moves the set to `validated`. `preview` serves the stored
  Impact Preview in keyset pages with a `class` filter. A line that reaches no live Store (or an
  id the tenant does not have) refuses the set with the new `422 change_set_no_target_store`,
  added to the contract's `ValidateUnprocessable` description, naming the item's position.
  Lines of one set that overlap on one key are `invalid` (`overlaps_line_in_set`); a set over
  50 000 lines or 200 000 preview rows is `422 change_set_too_large` before any event is read
  (the description now names the preview-row budget); a helper whose base differs between its
  Stores is `invalid` (`helper_base_varies_by_store`: one line publishes one price); a line on a
  retired Zone is `422 change_set_no_target_store` (`zone_not_live`).
