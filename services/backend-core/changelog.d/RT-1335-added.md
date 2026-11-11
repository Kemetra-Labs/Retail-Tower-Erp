### Added
- RT-1335 `[GATED: contract]` OpenAPI (RT-286 slice S2, Post-Pilot; spec 048 Offer
  Engine V1, owner decisions OD-1 to OD-10 and the OD-12 permissions of 2026-11-11,
  owner authorization RT-1335 comment 16649): new contract
  `packages/contracts/openapi/offers.openapi.yaml` (`1.0.0-draft`,
  `x-runtime-status: contract-only`) with the Admin Console offer operations
  `consoleListOffers`, `consoleCreateOfferDraft`, `consoleGetOffer`,
  `consoleUpdateOfferDraft`, `consolePreviewOffer`, `consolePublishOffer`,
  `consolePauseOffer`, `consoleResumeOffer`, `consoleEndOffer`, `consoleArchiveOffer`
  and `consoleListOfferVersions`, and the POS Offer Pack read `posGetOfferPack`
  (ETag/304, trusted time and freshness, OD-6 and OD-8). `pos-sales/sales.yaml`
  1.22.0-draft adds the optional `CaptureSaleLine.promotion`, `SaleLine.promotion` and
  `SaleReturn.promotionClawbacks`, and the return refusals
  `promotion_clawback_exceeds_refund` and `promotion_return_requires_clawback`; the
  clawback rule counts earlier returns and their clawbacks, so a second return never
  claws back the same discount twice. A catalog change keeps a product in the
  earliest-published live offer only, so a product is in at most one offer per Pack. Adds
  the evaluation golden vectors `packages/contracts/fixtures/offers/golden-vectors.json`,
  their consistency spec, the offers contract spec and console rate-limit class file.
  No runtime, migration, Admin-Console, POS or Connector change; the schema is RT-1336
  and the runtime RT-1337.
