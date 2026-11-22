/**
 * The public surface of `pos-cashier-admissions` (RT-1453 port convention, RT-1463): the cashier
 * admission verifiers that sales, shift cash-up and voucher redemption guards ask before they
 * accept a device-path request. Everything else in this directory is internal. A verifier that
 * reads the database runs its own tenant-context transaction on the pool it is given; it reads
 * only this module's `cashier_admissions` table.
 */
export { selectsDevicePath } from "./device-path";
export {
  ATTRIBUTION_REFUSAL_EVENTS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_WINDOW_AGE_SECONDS,
  OPERATOR_ATTRIBUTION_VERIFIER,
  PgOperatorAttributionVerifier,
  type AttributionRefusal,
  type OperatorAttributionVerifier,
} from "./operator-attribution";
export {
  PgSaleVoidCashierVerifier,
  PgTrackedLineCashierVerifier,
  SALE_VOID_CASHIER_VERIFIER,
  TRACKED_LINE_CASHIER_REFUSAL_EVENTS,
  TRACKED_LINE_CASHIER_VERIFIER,
  type SaleVoidCashierRefusal,
  type SaleVoidCashierVerifier,
  type TrackedLineCashierRefusal,
  type TrackedLineCashierVerifier,
} from "./tracked-line-cashier";
