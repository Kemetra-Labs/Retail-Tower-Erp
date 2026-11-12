### Added
- RT-1337 `[GATED: contract]`, owner authorization in the RT-286 coordinating session (2026-11-12) and Jira RT-1337 comment 16713 (RT-286 spec 048 slice S4):
  the Offer Engine V1 runtime. The eleven Console operations of `offers.openapi.yaml` (draft create and edit with
  optimistic concurrency, validate and preview with a simulation, publish, pause, resume, end, archive, the version
  list and the reads) and `posGetOfferPack` are live on the RT-1336 schema, with the OD-12 capabilities, the OD-7
  conflict refusal (a product is in at most one live offer per store, whatever the windows), an audit row per write
  and one new Pack revision per change in the same transaction. Backend-Core materialises each version's eligible set
  (OD-6) on publish, pause, resume, end, a catalog change (category, brand, active, retire, a new product) and a store
  added or deleted. `captureSale` accepts and stores `promotion` (arithmetic refused as 422 `sale_line_pricing_invalid`,
  a rule-level difference accepted and flagged to review with an `audit_events` row, OD-9), and `readSale`, the sale
  history and the Console sales detail return it (`SaleHistoryLine.promotion`). `recordReturn` computes the clawback
  of each offer from its frozen version and prices (OD-3, multi-return form) and refuses `promotion_clawback_exceeds_refund`
  (OD-10); a return with a clawback above 0, a give-back, or a reward line stays refused
  (`promotion_return_requires_clawback`, fail closed) until the posting feed and the Connector can post it (RT-1340).
  The contract-only markers are dropped,
  and `posGetOfferPack` joins the RT-719 build identity and RT-639 rotate-hint operations of the pairing contract.
  Review round: a catalog edit no longer deadlocks against a publish (the product row lock is `FOR NO KEY UPDATE`), a
  line `promotion` is refused on a credit sale, one evaluation expands at most 100,000 units, an uncited participant is
  flagged, the Pack read is one snapshot, and a product created from an unknown item joins a matching live offer.
  Validation round: a tenant_admin or owner with a specific-stores membership is bounded to their stores (RT-131), the Pack
  carries no guessed currency (`XXX` and no offers when prices use no single currency), and a deleted store is a 404.
