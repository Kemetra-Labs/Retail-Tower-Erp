### Fixed
- RT-1536 `[GATED: contract]` follow-up (spec 049 S5b): the import plan appends the row numbers of a
  product's rows in place instead of copying the list per row (quadratic on a product many rows share), in
  both the plan and the explicit-value read. Contract text only: `conflictCount` counts conflict entries (one
  per product and reason, and per field for a disagreement). No schema change.
