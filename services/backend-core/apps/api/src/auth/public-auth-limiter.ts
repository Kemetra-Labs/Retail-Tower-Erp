/**
 * RT-628 (RT-574 issue 5e) — public-auth limiter posture on a Redis outage.
 *
 * Owner ruling O6 (2026-10-17): sign-in and the other public-auth routes
 * (`/auth/signin`, `/auth/password-reset/request`,
 * `/auth/password-reset/confirm`) FAIL CLOSED, deliberately: the limiter call
 * is bounded by a timeout, and a timeout or error answers 503 with
 * `Retry-After`. Never a hang and never a 500. Brute-force protection is the
 * point of these limits, so they do not fail open (unlike the POS write and
 * takeover limiters, ADR 0009 D3). Already signed-in console sessions are not
 * affected: they do not pass through these buckets.
 *
 * Why a timeout is needed at all: the production client is `new Redis(url)`
 * with ioredis defaults (offline queue + reconnect retries), so during an
 * outage a command neither resolves nor rejects for seconds; a bare
 * try/catch never fires.
 *
 * | Env var                          | Default | Meaning                                                             |
 * | -------------------------------- | ------- | ------------------------------------------------------------------- |
 * | `PUBLIC_AUTH_LIMITER_TIMEOUT_MS` | 1000    | Max wait for each public-auth limiter call. 1 … 10000. Read at boot. |
 *
 * The default is wider than the fail-open limiters' 250 ms because here a
 * false timeout refuses a real user: one Redis round trip (RT-618) normally
 * takes about a millisecond, so 1 s only trips on a real stall. Sign-in makes
 * two sequential checks, so its worst case is about 2 s. An unset,
 * non-integer or out-of-range value falls back to the default.
 */
import { HttpException, HttpStatus } from "@nestjs/common";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Response } from "express";

import type { RateLimitBucket, RateLimitDecision, RateLimiter } from "./rate-limit";

export const DEFAULT_PUBLIC_AUTH_LIMITER_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 10_000;

/** `Retry-After` (seconds) sent with the outage 503. */
export const PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** Envelope `code` of the outage 503 (the contract's `Error.code` is a free string). */
export const PUBLIC_AUTH_UNAVAILABLE_CODE = "service_unavailable";

type Env = Readonly<Record<string, string | undefined>>;

export function readPublicAuthLimiterTimeoutMs(env: Env = process.env): number {
  const raw = (env["PUBLIC_AUTH_LIMITER_TIMEOUT_MS"] ?? "").trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_PUBLIC_AUTH_LIMITER_TIMEOUT_MS;
  const value = Number(raw);
  return value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS ? value : DEFAULT_PUBLIC_AUTH_LIMITER_TIMEOUT_MS;
}

/** The limiter did not answer in time, or failed. */
export class PublicAuthLimiterUnavailable extends Error {
  override readonly name = "PublicAuthLimiterUnavailable";
  constructor(readonly reason: "timeout" | "error") {
    super(`public-auth rate limiter unavailable (${reason})`);
  }
}

const TIMED_OUT = Symbol("timed-out");

/** Resolve to TIMED_OUT after `ms`; the timer never keeps the process alive. */
function timer(ms: number): { done: Promise<typeof TIMED_OUT>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const done = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMED_OUT), ms);
    handle.unref();
  });
  return { done, cancel: () => clearTimeout(handle) };
}

/** One limiter hit: which bucket, for whom, under which policy. */
export interface LimiterHit {
  readonly bucketName: string;
  readonly identifier: string;
  readonly bucket: RateLimitBucket;
}

/**
 * `limiter.check` bounded by `timeoutMs`. Throws `PublicAuthLimiterUnavailable`
 * on a timeout or an error; a refusal (`allowed: false`) is returned as is.
 *
 * On a timeout the hit can still land later (the ioredis offline queue
 * replays the command once Redis is back). The request was refused before
 * any authentication, so that late hit is given back; otherwise retries
 * during an outage would turn into a lockout after recovery.
 */
export async function checkWithin(
  limiter: RateLimiter,
  hit: LimiterHit,
  timeoutMs: number,
): Promise<RateLimitDecision> {
  const { bucketName, identifier, bucket } = hit;
  const pending = limiter.check(bucketName, identifier, bucket);
  const t = timer(timeoutMs);
  let outcome: RateLimitDecision | typeof TIMED_OUT;
  try {
    outcome = await Promise.race([pending, t.done]);
  } catch {
    throw new PublicAuthLimiterUnavailable("error");
  } finally {
    t.cancel();
  }
  if (outcome === TIMED_OUT) {
    pending.then(
      () => limiter.release(bucketName, identifier).catch(() => undefined),
      () => undefined,
    );
    throw new PublicAuthLimiterUnavailable("timeout");
  }
  return outcome;
}

/**
 * `limiter.release` bounded by `timeoutMs`, best-effort: a slow or failing
 * release leaves the hit counted (the safe direction) and never fails or
 * stalls the response.
 */
export async function releaseWithin(
  limiter: RateLimiter,
  bucketName: string,
  identifier: string,
  timeoutMs: number,
): Promise<void> {
  const t = timer(timeoutMs);
  try {
    await Promise.race([limiter.release(bucketName, identifier).catch(() => undefined), t.done]);
  } finally {
    t.cancel();
  }
}

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createLogger({ service: "api.auth", level: process.env["LOG_LEVEL"] ?? "info" });
  return logger;
}

/** RT-623: bounds of the `Retry-After` sent with a public-auth 429, in seconds. */
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 3_600;

/**
 * Whole seconds until the bucket resets, rounded up so a client never retries
 * early, clamped to [1, 3600]. A negative `resetMs` (a stub client that keeps
 * no TTL) is treated as "now".
 */
export function retryAfterSeconds(resetMs: number): number {
  const seconds = Math.ceil(Math.max(0, resetMs) / 1_000);
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds));
}

/**
 * One public-route limiter hit with the RT-628 posture (owner ruling O6): a
 * refusal is a 429 and a limiter outage is a 503, both with `Retry-After`, never
 * a hang and never a 500. Used by public routes that have no failed-attempt
 * accounting of their own (RT-937: invitation acceptance).
 */
export async function enforcePublicLimit(
  limiter: RateLimiter,
  hit: LimiterHit,
  timeoutMs: number,
  res: Response,
): Promise<void> {
  let decision: RateLimitDecision;
  try {
    decision = await checkWithin(limiter, hit, timeoutMs);
  } catch (err) {
    // The bucket name and the reason only: never the identifier (an IP address).
    log().warn(
      { bucket: hit.bucketName, reason: err instanceof PublicAuthLimiterUnavailable ? err.reason : "error" },
      "public-auth rate limiter unavailable; failing closed (503)",
    );
    res.setHeader("Retry-After", String(PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS));
    throw publicAuthUnavailable();
  }
  if (!decision.allowed) {
    res.setHeader("Retry-After", String(retryAfterSeconds(decision.resetMs)));
    throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** The O6 outage answer. The caller sets `Retry-After` on the response. */
export function publicAuthUnavailable(): HttpException {
  return new HttpException(
    {
      code: PUBLIC_AUTH_UNAVAILABLE_CODE,
      message: "Temporarily unavailable. Retry later.",
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
