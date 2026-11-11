/**
 * RT-1112 — the V-A credential gates, without a database:
 *   - validate: device (401) → strict body (400 `validation_failure`) → live
 *     cashier claim (generic 403 `refused`, logged with allowlisted fields
 *     only) → the verified cashier is published;
 *   - redeem: a stored SUCCESSFUL replay of this device, key and exact body
 *     skips the claim (owner decision 1, RT-1112 c16636); a miss, an in-flight
 *     claim, a different body, a stored non-200, a non-replayable marker, a
 *     malformed key or a lookup failure all go through the claim first.
 */
import "reflect-metadata";

import { BadRequestException, ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { IdempotencyKeyStore } from "@data-pulse-2/shared";

import type { TrackedLineCashierVerifier } from "../../src/catalog/sales/tracked-lines/tracked-line-cashier";
import { bodyFingerprint, deviceClientKey } from "../../src/idempotency/idempotency.interceptor";
import { nonReplayableMarker } from "../../src/idempotency/non-replayable";
import { composeStoreKey } from "../../src/idempotency/store-key";
import type { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import {
  RedeemVoucherAuthGuard,
  ValidateVoucherAuthGuard,
  type VoucherRequest,
} from "../../src/vouchers-pos/voucher-cashier-auth.guard";

const TENANT = "0a111200-0000-4000-8000-000000000001";
const STORE = "0a111200-0000-4000-8000-000000000002";
const DEVICE = "0a111200-0000-4000-8000-000000000003";
const CASHIER = "0a111200-0000-4000-8000-000000000004";
const ATTEMPT = "0a111200-0000-4000-8000-000000000005";
const KEY = "rt1112-unit-key-00000001";
const REDEEM_PATH = "/api/pos/v1/vouchers/redeem";

const validateBody = () => ({
  operatorUserId: CASHIER,
  code: "ABCD-EFGH-JKMN-PQRS",
  payment_attempt_id: ATTEMPT,
  applied_amount_minor: 500,
  remaining_balance_minor: 1000,
});
const redeemBody = () => ({ operatorUserId: CASHIER, redemption_intent_token: "t".repeat(43), payment_attempt_id: ATTEMPT });

/** A device guard that publishes the device scope, or rejects like the real one. */
function deviceGuard(ok = true): PosDeviceAuthGuard {
  return {
    canActivate: async (ctx: ExecutionContext) => {
      if (!ok) throw new UnauthorizedException("Unauthorized");
      const req = ctx.switchToHttp().getRequest<VoucherRequest>();
      req.posDeviceId = DEVICE;
      req.context = { userId: null, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" };
      return true;
    },
  } as unknown as PosDeviceAuthGuard;
}

class StubVerifier implements TrackedLineCashierVerifier {
  calls = 0;
  constructor(private readonly ok: boolean) {}
  async verify() {
    this.calls += 1;
    return this.ok ? ({ ok: true } as const) : ({ ok: false, cause: "no_live_admission" } as const);
  }
}

function http(body: unknown, key: string | null = KEY): { ctx: ExecutionContext; req: VoucherRequest } {
  const req = {
    method: "POST",
    url: REDEEM_PATH,
    route: { path: REDEEM_PATH },
    params: {},
    headers: key === null ? {} : { "idempotency-key": key },
    body,
    requestId: "0a111200-0000-4000-8000-0000000000ff",
  } as unknown as VoucherRequest;
  return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext, req };
}

/** A replay store answering `findOrCreate` with `answer`, recording its arguments. */
function store(answer: unknown | Error): { store: IdempotencyKeyStore; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    store: {
      findOrCreate: async (...args: unknown[]) => {
        calls.push(args);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as IdempotencyKeyStore,
  };
}

const stored = (status: number, body: unknown) => ({
  hit: true,
  entry: { fingerprint: Buffer.alloc(0), result: { status, body }, expiresAt: new Date(Date.now() + 60_000) },
});

describe("ValidateVoucherAuthGuard", () => {
  it("publishes the verified cashier with the device's scope", async () => {
    const verifier = new StubVerifier(true);
    const { ctx, req } = http(validateBody());
    await expect(new ValidateVoucherAuthGuard(deviceGuard(), verifier).canActivate(ctx)).resolves.toBe(true);
    expect(req.context).toMatchObject({ userId: CASHIER, tenantId: TENANT, storeId: STORE });
    expect(req.principal).toMatchObject({ userId: CASHIER, tokenId: DEVICE, scope: "pos" });
    expect(req.voucherReplay).toBeUndefined();
  });

  it("is the generic 401 before the body or the claim when the device token fails", async () => {
    const verifier = new StubVerifier(true);
    await expect(new ValidateVoucherAuthGuard(deviceGuard(false), verifier).canActivate(http({}).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(verifier.calls).toBe(0);
  });

  it.each([
    ["an unknown field", { ...validateBody(), tenant_id: TENANT }],
    ["a missing operatorUserId", { ...validateBody(), operatorUserId: undefined }],
    ["a zero applied amount (a voucher is consumed whole)", { ...validateBody(), applied_amount_minor: 0 }],
    ["an amount above 2^53 - 1", { ...validateBody(), remaining_balance_minor: Number.MAX_SAFE_INTEGER + 2 }],
    ["a fractional amount", { ...validateBody(), applied_amount_minor: 1.5 }],
  ])("is 400 validation_failure for %s, before the claim", async (_case, body) => {
    const verifier = new StubVerifier(true);
    const err = await new ValidateVoucherAuthGuard(deviceGuard(), verifier).canActivate(http(body).ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: "validation_failure" });
    expect(verifier.calls).toBe(0);
  });

  it("refuses a claim with the generic 403 `refused` and logs only allowlisted fields", async () => {
    const warnings: Array<[Record<string, unknown>, string]> = [];
    const guard = new ValidateVoucherAuthGuard(deviceGuard(), new StubVerifier(false), {
      warn: (obj: Record<string, unknown>, msg: string) => void warnings.push([obj, msg]),
    } as never);
    const err = await guard.canActivate(http(validateBody()).ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
    expect(warnings).toHaveLength(1);
    expect(Object.keys(warnings[0]![0]).sort()).toEqual(["event", "outcome", "request_id", "status", "store_id", "tenant_id"]);
    expect(warnings[0]![0]["event"]).toBe("voucher.claim_refused.no_live_admission");
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain(CASHIER);
    expect(logged).not.toContain("ABCD");
  });
});

describe("RedeemVoucherAuthGuard — the stored replay before the admission check", () => {
  it("skips the claim for a stored 200 of this device, key and exact body, and marks the request", async () => {
    const verifier = new StubVerifier(false);
    const replay = store(stored(200, { kind: "redeemed" }));
    const { ctx, req } = http(redeemBody());
    await expect(new RedeemVoucherAuthGuard(deviceGuard(), verifier, replay.store).canActivate(ctx)).resolves.toBe(true);
    expect(verifier.calls).toBe(0);
    expect(req.voucherReplay).toBe(true);
    // No cashier is published on the replay path.
    expect(req.context?.userId).toBeNull();
    // The interceptor's own key: tenant, no store, the device partition, the route template and the header.
    const clientId = deviceClientKey(DEVICE);
    expect(replay.calls).toEqual([
      [TENANT, null, clientId, composeStoreKey({ method: "POST", routePath: REDEEM_PATH, params: {} }, clientId, KEY), bodyFingerprint(redeemBody())],
    ]);
  });

  it.each([
    ["a miss", { hit: false, entry: null }],
    ["a different body (collision)", { hit: "collision" }],
    ["an in-flight claim", { hit: "in_progress" }],
    ["a stored non-200", stored(404, { error: { code: "intent_token_not_found" } })],
    ["a stored non-replayable marker", stored(200, nonReplayableMarker({ redemption_id: "x" }, []))],
    ["a lookup failure", new Error("redis down")],
  ])("checks the claim first on %s (a refused claim stays the 403)", async (_case, answer) => {
    const verifier = new StubVerifier(false);
    const replay = store(answer);
    const { ctx, req } = http(redeemBody());
    await expect(new RedeemVoucherAuthGuard(deviceGuard(), verifier, replay.store).canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(verifier.calls).toBe(1);
    expect(req.voucherReplay).toBeUndefined();
  });

  it.each([
    ["no Idempotency-Key", null],
    ["a malformed Idempotency-Key", "short"],
  ])("does not look anything up with %s", async (_case, key) => {
    const verifier = new StubVerifier(true);
    const replay = store(stored(200, {}));
    await expect(new RedeemVoucherAuthGuard(deviceGuard(), verifier, replay.store).canActivate(http(redeemBody(), key).ctx)).resolves.toBe(true);
    expect(replay.calls).toEqual([]);
    expect(verifier.calls).toBe(1);
  });

  it("never looks up a replay for an unauthenticated device", async () => {
    const replay = store(stored(200, {}));
    await expect(
      new RedeemVoucherAuthGuard(deviceGuard(false), new StubVerifier(true), replay.store).canActivate(http(redeemBody()).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(replay.calls).toEqual([]);
  });
});
