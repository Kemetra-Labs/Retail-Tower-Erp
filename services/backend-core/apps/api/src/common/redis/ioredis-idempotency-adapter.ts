/**
 * IoredisIdempotencyAdapter — translates the options-object Redis API used by
 * the idempotency and rate-limit modules into ioredis's variadic-string form.
 *
 * Background: ioredis's `set` uses positional string flags ("EX", "NX",
 * "PX"), not an options object. The idempotency module
 * (InProgressMarker, IdempotencyKeyStore) calls `redis.set(k, v, { nx, ex })`
 * and `redis.set(k, v, { px })`, which would silently store `"[object Object]"`
 * against a real ioredis client. The rate-limit hit (`incrWindow`, RT-618) is
 * not a native command either; it runs as one atomic Lua script (EVAL).
 *
 * This adapter wraps a single `Redis` instance and provides the union of three
 * surfaces:
 *
 *   1. Rate-limit surface (`RedisLike` from `rate-limit.ts`):
 *      `incrWindow`, `pttl`, `decr`, `del`
 *   2. Idempotency store surface (`RedisLike` from `packages/shared`):
 *      `get`, `set(key, value, { px })`
 *   3. In-progress marker surface (`InflightRedis` from `in-progress-marker.ts`):
 *      `set(key, value, { nx: true, ex })`, `del`
 *
 * The adapter is the only point of contact with the real ioredis client; all
 * module-level code continues to call the narrow port interfaces they already
 * depend on.
 */
import Redis from "ioredis";

import type { WindowHit } from "../rate-limit/rate-limit";

/**
 * RT-618: the fixed-window hit as one atomic script. INCR, then seed the
 * window TTL if the key has none (PTTL -1: the first hit, or a counter that
 * lost its TTL; this is the self-heal), then return `{count, pttl}`. Inside a
 * script, PTTL plus a conditional PEXPIRE is equivalent to `PEXPIRE ... NX`
 * (no other command can interleave) and does not need Redis 7's NX flag.
 */
export const INCR_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

/**
 * RT-1439: delete a key only when its value is the expected one, in one atomic step (the
 * re-authentication grant's single-use consume). Returns 1 when it deleted, else 0.
 */
const COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * RT-1439: `INCR_WINDOW_SCRIPT` that also returns the window's END on the Redis SERVER clock
 * (`TIME` plus the remaining TTL): `{count, ttl, windowEndsAtMs}`. The end is the window's identity.
 */
const INCR_WINDOW_WITH_END_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
return {count, ttl, nowMs + ttl}
`;

/**
 * RT-1439: decrement a fixed-window counter only while ITS window is still the live one: the live end
 * (the server's `TIME` plus the key's remaining TTL, at the moment the script runs) must be within
 * ARGV[2] ms of the window end the hit was reserved in (ARGV[1], also a server-clock value). One atomic
 * step on one clock, so a delayed command cannot match a later window and a skewed application clock
 * is irrelevant. Returns 1 when it decremented, else 0. A counter that goes below zero is deleted so
 * the next window starts clean (as `RateLimiter.release` does).
 */
const DECR_IF_WINDOW_ENDS_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return 0 end
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if math.abs(nowMs + ttl - tonumber(ARGV[1])) > tonumber(ARGV[2]) then return 0 end
local count = redis.call('DECR', KEYS[1])
if count < 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export class IoredisIdempotencyAdapter {
  constructor(private readonly client: Redis) {}

  // ---------------------------------------------------------------------------
  // Idempotency store + in-progress marker surface
  // ---------------------------------------------------------------------------

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Translated `SET` with options object → ioredis variadic string flags.
   *
   * `{ nx: true, ex }` → `SET key value EX seconds NX` (returns "OK" | null)
   * `{ px }`           → `SET key value PX ms`          (returns "OK")
   */
  async set(
    key: string,
    value: string,
    options: { nx: true; ex: number } | { px: number },
  ): Promise<"OK" | null> {
    if ("nx" in options) {
      // ioredis: set(key, value, "EX", seconds, "NX") → "OK" | null
      const result = await this.client.set(key, value, "EX", options.ex, "NX");
      return result;
    }
    // ioredis: set(key, value, "PX", ms) → "OK"
    const result = await this.client.set(key, value, "PX", options.px);
    return result;
  }

  del(key: string): Promise<number> {
    return this.client.del(key);
  }

  /** RT-1439: `incrWindow` plus the window's end on the server clock (see {@link INCR_WINDOW_WITH_END_SCRIPT}). */
  async incrWindowWithEnd(key: string, ttlMs: number): Promise<WindowHit & { windowEndsAtMs: number }> {
    const reply: unknown = await this.client.eval(INCR_WINDOW_WITH_END_SCRIPT, 1, key, String(ttlMs));
    if (
      !Array.isArray(reply) ||
      reply.length !== 3 ||
      !isInteger(reply[0]) ||
      !isInteger(reply[1]) ||
      !isInteger(reply[2])
    ) {
      throw new Error("IoredisIdempotencyAdapter.incrWindowWithEnd: unexpected reply from the rate-limit script");
    }
    return { count: reply[0], ttlMs: reply[1], windowEndsAtMs: reply[2] };
  }

  /** RT-1439: atomic window-checked decrement (see {@link DECR_IF_WINDOW_ENDS_SCRIPT}). */
  async decrIfWindowEnds(key: string, windowEndsAtMs: number, toleranceMs: number): Promise<boolean> {
    const reply: unknown = await this.client.eval(
      DECR_IF_WINDOW_ENDS_SCRIPT,
      1,
      key,
      String(windowEndsAtMs),
      String(toleranceMs),
    );
    return reply === 1;
  }

  /** RT-1439: atomic delete-if-equal (see {@link COMPARE_AND_DELETE_SCRIPT}). */
  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const reply: unknown = await this.client.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, expected);
    return reply === 1;
  }

  // ---------------------------------------------------------------------------
  // Rate-limit surface
  // ---------------------------------------------------------------------------

  /**
   * One EVAL round trip (RT-618). The script is about 200 bytes; Redis caches
   * its compiled form by SHA, so resending it costs only the bytes.
   */
  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    const reply: unknown = await this.client.eval(INCR_WINDOW_SCRIPT, 1, key, String(ttlMs));
    if (!Array.isArray(reply) || reply.length !== 2 || !isInteger(reply[0]) || !isInteger(reply[1])) {
      throw new Error("IoredisIdempotencyAdapter.incrWindow: unexpected reply from the rate-limit script");
    }
    return { count: reply[0], ttlMs: reply[1] };
  }

  decr(key: string): Promise<number> {
    return this.client.decr(key);
  }

  pttl(key: string): Promise<number> {
    return this.client.pttl(key);
  }
}
