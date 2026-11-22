/**
 * The POS composite guards' path selector (RT-1229): a body that carries `operatorUserId` selects
 * the device path (the till's own credential plus a covering cashier admission); any other body
 * selects the envelope path. Sale capture, tracked-line validation and shift cash-up share it.
 */

/** The body field whose presence selects the device path (sales.yaml). */
export const OPERATOR_USER_ID_FIELD = "operatorUserId";

/** True when the JSON body object carries `operatorUserId` (any value). */
export function selectsDevicePath(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, OPERATOR_USER_ID_FIELD)
  );
}
