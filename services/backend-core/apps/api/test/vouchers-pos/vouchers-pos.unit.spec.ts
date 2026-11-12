/**
 * RT-1112 — the V-A pieces that need no database:
 *   - the refusal → HTTP status mapping (404 / 400 / 409 per operation; RT-1343:
 *     a reverse of a redemption a sale pays with is a 409);
 *   - the failed-lookup limiter (ADR 0009): take, give back, the Retry-After
 *     clamp, fail-open on a limiter error;
 *   - the controller: a limiter refusal is the 429 `RATE_LIMITED` with
 *     `Retry-After`; a replay-path request that reaches the handler is refused;
 *   - the interceptor's `replayBodyOverrides`.
 */
import "reflect-metadata";

import { ForbiddenException, HttpException, HttpStatus } from "@nestjs/common";

import { POS_WRITE_RATE_LIMIT_BUCKETS, type RateLimitDecision, type RateLimiter } from "../../src/auth/rate-limit";
import { withReplayOverrides } from "../../src/idempotency/idempotency.interceptor";
import { VOUCHER_LOOKUP_BUCKET, VoucherLookupLimiter, VoucherLookupRateLimited } from "../../src/vouchers-pos/voucher-lookup-limit";
import type { VoucherRequest } from "../../src/vouchers-pos/voucher-cashier-auth.guard";
import { VouchersPosController } from "../../src/vouchers-pos/vouchers-pos.controller";
import { refusalStatus, toHttpRefusal, VoucherRefusal } from "../../src/vouchers-pos/vouchers-pos.errors";
import type { VouchersPosService } from "../../src/vouchers-pos/vouchers-pos.service";

const DEVICE = "0a111200-0000-4000-8000-000000000003";

describe("refusal statuses (pos-payments/vouchers.yaml)", () => {
  it.each([
    ["validate", "voucher_not_found", 404],
    ["validate", "voucher_cancelled", 400],
    ["validate", "voucher_already_redeemed", 400],
    ["validate", "voucher_expired", 400],
    ["validate", "voucher_branch_mismatch", 400],
    ["validate", "non_cash_overpayment_refused", 400],
    ["redeem", "intent_token_not_found", 404],
    ["redeem", "intent_token_expired", 400],
    ["redeem", "intent_token_payment_attempt_mismatch", 400],
    ["redeem", "voucher_already_redeemed", 409],
    ["redeem", "voucher_cancelled", 409],
    ["redeem", "voucher_expired", 409],
    ["redeem", "voucher_branch_mismatch", 409],
    ["reverse", "redemption_not_found", 404],
    ["reverse", "redemption_branch_mismatch", 400],
    ["reverse", "redemption_consumed_by_sale", 409],
  ] as const)("%s %s → %i", (operation, code, status) => {
    expect(refusalStatus(operation, code)).toBe(status);
    const http = toHttpRefusal(operation, new VoucherRefusal(code));
    expect(http.getStatus()).toBe(status);
    expect(http.getResponse()).toEqual({ code, message: expect.any(String) });
  });
});

class FakeLimiter {
  decision: RateLimitDecision = { allowed: true, count: 1, remaining: 9, resetMs: 60_000 };
  fail: "check" | "release" | null = null;
  readonly checks: Array<[string, string, unknown]> = [];
  readonly releases: Array<[string, string]> = [];
  async check(bucket: string, id: string, config: unknown): Promise<RateLimitDecision> {
    this.checks.push([bucket, id, config]);
    if (this.fail === "check") throw new Error("redis down");
    return this.decision;
  }
  async release(bucket: string, id: string): Promise<void> {
    this.releases.push([bucket, id]);
    if (this.fail === "release") throw new Error("redis down");
  }
}

