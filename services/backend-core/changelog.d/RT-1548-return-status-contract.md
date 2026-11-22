### Added
- RT-1548 `[GATED: contract]`, owner approval on RT-1548 comment 18204, slice 1
  of 2 (RT-196 design spec section 4, BR-2 and BR-7): contract-only operation
  `readReturnStatusByProvenance`
  (`GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status`) in
  `pos-sales/sales.yaml` 1.28.0-draft. It gives the POS an affirmative verdict
  for a return provenance of a sale, with the same operator authorization as
  `readSale`: `recorded` (the exact `SaleReturn` plus a required `creditLinked`
  flag, so a credit-sale reversal reads as recorded and is treated as a
  mismatch) or `not_recorded`. A 404 stays one non-disclosing body for a gate
  that is off or a sale out of the caller's scope and is never `not_recorded`;
  a key recorded against another sale reads as `not_recorded` exactly like a key
  recorded nowhere. The BR-7 late-commit bound is stated on the read and on
  `recordReturn`: from the slice 2 runtime it issues no COMMIT later than 60
  seconds after receiving a request and a request abandoned or refused under
  that bound never commits afterwards, which fits inside the POS quiet period of
  15 minutes (OD-196-5; the quiet period is elapsed time and also covers the
  transport delay before receipt). The status read must not answer a verdict
  until every instance that serves `recordReturn` enforces the bound (ship the
  bound first, and slice 2 verifies and documents the `synchronous_commit` and
  replica setting). `not_recorded` means no `recordReturn` request received more
  than 60 seconds earlier has a COMMIT still to be issued; a return that later
  shows up as recorded is a mismatch the POS raises to support and never pays.
  `not_recorded` makes no claim about an in-flight `recordCreditSaleReversal`.
  A credit-sale reversal with a 0 cash refund has no refund row, so for
  `creditLinked: true` the returned `saleReturn.refundTenders` may be empty
  (new schema `ReturnStatusZeroRefundReturn`; `SaleReturn` is unchanged).
  Strictly additive
  (oasdiff: INFO only); `readReturnByProvenance` and its 404 semantics are
  unchanged. No runtime, migration or POS change. Not in this version for want
  of a spec source: a third `unknown` or `pending` verdict, and a server
  timestamp or tombstone that refuses a later commit (spec Option B). The
  runtime, its tests and the audit event follow in slice 2.
