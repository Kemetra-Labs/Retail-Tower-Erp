### Added
- RT-1439 `[GATED: contract]` (B2 of RT-1437; owner decisions D1 to D10 approved 2026-11-16):
  the runtime of the guarded, audited store deletion. `previewStoreDeletion`
  (`GET /api/v1/stores/{store_id}/deletion-preview`), `consoleDeleteStore`
  (`POST /api/v1/stores/{store_id}/deletion`, `Idempotency-Key` required) and
  `consoleReauthenticate` (`POST /api/v1/auth/reauth`) drop their
  `x-runtime-status: contract-only` markers; the wire is unchanged. Owner only. The
  deletion needs a 5-minute, single-use re-authentication grant bound to the session, the
  user, the purpose and the store (the password is verified last, through the identity
  provider's password sign-in or the native Argon2 hash; the provider session that check
  creates is ended again), a typed reason and the preview fingerprint. It writes one
  `store.deleted` audit row. No undelete. No migration: the grant lives in Redis.
  The Console force-action hourly cap (D9) counts these deletions.
- RT-1439: each `store_barrier_unprovable` readiness boundary now carries the structured
  `subject` (`deviceId` or `warehouseRef`) and is emitted once per offending device or
  warehouse (it named only the first before), in `getCountSessionsSetting` and in the 409
  `count_sessions_readiness_unmet`.
