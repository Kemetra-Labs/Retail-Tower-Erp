### Added
- RT-1151 `[GATED]`, owner authorization on RT-1151 (D1, 2026-11-19): the Retail Pricing authoring
  contracts (RT-282 PR-04, authoring half). `pricing/price-structure.yaml` 1.0.0-draft: the tenant's
  retail Price Book with its default Zone, Price Zones and Zone-membership reads.
  `pricing/price-change-sets.yaml` 1.0.0-draft: the spec 042 Change Set lifecycle (create, edit,
  validate with Impact Preview, submit, four-eyes approve bound to the preview hash, reject, publish
  as one Pricing Revision, rollback as a new set, cancel). Contract-only; the runtime ships in RT-1484.
