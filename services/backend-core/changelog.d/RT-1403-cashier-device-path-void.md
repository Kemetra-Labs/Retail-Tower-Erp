### Added
- RT-1403 `[GATED]`, owner authorization on RT-1403 (comment 18071) for the RT-530 decision of
  comment 12029: cashier device-path void. `pos-sales/sales.yaml` 1.26.0-draft: `recordVoid` accepts
  the device bearer plus an optional `operatorUserId` as a second credential (the captureSale model).
  The cashier must hold a cashier admission live now on the paired device (reusing the tracked-line
  verifier), and is then the void's requester, so every RT-530 check (four-eyes, same business day,
  requester and approver eligibility, approval bound to the void) applies unchanged. A refused claim
  is the generic 403 `refused`; an envelope request carrying `operatorUserId` stays a 401. The
  envelope path and the stored `payload_hash` are unchanged. The POS must not send `operatorUserId`
  before this runtime is deployed.
