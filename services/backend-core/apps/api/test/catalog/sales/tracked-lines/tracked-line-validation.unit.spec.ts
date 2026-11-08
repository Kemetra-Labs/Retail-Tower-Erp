/**
 * Jira RT-451 slice S2 — unit cases for the TLV (no database): the check order
 * of the pure rules, the strict request body, and the credential composite's
 * device path (body first, then the live cashier claim, generic 403).
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ZodError } from "zod";

import type { DeviceScope } from "../../../../src/pos-cashier-admissions/device-scope";
import {
  TRACKED_LINE_CASHIER_REFUSAL_EVENTS,
  type TrackedLineCashierVerdict,
  type TrackedLineCashierVerifier,
} from "../../../../src/catalog/sales/tracked-lines/tracked-line-cashier";
import { TrackedLineValidationAuthGuard } from "../../../../src/catalog/sales/tracked-lines/tracked-line-validation-auth.guard";
import {
  isRealDay,
  ValidateTrackedLineRequestSchema,
} from "../../../../src/catalog/sales/tracked-lines/tracked-line-validation.dto";
import {
  identityRefusal,
  productRefusal,
  type TrackedLineIdentityFacts,
} from "../../../../src/catalog/sales/tracked-lines/tracked-line-validation.rules";

const PRODUCT = "0a451200-0000-4000-8000-00000000f001";
const OTHER_PRODUCT = "0a451200-0000-4000-8000-00000000f002";
const USER = "0a451200-0000-4000-8000-00000000c002";
const TODAY = "2026-11-08";

describe("productRefusal (checks 1 and 2)", () => {
  it.each<[string, { trackingMode: string; sellableAtStore: boolean }, string | null]>([
    ["a sellable batch product", { trackingMode: "batch", sellableAtStore: true }, null],
    ["a product not sellable at the store", { trackingMode: "batch", sellableAtStore: false }, "not_sellable"],
    ["a serial product (Q11)", { trackingMode: "serial", sellableAtStore: true }, "not_sellable"],
    ["an untracked product", { trackingMode: "none", sellableAtStore: true }, "profile_mismatch"],
    ["an untracked product not sellable (not_sellable first)", { trackingMode: "none", sellableAtStore: false }, "not_sellable"],
  ])("%s → %s", (_why, product, reason) => {
    expect(productRefusal(product)).toBe(reason);
  });
});

describe("identityRefusal (checks 3 to 7, first failure wins)", () => {
  const lot = (over: Partial<TrackedLineIdentityFacts> = {}): TrackedLineIdentityFacts => ({
    productId: PRODUCT,
    expiryDate: null,
    recallHold: false,
    qualityHold: false,
    ...over,
  });
  const decide = (identity: TrackedLineIdentityFacts | null) =>
    identityRefusal({ productId: PRODUCT, identity, businessDate: TODAY });

  it.each<[string, TrackedLineIdentityFacts | null, string | null]>([
    ["no identity", null, "unknown_identity"],
    ["another product's, recalled, held and expired", lot({ productId: OTHER_PRODUCT, recallHold: true, qualityHold: true, expiryDate: "2000-01-01" }), "wrong_product"],
    ["recalled, held and expired", lot({ recallHold: true, qualityHold: true, expiryDate: "2000-01-01" }), "recalled"],
    ["held and expired", lot({ qualityHold: true, expiryDate: "2000-01-01" }), "held"],
    ["expired the day before", lot({ expiryDate: "2026-11-07" }), "expired"],
    ["expiring on the business date (G7-5, inclusive)", lot({ expiryDate: TODAY }), null],
    ["expiring later", lot({ expiryDate: "2027-01-01" }), null],
    ["without an expiry", lot(), null],
  ])("%s → %s", (_why, identity, reason) => {
    expect(decide(identity)).toBe(reason);
  });
});

describe("ValidateTrackedLineRequestSchema (strict body)", () => {
  const body = { productId: PRODUCT, identity: { code: "LOT-1" }, quantity: "1", selection: "scanned", draftLineRef: "d1" };
  const parse = (over: Record<string, unknown>) => ValidateTrackedLineRequestSchema.safeParse({ ...body, ...over });

  it("accepts the identity by id or by code (with a scanned expiry), and an optional cashier claim", () => {
    expect(parse({ identity: { identityId: OTHER_PRODUCT } }).success).toBe(true);
    expect(parse({ identity: { code: "LOT-1", expiryDate: "2028-02-29" } }).success).toBe(true);
    expect(parse({ operatorUserId: USER }).success).toBe(true);
    expect(parse({ quantity: "9999999999999.999999" }).success).toBe(true);
    // Code points, as JSON Schema maxLength and char_length count: 128 emoji are 256 UTF-16 units.
    expect(parse({ identity: { code: "\u{1F600}".repeat(128) } }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["both id and code", { identity: { identityId: OTHER_PRODUCT, code: "LOT-1" } }],
    ["neither", { identity: {} }],
    ["an expiry with the id", { identity: { identityId: OTHER_PRODUCT, expiryDate: "2028-01-01" } }],
    ["an unknown identity key", { identity: { code: "LOT-1", batch: "x" } }],
    ["a 129-character code", { identity: { code: "x".repeat(129) } }],
    ["a zero quantity", { quantity: "0.000" }],
    ["a 14-digit quantity", { quantity: "12345678901234" }],
    ["a negative quantity", { quantity: "-1" }],
    ["an unknown selection", { selection: "fefo" }],
    ["a 101-character draftLineRef", { draftLineRef: "d".repeat(101) }],
    ["a non-uuid operatorUserId", { operatorUserId: "cashier" }],
    ["a body-supplied store", { storeId: PRODUCT }],
    ["a NUL in the draftLineRef", { draftLineRef: "d\u0000" }],
    ["a lone surrogate in the code", { identity: { code: "\uD800" } }],
    ["a 129-code-point code", { identity: { code: "\u{1F600}".repeat(129) } }],
  ])("refuses %s", (_why, over) => {
    expect(parse(over).success).toBe(false);
  });

  it.each([
    ["2028-02-29", true],
    ["2027-02-29", false],
    ["0001-01-01", true],
    ["0000-01-01", false],
    ["9999-12-31", true],
    ["2027-13-01", false],
    ["2027-1-01", false],
  ])("isRealDay(%s) is %s", (value, expected) => {
    expect(isRealDay(value)).toBe(expected);
  });
});

describe("TrackedLineValidationAuthGuard (the captureSale model, a claim live NOW)", () => {
  const SCOPE: DeviceScope = {
    deviceId: "0a451200-0000-4000-8000-00000000e001",
    tenantId: "0a451200-0000-4000-8000-000000000001",
    storeId: "0a451200-0000-4000-8000-0000000000a1",
  };
  const valid = { productId: PRODUCT, identity: { code: "LOT-1" }, quantity: "1", selection: "scanned", draftLineRef: "d1" };

  function gate(outcome: "allow" | Error, onAllow?: (req: Record<string, unknown>) => void) {
    const g = {
      calls: 0,
      async canActivate(ctx: ExecutionContext): Promise<boolean> {
        g.calls += 1;
        if (outcome instanceof Error) throw outcome;
        onAllow?.(ctx.switchToHttp().getRequest());
        return true;
      },
    };
    return g as CanActivate & { calls: number };
  }

  const publishDevice = (req: Record<string, unknown>): void => {
    req["posDeviceId"] = SCOPE.deviceId;
    req["context"] = { tenantId: SCOPE.tenantId, storeId: SCOPE.storeId, userId: null, isPlatformAdmin: false, source: "token" };
  };

  function context(body: unknown): { ctx: ExecutionContext; req: Record<string, unknown> } {
    const req: Record<string, unknown> = { body, requestId: "r1" };
    return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext, req };
  }

  function verifier(verdict: TrackedLineCashierVerdict) {
    const v = {
      calls: [] as Array<{ scope: DeviceScope; userId: string }>,
      async verify(scope: DeviceScope, userId: string): Promise<TrackedLineCashierVerdict> {
        v.calls.push({ scope, userId });
        return verdict;
      },
    };
    return v as TrackedLineCashierVerifier & typeof v;
  }

  it("without the claim: the envelope alone, never the device or the verifier", async () => {
    const envelope = gate("allow");
    const device = gate("allow");
    const cashier = verifier({ ok: true });
    const { ctx } = context(valid);
    await expect(new TrackedLineValidationAuthGuard(cashier, envelope, device).canActivate(ctx)).resolves.toBe(true);
    expect([envelope.calls, device.calls, cashier.calls.length]).toEqual([1, 0, 0]);
  });

  it("with the claim: the device first, then the verifier; the verified cashier is published with the device's scope", async () => {
    const cashier = verifier({ ok: true });
    const { ctx, req } = context({ ...valid, operatorUserId: USER });
    const guard = new TrackedLineValidationAuthGuard(cashier, gate("allow"), gate("allow", publishDevice));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(cashier.calls).toEqual([{ scope: SCOPE, userId: USER }]);
    expect(req["context"]).toMatchObject({ userId: USER, tenantId: SCOPE.tenantId, storeId: SCOPE.storeId });
  });

  it("a bad device credential is its 401, before the body or the claim is read", async () => {
    const cashier = verifier({ ok: true });
    const refusal = new UnauthorizedException("Unauthorized");
    const { ctx } = context({ operatorUserId: USER, junk: true });
    const guard = new TrackedLineValidationAuthGuard(cashier, gate("allow"), gate(refusal));
    await expect(guard.canActivate(ctx)).rejects.toBe(refusal);
    expect(cashier.calls).toEqual([]);
  });

  it("a malformed body from an authenticated device is the 400 (ZodError), before the claim", async () => {
    const cashier = verifier({ ok: true });
    const { ctx } = context({ ...valid, quantity: "0", operatorUserId: USER });
    const guard = new TrackedLineValidationAuthGuard(cashier, gate("allow"), gate("allow", publishDevice));
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ZodError);
    expect(cashier.calls).toEqual([]);
  });

  it.each(Object.keys(TRACKED_LINE_CASHIER_REFUSAL_EVENTS))(
    "a refused claim (%s) is the generic 403 `refused`, logged once with its fixed event and no user",
    async (cause) => {
      const warn = jest.fn();
      const { ctx } = context({ ...valid, operatorUserId: USER });
      const guard = new TrackedLineValidationAuthGuard(
        verifier({ ok: false, cause } as TrackedLineCashierVerdict),
        gate("allow"),
        gate("allow", publishDevice),
        { warn },
      );
      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields] = warn.mock.calls[0]!;
      expect(fields).toMatchObject({ event: TRACKED_LINE_CASHIER_REFUSAL_EVENTS[cause as keyof typeof TRACKED_LINE_CASHIER_REFUSAL_EVENTS], status: 403 });
      expect(JSON.stringify(fields)).not.toContain(USER);
    },
  );
});
