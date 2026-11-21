### Added
- RT-1544 `[GATED: contract]`, owner approval on RT-1544 comment 18145 (RP-1 of
  `specs/045-return-policy`, owner decisions OD-272-1..11 of RT-272 comment
  12791): OpenAPI contract `return-policy.openapi.yaml` (1.0.0-draft,
  contract-only). It defines the versioned tenant Return Policy: the
  cookie-session Console read of the effective policy, the revision list and
  the idempotent publish (`windowDays` 0 to 365, `excludedCategoryIds`,
  `expectedRevisionId`, a required `reason`; owner / tenant_admin), and the
  online `GET /api/pos/v1/sales/{saleRef}/return-eligibility` read (operator
  envelope, like `readSale`; from RP-3 behind `POS_RETURNS_ENABLED` like
  `recordReturn`). `pos-sales/sales.yaml` 1.27.0-draft adds an optional line
  `reasonCode` (the closed catalogue `defective`, `wrong_item`,
  `not_as_described`, `changed_mind`, `other`) and `reasonNote` on
  `recordReturn` through a new `RecordReturnLineRequest`
  (`recordCreditSaleReversal` keeps `ReturnLineRequest`), the three 422 codes
  `return_window_expired`, `return_line_not_returnable` (carrying `lineRef` and
  `reason`) and `return_reason_invalid` (`other` without a note, or a note
  without a code), and an optional `SaleReturn.returnPolicy` (`revisionId`,
  `source`, `windowEndsOn`, `legalFloorDays`). The legal floor is the owner's
  value and is in no contract: `legalFloorDays` is `integer | null` (null means
  not set yet: no System window, `windowDays` and `windowEndsOn` null, a publish
  skips the floor check), and returns must not be enabled in production until it
  is set. Strictly additive; no runtime, migration, POS or Console change, and
  enforcement stays off. Rollout: Backend-Core (RP-3) before the POS (RP-4).
  RP-3 work this contract names: the exception filter's passthrough so that
  `return_line_not_returnable` carries `error.lineRef` and `error.reason` (the
  filter passes only `code`, `message`, `details` and a few named keys today),
  and `return_policy.eligibility_read` in `audit-action-kinds.ts`.
