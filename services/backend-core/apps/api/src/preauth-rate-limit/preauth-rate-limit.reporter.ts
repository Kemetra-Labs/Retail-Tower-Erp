/**
 * PreAuthRateLimitReporter — RT-630 (RT-574 residual risk R1, owner O5).
 *
 * REPORT-ONLY. `FailClosedAuthGuard` calls {@link report} after `AuthGuard`
 * refused a request with 401 (no credential, or a garbage / expired / revoked
 * session cookie or bearer token), then rethrows the same 401. This counts
 * the failure in a per-IP fixed window (`rl:preauth_ip:<ip>`) so the
 * pre-auth flood gap can be sized from data. It NEVER refuses, never throws
 * and never changes the response: there is no enforce path.
 *
 * - `off` (default): return at once. No Redis call, no metric, no log.
 * - `report`: count the hit; emit `preauth_rate_limit_total{cause,outcome}`
 *   and `preauth_rate_limit_utilisation{cause}`; warn-log `would_limit` at
 *   most once per minute.
 *
 * Fail-open: a limiter error, a call slower than the timeout (250 ms
 * default), an open circuit breaker (shared `ConsoleRateLimitBreaker`
 * class, its own instance) or any unexpected error is counted `fail_open`
 * and swallowed. Under a flood with Redis stalled the breaker stops the
 * waiting, so the ioredis offline queue does not grow without bound.
 *
 * Privacy (RT-629 OBS-1, redaction matrix §3.2): the IP is PII. It appears
 * ONLY in the Redis key (the `signin_ip` precedent), never in a metric label
 * or a log field. The log throttle is keyed by a fixed set of strings, never
 * by IP, so memory stays bounded under a flood. Cookies and tokens are never
 * read beyond "is one present".
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { readBearerToken, readSessionCookie, type AuthedRequest } from "../auth/auth.guard";
import { RateLimiter, type RateLimitDecision } from "../auth/rate-limit";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { ConsoleRateLimitBreaker } from "../console-rate-limit/circuit-breaker";
import {
  recordPreAuthRateLimit,
  recordPreAuthRateLimitUtilisation,
  type PreAuthRateLimitCause,
  type PreAuthRateLimitOutcome,
} from "../observability/metrics/preauth-rate-limit.metrics";
import {
  PREAUTH_RATE_LIMIT_BREAKER,
  PREAUTH_RATE_LIMIT_BUCKET_NAME,
  PREAUTH_RATE_LIMIT_CONFIG,
  PREAUTH_RATE_LIMIT_LOG_INTERVAL_MS,
  PREAUTH_RATE_LIMIT_NEAR_LIMIT_RATIO,
  type PreAuthRateLimitConfig,
} from "./preauth-rate-limit.config";

/** DI token for an injectable clock (tests); defaults to `Date.now`. */
export const PREAUTH_RATE_LIMIT_CLOCK = "PREAUTH_RATE_LIMIT_CLOCK";

class PreAuthLimiterTimeout extends Error {
  override readonly name = "PreAuthLimiterTimeout";
}

function errClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** `bad_token` when a cookie or bearer was presented (and refused), else `missing`. */
export function preAuthFailureCause(request: AuthedRequest): PreAuthRateLimitCause {
  return readSessionCookie(request) !== null || readBearerToken(request) !== null ? "bad_token" : "missing";
}

/** Same expression as the sign-in per-IP bucket (`auth.controller.ts`): honours `trust proxy`. */
function clientIp(request: AuthedRequest): string {
  return request.ip ?? request.socket?.remoteAddress ?? "unknown";
}

@Injectable()
export class PreAuthRateLimitReporter {
  private readonly breaker: ConsoleRateLimitBreaker;
  private readonly lastLogAt = new Map<string, number>();

  constructor(
    @Inject(PREAUTH_RATE_LIMIT_CONFIG) private readonly config: PreAuthRateLimitConfig,
    private readonly rateLimiter: RateLimiter,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
    @Optional() @Inject(PREAUTH_RATE_LIMIT_CLOCK) private readonly now: () => number = Date.now,
  ) {
    this.breaker = new ConsoleRateLimitBreaker(PREAUTH_RATE_LIMIT_BREAKER, () => this.now());
  }

  /** Count one failed-auth request. Resolves always; never throws. */
  async report(request: AuthedRequest): Promise<void> {
    if (this.config.mode !== "report") return;
    try {
      await this.count(request);
    } catch (err) {
      // A bug here must never turn a 401 into a 500.
      this.warnThrottled("internal", { err_class: errClass(err) }, "pre-auth rate limit: reporter error (request unaffected)");
    }
  }

  private async count(request: AuthedRequest): Promise<void> {
    const cause = preAuthFailureCause(request);
    const decision = await this.checkWithinBounds(cause, clientIp(request));
    if (decision === null) return;

    const { limit } = this.config.bucket;
    recordPreAuthRateLimitUtilisation({ cause }, decision.count / limit);
    const outcome = this.outcomeOf(decision, limit);
    recordPreAuthRateLimit({ cause, outcome });
    if (outcome === "would_limit") {
      this.warnThrottled(
        "would_limit",
        { cause, outcome },
        "pre-auth rate limit: client over the failed-auth ceiling (report only; request unaffected)",
      );
    }
  }

  /** The limiter decision, or null when it failed open (already counted). */
  private async checkWithinBounds(cause: PreAuthRateLimitCause, ip: string): Promise<RateLimitDecision | null> {
    if (!this.breaker.tryAcquire()) {
      this.failOpen(cause, "BreakerOpen");
      return null;
    }
    try {
      const decision = await this.withTimeout(
        this.rateLimiter.check(PREAUTH_RATE_LIMIT_BUCKET_NAME, ip, this.config.bucket),
      );
      this.breaker.onSuccess();
      return decision;
    } catch (err) {
      this.breaker.onFailure();
      this.failOpen(cause, errClass(err));
      return null;
    }
  }

  private outcomeOf(decision: RateLimitDecision, limit: number): PreAuthRateLimitOutcome {
    if (!decision.allowed) return "would_limit";
    return decision.count / limit >= PREAUTH_RATE_LIMIT_NEAR_LIMIT_RATIO ? "near_limit" : "allowed";
  }

  private failOpen(cause: PreAuthRateLimitCause, errName: string): void {
    recordPreAuthRateLimit({ cause, outcome: "fail_open" });
    this.warnThrottled(
      "fail_open",
      { cause, err_class: errName },
      "pre-auth rate limit: limiter unavailable; not counted (request unaffected)",
    );
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PreAuthLimiterTimeout()), this.config.timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `key` is one of a fixed set ("would_limit", "fail_open", "internal"), never an IP. */
  private warnThrottled(key: string, fields: Record<string, string>, message: string): void {
    const now = this.now();
    const last = this.lastLogAt.get(key);
    if (last !== undefined && now - last < PREAUTH_RATE_LIMIT_LOG_INTERVAL_MS) return;
    this.lastLogAt.set(key, now);
    this.logger?.warn(fields, message);
  }
}