describe("VoucherLookupLimiter (ADR 0009, owner decision 3)", () => {
  it("uses a per-device bucket of 10 failures per 15 minutes", () => {
    expect(POS_WRITE_RATE_LIMIT_BUCKETS[VOUCHER_LOOKUP_BUCKET]).toEqual({ limit: 10, windowMs: 15 * 60 * 1000 });
  });

  it("takes a hit per lookup and gives it back when the lookup found something", async () => {
    const fake = new FakeLimiter();
    const limiter = new VoucherLookupLimiter(fake as unknown as RateLimiter);
    const hit = await limiter.take(DEVICE);
    await limiter.giveBack(hit);
    expect(fake.checks).toEqual([[VOUCHER_LOOKUP_BUCKET, DEVICE, POS_WRITE_RATE_LIMIT_BUCKETS[VOUCHER_LOOKUP_BUCKET]]]);
    expect(fake.releases).toEqual([[VOUCHER_LOOKUP_BUCKET, DEVICE]]);
  });

  it.each([
    [90_500, 91],
    [0, 1],
    [-1, 1],
    [3_600_000, 300],
  ])("over budget throws with Retry-After clamped to [1, 300] (resetMs %i → %i)", async (resetMs, seconds) => {
    const fake = new FakeLimiter();
    fake.decision = { allowed: false, count: 11, remaining: 0, resetMs };
    const err = await new VoucherLookupLimiter(fake as unknown as RateLimiter).take(DEVICE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoucherLookupRateLimited);
    expect((err as VoucherLookupRateLimited).retryAfterSeconds).toBe(seconds);
  });

  it("fails open on a limiter error (D3) and has nothing to give back", async () => {
    const fake = new FakeLimiter();
    fake.fail = "check";
    const warnings: unknown[] = [];
    const limiter = new VoucherLookupLimiter(fake as unknown as RateLimiter, { warn: (o: unknown) => void warnings.push(o) });
    const hit = await limiter.take(DEVICE);
    expect(hit).toBeNull();
    await limiter.giveBack(hit);
    expect(fake.releases).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("never throws when the give-back fails", async () => {
    const fake = new FakeLimiter();
    fake.fail = "release";
    const limiter = new VoucherLookupLimiter(fake as unknown as RateLimiter, { warn: () => undefined });
    await expect(limiter.giveBack({ deviceId: DEVICE })).resolves.toBeUndefined();
  });
});

describe("VouchersPosController", () => {
  const TENANT = "0a111200-0000-4000-8000-000000000001";
  const STORE = "0a111200-0000-4000-8000-000000000002";
  const CASHIER = "0a111200-0000-4000-8000-000000000004";

  function request(extra: Partial<VoucherRequest> = {}): { req: VoucherRequest; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const req = {
      posDeviceId: DEVICE,
      context: { userId: CASHIER, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" },
      res: { setHeader: (k: string, v: string) => void (headers[k] = v) },
      ...extra,
    } as unknown as VoucherRequest;
    return { req, headers };
  }

  it("answers a spent lookup budget with 429 RATE_LIMITED and Retry-After", async () => {
    const service = { validate: async () => Promise.reject(new VoucherLookupRateLimited(42)) } as unknown as VouchersPosService;
    const { req, headers } = request();
    const err = await new VouchersPosController(service).validate(req, {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((err as HttpException).getResponse()).toEqual({ code: "RATE_LIMITED", message: "Too many requests." });
    expect(headers).toEqual({ "Retry-After": "42" });
  });

  it("maps a domain refusal per operation (redeem's voucher states are 409)", async () => {
    const service = { redeem: async () => Promise.reject(new VoucherRefusal("voucher_expired")) } as unknown as VouchersPosService;
    const err = await new VouchersPosController(service).redeem(request().req, {} as never).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(409);
  });

  it("refuses a replay-path redeem that reached the handler (the record lapsed in between): no cashier was verified", async () => {
    let ran = false;
    const service = { redeem: async () => void (ran = true) } as unknown as VouchersPosService;
    const { req } = request({ voucherReplay: true });
    await expect(new VouchersPosController(service).redeem(req, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ran).toBe(false);
  });

  it("refuses a validate without a verified cashier", async () => {
    const service = { validate: async () => undefined } as unknown as VouchersPosService;
    const { req } = request({ context: { userId: null, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" } });
    await expect(new VouchersPosController(service).validate(req, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("IdempotencyInterceptor replayBodyOverrides (RT-1112)", () => {
  it("sets the named fields of a replayed object body", () => {
    expect(withReplayOverrides({ kind: "redeemed", idempotent_replayed: false }, { idempotent_replayed: true })).toEqual({
      kind: "redeemed",
      idempotent_replayed: true,
    });
  });

  it.each([
    ["no overrides", { a: 1 }, null],
    ["an array body", [1], { x: true }],
    ["a null body", null, { x: true }],
    ["a string body", "ok", { x: true }],
  ])("replays %s unchanged", (_case, body, overrides) => {
    expect(withReplayOverrides(body, overrides)).toBe(body);
  });
});
