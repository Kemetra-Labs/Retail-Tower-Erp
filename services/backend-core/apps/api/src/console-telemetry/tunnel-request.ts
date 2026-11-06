/**
 * Request steps shared by the Sentry tunnels (RT-632 Console; RT-1252 POS
 * device tunnel): the rate-limit budget and the envelope read and rebuild.
 *
 * Budget: the checks run in order before any body is read. A spent budget is
 * the contract's 429 `RATE_LIMITED` with `Retry-After` clamped to [1, 600];
 * an unavailable rate-limit store answers `false` (drop quietly, still 204):
 * telemetry fails closed and quiet, never blocking the caller.
 */
import { BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";

import type { RateLimitBucket, RateLimitDecision, RateLimiter } from "../auth/rate-limit";
import { MAX_ENVELOPE_BYTES, MAX_RETRY_AFTER_SECONDS } from "./console-telemetry.limits";
import { EnvelopeMalformedError, buildForwardEnvelope, type ForwardStamp } from "./envelope";
import { assertEnvelopeMediaType, readEnvelopeBody } from "./read-envelope-body";

/** One budget check: `[bucket name, identifier, bucket]`. */
export type BudgetCheck = readonly [string, string, RateLimitBucket];

/** The contract's 429 `RATE_LIMITED`, `Retry-After` clamped to [1, 600]. */
function rateLimited(res: Response, resetMs: number): HttpException {
  const resetSeconds = resetMs < 0 ? 1 : Math.ceil(resetMs / 1000);
  res.setHeader("Retry-After", String(Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, resetSeconds))));
  return new HttpException(
    { code: "RATE_LIMITED", message: "Too many telemetry envelopes." },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Throws 429 when a budget is spent. Returns false (drop, still 204) when
 * the rate-limit store is unavailable.
 */
export async function withinTelemetryBudget(
  rateLimiter: RateLimiter,
  res: Response,
  checks: readonly BudgetCheck[],
): Promise<boolean> {
  for (const [bucketName, identifier, bucket] of checks) {
    let decision: RateLimitDecision;
    try {
      decision = await rateLimiter.check(bucketName, identifier, bucket);
    } catch {
      return false;
    }
    if (!decision.allowed) throw rateLimited(res, decision.resetMs);
  }
  return true;
}

/**
 * Checks the media type (415), reads the body under the 64 KiB cap (413) and
 * rebuilds the envelope to forward, or `null` when nothing survives. A
 * malformed envelope is `400 envelope_malformed` with a fixed message.
 */
export async function readForwardEnvelope(
  req: Request,
  environment: string,
  stamp?: ForwardStamp,
): Promise<Buffer | null> {
  assertEnvelopeMediaType(req);
  const body = await readEnvelopeBody(req, MAX_ENVELOPE_BYTES);
  try {
    return buildForwardEnvelope(body, environment, stamp);
  } catch (err: unknown) {
    if (!(err instanceof EnvelopeMalformedError)) throw err;
    throw new BadRequestException({ code: "envelope_malformed", message: err.message });
  }
}
