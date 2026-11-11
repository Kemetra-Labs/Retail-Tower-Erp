/**
 * voucher-lookup-limit.ts — RT-1112: the failed-lookup rate limit of V-A
 * validate and redeem (ADR 0009; owner decision 3, RT-1112 c16636).
 *
 * The per-device limiter of the POS routes, reused: the same `RateLimiter`, a
 * bucket in `POS_WRITE_RATE_LIMIT_BUCKETS` (`posVoucherLookupFailure`, about 10
 * per 15 minutes per device), the same 429 body and `Retry-After` clamp as
 * `PosWriteRateLimitGuard`, and the same fail-open rule (D3: a limiter or Redis
 * failure allows the request and logs a warning).
 *
 * Only FAILED lookups spend the budget. The pairing precedent
 * (`pairingInvalidGlobal`): every lookup takes a hit first (`take`), and a
 * lookup that found its voucher or intent gives it back (`giveBack`). What stays
 * counted is `voucher_not_found` (including another tenant's code) and
 * `intent_token_not_found` (unknown, another tenant's or another store's
 * token). The check runs after the cashier claim (the guard) and before the
 * lookup, so a code is never looked up for a device over its budget.
 *
 * The guard itself cannot do this: it would count every request and cannot give
 * a hit back once the lookup succeeds, and on redeem it would also spend the
 * budget on idempotent replays, which never reach a lookup.
 */
import { HttpException, HttpStatus, Inject, Injectable, Optional } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";

import { POS_WRITE_RATE_LIMIT_BUCKETS, RateLimiter } from "../auth/rate-limit";
import { ROOT_LOGGER } from "../common/logging.interceptor";

export const VOUCHER_LOOKUP_BUCKET = "posVoucherLookupFailure" as const;

/** A device over its failed-lookup budget: the 429, with `Retry-After` seconds. */
export class VoucherLookupRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("voucher lookup rate limited");
    this.name = "VoucherLookupRateLimited";
  }
}

/** The 429 body of the per-device limiter (`PosWriteRateLimitGuard`). */
export function rateLimitedException(): HttpException {
  return new HttpException({ code: "RATE_LIMITED", message: "Too many requests." }, HttpStatus.TOO_MANY_REQUESTS);
}

/** A token for one lookup's hit: `null` when the limiter failed open (nothing to give back). */
export type LookupHit = { readonly deviceId: string } | null;

@Injectable()
export class VoucherLookupLimiter {
  constructor(
    private readonly limiter: RateLimiter,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Pick<Logger, "warn">,
  ) {}

  /** Take one hit for `deviceId`; throws `VoucherLookupRateLimited` over budget. */
  async take(deviceId: string): Promise<LookupHit> {
    let decision;
    try {
      decision = await this.limiter.check(VOUCHER_LOOKUP_BUCKET, deviceId, POS_WRITE_RATE_LIMIT_BUCKETS[VOUCHER_LOOKUP_BUCKET]);
    } catch (err) {
      this.logger?.warn({ err, event: "voucher.lookup_limit.fail_open" }, "VoucherLookupLimiter: rate-limiter unavailable; failing open (request allowed)");
      return null;
    }
    if (!decision.allowed) {
      throw new VoucherLookupRateLimited(Math.min(300, Math.max(1, Math.ceil(Math.max(0, decision.resetMs) / 1000))));
    }
    return { deviceId };
  }

  /** The lookup found what it looked for: the hit was not a failure. Never throws. */
  async giveBack(hit: LookupHit): Promise<void> {
    if (hit === null) return;
    try {
      await this.limiter.release(VOUCHER_LOOKUP_BUCKET, hit.deviceId);
    } catch (err) {
      this.logger?.warn({ err, event: "voucher.lookup_limit.release_failed" }, "VoucherLookupLimiter: release failed; the hit stays until its window ends");
    }
  }
}
