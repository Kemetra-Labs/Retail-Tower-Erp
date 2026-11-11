### Added
- RT-1312 Phase 3(a) `[GATED: contract]`, owner decision D1 (RT-1312 comment 16359):
  contract-only sale quarantine. New `pos-sales/sale-quarantine.yaml` 1.0.0-draft
  (`posQuarantineSale`: the till uploads a sale refused for good or held after a
  re-pair, with its stored capture body, the reason and the original idempotency
  key, over the device bearer). `sale-sync-ops.yaml` 1.3.0-draft adds
  `consoleListQuarantinedSales`, `consoleGetQuarantinedSale` and
  `consoleRepairQuarantinedSale` (re-ingest under the original provenance, one
  sale per provenance by the capture dedup; the till's key is kept for audit). Every new operation is `x-runtime-status: contract-only`; no
  runtime, migration or consumer change. Open owner questions are listed in both
  contracts.
