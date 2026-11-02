### Added
- RT-1056 `[GATED]`, decisions D-1 to D-5 selected under the owner delegation of
  2026-11-02 (recommended options; `docs/planning/rt-1056-console-system-status-read.md`):
  contract `console-system-status.openapi.yaml` for `consoleGetSystemStatus`
  (`GET /api/v1/system-status`), `x-runtime-status: contract-only`. The tenant's
  `server`, `saleSync` and `erpConnector` components, each `ok` / `degraded` / `down` /
  `unknown` (never `ok` without evidence) with a closed reason, `observedAt`, facts and a
  closed destination, plus the worst-of `overall` and `asOf`. Owner and tenant_admin only,
  tenant-wide, no platform-wide state; read on shell load and Refresh (no polling); console
  rate-limit class `cheapRead`; not audited. No runtime, migration or client change.
