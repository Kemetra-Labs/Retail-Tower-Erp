### Changed
- RT-1058 (docs, `[GATED]`): wording of `console-sales-by-store.openapi.yaml` only, no wire change.
  A `not_begun` day has zero figures unless sales are stored for that date (the store's timezone
  moved west, or a terminal clock ran ahead), so a store's days always add up to its total
  (owner decision on RT-1053, 2026-11-01). The Posture paragraph now says the runtime serves the
  path since RT-1053 instead of "contract-only".
