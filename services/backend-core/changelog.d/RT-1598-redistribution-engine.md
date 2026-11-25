### Added
- RT-1598 (W9 N1, post-pilot): the stage-1 redistribution engine and its independent validator, a pure
  TypeScript module under `apps/api/src/inventory/redistribution/` with no I/O, no endpoint and no dependency.
  The rule `reorder_gap_greedy` (RT-1596 P-1, P-9, P-10) proposes store-to-store moves:
  - surplus = ATS − reorder level − buffer − open outbound drafts;
  - deficit = reorder level − ATS − open inbound;
  - exact numeric(19,4) arithmetic;
  - deterministic;
  - capped and deadline-checked, with no partial results.

  A separate validator recomputes everything from the raw rows. The module is not wired to any endpoint
  yet: RT-1599 (contract) and RT-1600 (runtime) consume it.
