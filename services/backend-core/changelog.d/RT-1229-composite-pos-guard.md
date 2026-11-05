### Changed
- RT-1229: the three composite POS guards (`SaleCaptureAuthGuard`,
  `ShiftCashUpAuthGuard`, `SaleHistoryAuthGuard`) now share one decision flow,
  `CompositePosAuthGuard` (`apps/api/src/auth/composite-pos-auth.guard.ts`).
  The flow is: route policy, selector, envelope path, device first, the claim
  check, then publish. Each guard keeps its class name and supplies only its
  selector and claim check. Who is allowed, refusal reasons and HTTP codes,
  log events, audit rows and check order are unchanged. A new authorization
  matrix spec (`test/auth/pos-composite-guards.authz-matrix.unit.spec.ts`)
  pins them across envelope only, device only, a revoked device, an expired
  admission, the wrong store, a deleted user, `store_staff`, and a platform
  admin without membership.
