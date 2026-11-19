/**
 * Minor-unit representability for the pricing resolver (spec 041 §4.2 step 7,
 * §6; RT-1484 PR-1). String arithmetic only: floating point is prohibited
 * anywhere in pricing (478, 572).
 */
import { minorUnitExponent } from "../../common/money/iso4217-minor-units";

/** `numeric(19,4)`: up to 15 integer digits and 4 fractional digits (the `DecimalPrice` pattern). */
const NUMERIC_19_4 = /^(\d{1,15})(?:\.(\d{1,4}))?$/;
const STORAGE_SCALE = 4;

/**
 * The price at `numeric(19,4)` scale (`125.5` → `125.5000`) when it is exact
 * at `currencyCode`'s ISO-4217 minor unit; otherwise null. A currency with no
 * minor unit, or a string that is not a non-negative `numeric(19,4)` decimal,
 * is not representable (fail closed).
 */
export function representablePrice(price: string, currencyCode: string): string | null {
  const exponent = minorUnitExponent(currencyCode);
  const match = NUMERIC_19_4.exec(price);
  if (exponent === null || match === null) return null;
  const fraction = (match[2] ?? "").padEnd(STORAGE_SCALE, "0");
  if (!/^0*$/.test(fraction.slice(exponent))) return null;
  return `${match[1]}.${fraction}`;
}
