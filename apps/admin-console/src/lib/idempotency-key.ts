/**
 * RT-1217: the one place a Console write mints an `Idempotency-Key` and decides whether to reuse
 * one. Every feature used to carry its own copy. Pure: no client, no React. Not part of the
 * contracts tier (`client`, `auth-interceptor`, `request-id`, `contracts-pin`); the header name
 * and where it is sent are unchanged.
 *
 * The key LIFETIME stays with each call site, on purpose, and falls in three kinds:
 *  - fresh per submit: the call passes `newIdempotencyKey()` straight to the request (voucher
 *    issue, pairing code, product-reconciliation trigger and repair, stock refresh, Manager Sales
 *    Ask, posting-repair first confirm);
 *  - held for one action: the caller keeps the key in a ref and reuses it while the action may
 *    not have settled (`??=` in voucher cancel and sale-sync repair, the `keepsKey` classifiers);
 *  - tied to the body: `reuseOrNewKey` reuses the key while the body fingerprint is unchanged
 *    and mints a new one when it changes (a same-key different-body call is a 409
 *    `idempotency_key_conflict`); `KeyedAttempt` in `write-outcome.ts` is the same rule behind a
 *    small holder with `settle()`.
 * Each feature still owns its own outcome classifier and its `keepsKey` rule.
 */

/** A v4 UUID: 36 printable ASCII characters, inside the contract's `^[\x21-\x7E]{16,128}$`. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** One keyed attempt: the fingerprint of its body and the key that identifies it to the server. */
export interface KeyedAttempt {
  fingerprint: string;
  key: string;
}

/**
 * The key for this body. A retry of the SAME body (a dropped response, a 5xx, a 425, a 429) reuses
 * the previous key, so the server replays instead of writing twice; a different body gets a new
 * key. `mint` is a seam for tests only.
 */
export function reuseOrNewKey(
  previous: KeyedAttempt | null | undefined,
  fingerprint: string,
  mint: () => string = newIdempotencyKey,
): KeyedAttempt {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: mint() };
}
