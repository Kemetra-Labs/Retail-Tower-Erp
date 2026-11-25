/**
 * RT-1598 — exact `numeric(19,4)` quantities as scaled bigints (x 10^4), the same representation as the W3
 * ATS code. `common/quantity/decimal-quantity.ts` is not reused because it throws a Nest HTTP exception; this
 * module must stay free of framework imports, so a malformed value is `null` here and the caller reports it.
 */

/** One stocking unit at the `numeric(19,4)` scale. */
export const UNIT = 10_000n;

const QTY = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/;

/** The scaled value of a `numeric(19,4)` decimal string, or `null` when it is not one. */
export function parseQty(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match = QTY.exec(value);
  if (match === null) return null;
  const magnitude = BigInt(match[2]!) * UNIT + BigInt((match[3] ?? '').padEnd(4, '0'));
  return match[1] === '-' ? -magnitude : magnitude;
}

/** A scaled value as a decimal string with exactly four fractional digits. */
export function formatQty(scaled: bigint): string {
  const magnitude = scaled < 0n ? -scaled : scaled;
  const sign = scaled < 0n ? '-' : '';
  return `${sign}${(magnitude / UNIT).toString()}.${(magnitude % UNIT).toString().padStart(4, '0')}`;
}

/** Code-unit order of two ids: deterministic and locale-free (never `localeCompare`). */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
