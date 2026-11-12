/**
 * Exact-decimal helpers of the Offer Engine evaluator (spec 048 §6, §9).
 *
 * No float anywhere (gate A.6): every amount is a `bigint` count of the
 * currency's minor unit, every quantity a `bigint` count of 10^-6 units, and
 * strings are parsed digit by digit. Pure: no I/O, no clock.
 */

/** The quantity scale of `sale_lines.quantity` (numeric(19,6)). */
const QUANTITY_SCALE = 6;

const ONE_QUANTITY = 10n ** BigInt(QUANTITY_SCALE);

/** An exact-decimal string was malformed, or has more digits than the scale allows. */
export class OfferDecimalError extends Error {
  constructor(value: string, scale: number, message?: string) {
    super(message ?? `"${value}" is not a non-negative decimal with at most ${scale} fractional digits`);
    this.name = "OfferDecimalError";
  }
}

/**
 * A non-negative exact-decimal string as an integer count of 10^-scale units.
 * Trailing zeros beyond `scale` are accepted ("40.0000" at scale 2 is 4000n);
 * a significant digit beyond it throws.
 */
export function scaled(value: string, scale: number): bigint {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new OfferDecimalError(value, scale);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > scale) throw new OfferDecimalError(value, scale);
  return BigInt(match[1]! + fraction.padEnd(scale, "0"));
}

/** Minor units as a string with exactly `minorUnit` fractional digits ("120.00"). */
export function formatMinor(minor: bigint, minorUnit: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(minorUnit + 1, "0");
  const text = minorUnit === 0 ? digits : `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
  return negative ? `-${text}` : text;
}

/** Minor units as a non-negative amount at the column scale 4 ("80.0000"), the scale of `numeric(19,4)` and the feed. */
export function formatColumnAmount(minor: bigint, minorUnit: number): string {
  const digits = (minor * 10n ** BigInt(4 - minorUnit)).toString().padStart(5, "0");
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** Half up once at the minor unit (OD-28-3): P% of a non-negative price. */
export function percentOf(priceMinor: bigint, percent: string): bigint {
  return (priceMinor * BigInt(percent) + 50n) / 100n;
}

/** The number of whole units in a quantity string, or null when it is not whole (F-9). */
export function wholeUnits(quantity: string): bigint | null {
  const q = scaled(quantity, QUANTITY_SCALE);
  return q % ONE_QUANTITY === 0n ? q / ONE_QUANTITY : null;
}

/** `unitPrice × quantity` in minor units, exact for a whole quantity. */
export function grossMinor(unitPrice: string, quantity: string, minorUnit: number): bigint {
  return (scaled(unitPrice, minorUnit) * scaled(quantity, QUANTITY_SCALE)) / ONE_QUANTITY;
}
