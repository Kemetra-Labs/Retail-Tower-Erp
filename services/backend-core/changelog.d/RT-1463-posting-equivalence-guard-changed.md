### Changed
- RT-1463: a before/after guard for the coming ERP posting read-port refactor. There is no behaviour change.
  - `test/catalog/erpnext-posting/__support__/legacy/` holds frozen copies of `buildWorkItem` (with
    `return-promotion-shares.ts`) and of the repair eligibility check. It also holds the exact SQL text of
    the feed page query and of the operator resolution freeze.
  - `test/_helpers/posting-equivalence.setup.ts` (jest `setupFilesAfterEnv`) runs each guarded read twice
    on the same real Postgres client, once live and once with its frozen copy. The spec fails if the result
    (order, nulls and duplicates included) or the thrown error differs.
  - `posting-sql-frozen.unit.spec.ts` fails if the two single-snapshot statements change by one character.
  - `posting-equivalence.cases.spec.ts` seeds the fixed cases: a live sale, a missing item map, a void, a
    legacy refund, frozen resolution versions 1 and 2, and repair eligibility.
  - The return, responsibility, tracking and tender specs each assert that the guard compared at least one
    result.
  - Two source changes make this testable without changing what runs: the feed page SQL becomes the
    exported constant `POSTING_FEED_PAGE_SQL` (same text), and the repair eligibility query moves to
    `erpnext-reconciliation/sale-lines-mapped.ts`.
  - Remove the guard when RT-1463 closes.
