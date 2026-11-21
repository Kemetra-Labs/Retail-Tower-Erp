### Added
- RT-1403 `[GATED]`, owner authorization on RT-1403 (comments 18071 and 18113) for the RT-530 decision of
  comment 12029: cashier void over the device path. `pos-sales/sales.yaml` 1.26.0-draft adds the
  device-only operation `recordCashierVoid` (`POST /api/pos/v1/sales/{saleRef}/cashier-void`): the paired
  terminal's device bearer plus the cashier's required `operatorUserId`. The cashier must hold a cashier
  admission live now on the device (the tracked-line verifier, reused) and is then the void's requester,
  so every RT-530 check (four-eyes, same business day, requester and approver eligibility, approval bound
  to the void) applies unchanged. A refused claim is the generic 403 `refused`; an operator envelope is a
  401. `recordVoid` is unchanged (manager and admin envelope only). Both routes call the same service, so
  the void provenance is one space and the stored `payload_hash` does not include `operatorUserId`. The
  POS must not send to the new route before this runtime is deployed.
