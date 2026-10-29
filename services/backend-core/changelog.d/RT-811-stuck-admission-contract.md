### Changed
- RT-811 `[GATED]`, owner decision 2026-10-29 (RT-811 comment 14372; RT-742
  follow-up): `pos-shifts.openapi.yaml` 1.4.0-draft → 1.5.0-draft, description
  text only. A cashier sells with a cashier admission and never holds a
  `pos_operator` session, so the RT-742 "live drawer" rule let a manager on
  another terminal force-close a shift its cashier was still selling on. A
  shift whose opening terminal holds a live cashier admission (any user, same
  tenant, not ended for any reason, not expired at the server clock) is now
  live: `GET /shifts/stuck` does not list it and `forceCloseShift` refuses it
  with the existing 409 `shift_not_stuck`, at the same place in the
  evaluation order (a replay of a recorded force close is still answered
  first). No operation, status, code or schema change; no POS change. The
  runtime follows in a separate PR.
