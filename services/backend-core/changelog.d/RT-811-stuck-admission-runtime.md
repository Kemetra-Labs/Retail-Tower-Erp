### Fixed
- RT-811 runtime (contract `pos-shifts.openapi.yaml` 1.5.0-draft, owner
  decision 2026-10-29, RT-811 comment 14372): a manager on another terminal
  can no longer force-close a drawer a cashier is still selling on. The
  `forceCloseShift` stuck rule (`IS_STUCK_SQL`, inside the transaction that
  locks the shift and records the close) and the `GET /shifts/stuck` query now
  also require that the shift's opening terminal holds no live cashier
  admission of the tenant (any user, `ended_at IS NULL`, `expires_at > now()`).
  A live one is 409 `shift_not_stuck` with nothing written and hides the
  shift from the stuck list; an expired admission, one ended by the device or
  by a takeover, and one on another terminal do not; a recorded force close
  still replays 200. No migration (index `idx_cashier_admissions_device_live`
  exists) and no POS change.
  `pos-shifts.openapi.yaml` (description text only) replaces the RT-811
  "pending runtime" markers with "shipped".
