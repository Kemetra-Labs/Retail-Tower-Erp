### Added
- RT-1062: runtime for `consoleGetSystemStatus` (`GET /api/v1/system-status`, contract
  RT-1056). The tenant's `server`, `saleSync` and `erpConnector` components with the
  D-1 states and reasons and the worst-of `overall` (`unknown` is never `ok`), computed on
  every read (`Cache-Control: no-store`). `saleSync` counts the tenant's undelivered
  `sale.captured` outbox events and open NEEDS_REPAIR dead letters; `erpConnector` reuses
  the spec 020 liveness (`connector-health.liveness.ts`). Each check runs under tenant RLS
  with a 2-second bound; a check that does not answer in time is that component's
  `unknown` / `check_timed_out`. Roles `owner` and `tenant_admin` (others: the
  non-disclosing 404); console rate-limit class `cheapRead`; not audited. `[GATED]`
  (RT-1062): only the operation's `contract-only` marker is removed from
  `console-system-status.openapi.yaml`. No migration, index or client change.
