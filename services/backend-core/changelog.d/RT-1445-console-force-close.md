### Added
- RT-1445 `[GATED: migration, contract]`, owner decision 2026-11-17 (RT-1437 D1 to D10, option (a) `closedVia`):
  Backend-Core runtime of the Console force actions for stuck shifts over `ShiftForceCloseService`:
  `consoleListOpenShifts` (every open shift of a store with its verdict), `consoleGetForceClosePreview` (a read-only
  impact preview with a `previewFingerprint`) and `consoleForceCloseShift` (owner or tenant_admin with all-store
  access; reason only; idempotent; a stale fingerprint is 409 `preview_stale`; the D9 cap of 10 force actions per
  tenant per rolling hour is 429 `force_action_rate_limited`). Migration 0119: `shift_forced_closes.closed_from_device_id`
  is nullable, `closed_via` (`pos` or `console`, default `pos`) is added, and a CHECK ties them (`console` exactly
  when the device is null). The `shift.force_closed` audit event gains `channel`, `actor_role`, `preview_fingerprint`,
  `lifecycle_state_before`, `lifecycle_state_after`, `opening_user_id` and `shift_age_minutes`, on the POS path too
  (the POS response is unchanged). The contract drops the `contract-only` markers of the three shipped operations.
