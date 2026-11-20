### Changed
- RT-1484 (RT-282 PR-4b, comment 17881 follow-up 5): the Pricing authoring gate is now
  `PricingAuthoringGuard` on the Change Set controller, so every non-GET route of a tenant off
  `PRICING_AUTHORING_TENANT_ALLOWLIST` is `409 pricing_authority_legacy` before the idempotency
  interceptor runs; a spec walks the controller's routes and asserts each write is refused.
