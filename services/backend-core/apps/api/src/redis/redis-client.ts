/**
 * The shared Redis client as infrastructure (RT-1466, audit A-10). It used to be provided by
 * `AuthModule`, which made every Redis consumer (idempotency, health, store deletion) look
 * auth-dependent. The token value and the factory are unchanged, so `overrideProvider(REDIS_CLIENT)`
 * keeps working.
 */
import Redis from "ioredis";

import { requireRedisUrl } from "@data-pulse-2/shared";

import { IoredisIdempotencyAdapter } from "../common/redis/ioredis-idempotency-adapter";
import type { RedisLike, WindowHit } from "../common/rate-limit/rate-limit";

/** DI token of the single shared Redis client. The string value is pinned: tests override it. */
export const REDIS_CLIENT = "REDIS_CLIENT";

/**
 * Factory for the `REDIS_CLIENT` provider. Extracted so a focused unit test
 * can verify the factory returns an `IoredisIdempotencyAdapter` when
 * `REDIS_URL` is set.
 *
 * Production wiring policy:
 *   - `REDIS_URL` missing → return `AlwaysAllowRedis` stub (no-op; rate
 *     limits never trigger; idempotency storage disabled).
 *   - `REDIS_URL` set → wrap a real ioredis client in
 *     `IoredisIdempotencyAdapter` so that the options-object set() calls
 *     used by IdempotencyModule are translated to ioredis's variadic-string
 *     form and RateLimiter's incrWindow() runs as one atomic script.
 *
 * The `component: "AuthModule"` label is kept as it was before RT-1466: specs and operator
 * runbooks pin the `<component>: REDIS_URL is required in production` message prefix.
 */
export function redisClientFactory(): RedisLike {
  const url = requireRedisUrl({
    component: "AuthModule",
    reason: "rate limiting + idempotency disabled without it",
  });
  if (url === null) {
    return new AlwaysAllowRedis();
  }
  // Wrap the real ioredis client in IoredisIdempotencyAdapter, which
  // translates the options-object set() used by IdempotencyModule into
  // ioredis's variadic-string form and runs RateLimiter's incrWindow() as
  // one atomic script (RT-618).
  const client = new Redis(url);
  return new IoredisIdempotencyAdapter(client);
}

/**
 * Stub Redis used when `REDIS_URL` is absent (local dev / CI without Redis).
 *
 * Rate-limit surface: `incrWindow` always returns count 1 (and keeps no TTL,
 * so `resetMs` is -1), so limits never trigger.
 *
 * Idempotency surface: `get` always returns null (no stored replay), `set`
 * returns "OK" for NX calls (in-progress marker succeeds — the request
 * proceeds) and "OK" for PX calls (replay store writes succeed silently).
 * `del` is a no-op. Without Redis no replay is possible, so every request
 * is executed fresh — better to re-execute than to reject with 425.
 *
 * Production MUST override this with a real ioredis client; the class name is
 * intentionally loud.
 */
export class AlwaysAllowRedis implements RedisLike {
  incrWindow(_key: string, _ttlMs: number): Promise<WindowHit> {
    return Promise.resolve({ count: 1, ttlMs: -1 });
  }
  pttl(_key: string): Promise<number> {
    return Promise.resolve(-1);
  }
  decr(_key: string): Promise<number> {
    return Promise.resolve(0);
  }
  get(_key: string): Promise<string | null> {
    return Promise.resolve(null);
  }
  set(_key: string, _value: string, _opts: { px: number } | { nx: true; ex: number }): Promise<"OK" | null> {
    return Promise.resolve("OK");
  }
  del(_key: string): Promise<number> {
    return Promise.resolve(0);
  }
  /** RT-1439: nothing is ever stored, so no re-authentication grant is ever valid (fail closed). */
  compareAndDelete(_key: string, _expected: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
