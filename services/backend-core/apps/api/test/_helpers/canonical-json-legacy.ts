/**
 * RT-1456 A-09: the count-emission and offer-pack canonical-JSON copies exactly as they stood
 * before they were folded into `common/hashing/canonical-json.ts`. Frozen, verbatim, test-only:
 * the golden spec runs them next to the shared function to prove the fold changed no byte on
 * JSON-shaped values, and to pin where they differed (`undefined`, `Date`). Do not "fix" them.
 */

/** Verbatim: `inventory/count-sessions/count-emission.ts` `canonicalJson` before RT-1456. */
export function legacyCountCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyCountCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${legacyCountCanonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Verbatim: `offers/offer-pack.service.ts` `canonicalJson` before RT-1456. */
export function legacyOfferCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyOfferCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${legacyOfferCanonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
