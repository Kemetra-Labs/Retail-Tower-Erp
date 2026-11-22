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
  `recordReturn`: from the slice 2 runtime a `recordReturn` request commits or
  is abandoned within 60 seconds of receipt and never commits afterwards, which
  fits inside the POS quiet period of 15 minutes (OD-196-5). Strictly additive
  (oasdiff: INFO only); `readReturnByProvenance` and its 404 semantics are
  unchanged. No runtime, migration or POS change. Not in this version for want
  of a spec source: a third `unknown` or `pending` verdict, and a server
  timestamp or tombstone that refuses a later commit (spec Option B). The
  runtime, its tests and the audit event follow in slice 2.
