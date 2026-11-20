/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — exact decimal arithmetic for Change Set validation: helper
 * prices (`adjust_amount`, `adjust_percent`, spec 042 §4.2, decisions 515–517), the minor-unit
 * rounding a helper result needs (spec 041 §6: half-up, shown as `roundedFrom`), the preview's
 * `deltaPct` and price comparison. Scaled `bigint` only: floating point is prohibited anywhere in
 * pricing (478, 572). Pure.
 */

/** `numeric(19,4)` storage scale of a price. */
const PRICE_SCALE = 4;
/** `numeric(23,8)` scale of a helper's unrounded result (`roundedFrom`). */
const EXACT_SCALE = 8;
/** `numeric(19,4)` holds at most 15 integer digits. */
const MAX_PRICE_UNITS = 10n ** 15n;

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A decimal string as an integer at `scale` (`"12.5"`, 4 → 125000n); null when malformed or too precise. */
function toScaled(value: string, scale: number): bigint | null {
  const m = DECIMAL_RE.exec(value);
  if (!m) return null;
  const fraction = m[3] ?? "";
  if (fraction.length > scale) return null;
  const magnitude = BigInt(`${m[2]}${fraction.padEnd(scale, "0")}`);
  return m[1] === "-" ? -magnitude : magnitude;
}

/** An integer at `scale` as a decimal string with exactly `scale` decimals (`125000n`, 4 → `"12.5000"`). */
function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}

/** `a` compared with `b` as exact prices (`"10.5"` equals `"10.5000"`); throws on a malformed price. */
export function comparePrices(a: string, b: string): number {
  const x = toScaled(a, PRICE_SCALE);
  const y = toScaled(b, PRICE_SCALE);
  if (x === null || y === null) throw new RangeError("not a price");
  return x === y ? 0 : x < y ? -1 : 1;
}

/** A helper's outcome: a concrete price (rounded half-up when needed), or why it has none. */
export type HelperPrice =
  | { readonly kind: "price"; readonly price: string; readonly roundedFrom: string | null }
  | { readonly kind: "not_positive" }
  | { readonly kind: "not_representable" };

/**
 * The concrete price of a helper from its `base` price (decisions 515–517): `base + amount`, or
 * `base × (1 + percent / 100)`. The exact result is kept at scale 8; when it is not exact at the
 * currency's minor unit (`minorUnit` decimals) it is rounded half-up and the exact value is
 * returned as `roundedFrom` (spec 041 §6). A result that is not above 0 (before or after rounding)
 * is `not_positive` (Q-4); one beyond `numeric(19,4)` is `not_representable`.
 */
export function helperPrice(
  base: string,
  adjustment: { readonly amount: string } | { readonly percent: string },
  minorUnit: number,
): HelperPrice {
  const b = toScaled(base, PRICE_SCALE);
  if (b === null || minorUnit < 0 || minorUnit > PRICE_SCALE) return { kind: "not_representable" };
  let exact: bigint;
  if ("amount" in adjustment) {
    const a = toScaled(adjustment.amount, PRICE_SCALE);
    if (a === null) return { kind: "not_representable" };
    exact = (b + a) * 10n ** BigInt(EXACT_SCALE - PRICE_SCALE);
  } else {
    const p = toScaled(adjustment.percent, 2);
    if (p === null) return { kind: "not_representable" };
    // b (scale 4) × (10000 + p) / 10000 → scale 8 exactly.
    exact = b * (10_000n + p);
  }
  if (exact <= 0n) return { kind: "not_positive" };
  const step = 10n ** BigInt(EXACT_SCALE - minorUnit);
  const rounded = ((exact + step / 2n) / step) * step;
  if (rounded <= 0n) return { kind: "not_positive" };
  const price = rounded / 10n ** BigInt(EXACT_SCALE - PRICE_SCALE);
  if (price >= MAX_PRICE_UNITS * 10n ** BigInt(PRICE_SCALE)) return { kind: "not_representable" };
  return {
    kind: "price",
    price: fromScaled(price, PRICE_SCALE),
    roundedFrom: rounded === exact ? null : fromScaled(exact, EXACT_SCALE),
  };
}

/** `price` at storage scale 4 (`"12.5"` → `"12.5000"`), or null when it is not a `numeric(19,4)` price. */
export function normalizePrice(price: string): string | null {
  const v = toScaled(price, PRICE_SCALE);
  return v === null || v < 0n || v >= MAX_PRICE_UNITS * 10n ** BigInt(PRICE_SCALE) ? null : fromScaled(v, PRICE_SCALE);
}

/** Whether a price is above 0. */
export function isPositivePrice(price: string): boolean {
  const v = toScaled(price, PRICE_SCALE);
  return v !== null && v > 0n;
}

/**
 * The preview's `deltaPct` (`DeltaPercent`): `(new − old) / old × 100` at two decimals, rounded
 * half away from zero; null when `old` is 0 (no defined change).
 */
export function deltaPercent(oldPrice: string, newPrice: string): string | null {
  const o = toScaled(oldPrice, PRICE_SCALE);
  const n = toScaled(newPrice, PRICE_SCALE);
  if (o === null || n === null) throw new RangeError("not a price");
  if (o === 0n) return null;
  const numerator = (n - o) * 10_000n;
  const magnitude = numerator < 0n ? -numerator : numerator;
  const cents = (magnitude * 2n + o) / (2n * o);
  return fromScaled(numerator < 0n ? -cents : cents, 2);
}

/** Compares two `DeltaPercent` strings numerically. */
export function compareDelta(a: string, b: string): number {
  const x = toScaled(a, 2);
  const y = toScaled(b, 2);
  if (x === null || y === null) throw new RangeError("not a percentage");
  return x === y ? 0 : x < y ? -1 : 1;
}
