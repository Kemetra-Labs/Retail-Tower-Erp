### Added
- RT-1444 `[GATED: contract]` (C1 of RT-1437; owner decisions D1 to D10 approved
  2026-11-16): OpenAPI contract for the Console "force with impact preview"
  actions, `x-runtime-status: contract-only`, no runtime or migration.
  `console-force-actions.openapi.yaml` (1.0.0-draft): `consoleListOpenShifts`
  (every open shift with its eligibility verdict), `consoleGetForceClosePreview`
  (recorded counts only, a `previewFingerprint`), `consoleForceCloseShift`
  (not counted, `Idempotency-Key`, typed reason, 409 `preview_stale`, `closedVia`
  records a Console origin, owner and tenant_admin with all-store access) and
  `consoleReauthenticate` (password re-entry yields a 5-minute single-use grant).
  `stores.openapi.yaml` 1.3.0-draft: `previewStoreDeletion` and
  `consoleDeleteStore` (owner only, reason, fingerprint, grant, four guards).
  429 `force_action_rate_limited` above 10 force actions per tenant per hour.
  `inventory/inventory.yaml` 1.19.0-draft: a structured `subject`
  (`deviceId` or `warehouseRef`) on `CountSessionsReadinessBoundary`.
  New audit metadata on `shift.force_closed` and the new `store.deleted`.
