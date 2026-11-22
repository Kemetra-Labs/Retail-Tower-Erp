/**
 * RT-1403 (RT-530 owner decision c12029; [GATED: contract] approval: RT-1403
 * c18071; the separate route: c18113) — SaleVoidAuthGuard unit spec. Docker-free.
 *
 * `recordCashierVoid` is the DEVICE-only cashier counterpart of `recordVoid`
 * (which stays the manager and admin envelope route). The guard: PosDeviceAuthGuard
 * resolves the device, the strict cashier-void body is validated, and the cashier
 * verifier (a cashier admission live NOW on the paired device, plus live
 * eligibility) must accept. Only then is the verified cashier published as the
 * actor, which is what binds the void's requester to the admitted cashier (the
 * service's `requesterIsActor`).
 *
 * Refusals: a bad, revoked or missing device credential (an operator envelope
 * included) is the generic 401; a refused cashier claim from an AUTHENTICATED
 * device is the generic 403 `refused`, one body for every cause. A device 401
 * means "device revoked" to the POS, so a refused void must never look like one.
 */
import "reflect-metadata";

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { ZodError } from "zod";

import type { Principal } from "../../../../src/auth/auth.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import type { DeviceScope } from "../../../../src/pos-cashier-admissions/device-scope";
import {
  SALE_VOID_CASHIER_REFUSAL_EVENTS,
  SaleVoidAuthGuard,
} from "../../../../src/catalog/sales/sale-capture-auth.guard";
import {
  PgSaleVoidCashierVerifier,
  TRACKED_LINE_CASHIER_REFUSAL_EVENTS,
  type SaleVoidCashierVerdict,
  type SaleVoidCashierVerifier,
} from "../../../../src/pos-cashier-admissions/tracked-line-cashier";
import type { CashierEligibilityReader } from "../../../../src/pos-cashier-admissions/cashier-eligibility";

const TENANT_ID = "0a1403aa-0000-4000-8000-000000000001";
const STORE_ID = "0a1403aa-0000-4000-8000-000000000002";
const DEVICE_ID = "0a1403aa-0000-4000-8000-000000000003";
const CASHIER_ID = "0a1403aa-0000-4000-8000-000000000004";
const MANAGER_ID = "0a1403aa-0000-4000-8000-000000000005";
const SALE_REF = "0a1403aa-0000-4000-8000-0000000000a1";
const APPROVAL_ID = "0a1403aa-0000-4000-8000-0000000000b1";

interface FakeRequest {
  headers: Record<string, string>;
  body: unknown;
  requestId?: string;
  context?: ResolvedContext;
  principal?: Principal;
  posDeviceId?: string;
}

function voidBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-pulse",
    externalId: "pos-pulse-void:rt1403-unit-1",
    businessDate: "2026-11-21",
    approval: {
      approvalId: APPROVAL_ID,
      action: "sale.void",
      saleRef: SALE_REF,
      amount: "5.00",
      requesterUserId: CASHIER_ID,
      approverUserId: MANAGER_ID,
      policyVersion: "v1",
      approvedAt: "2026-11-21T09:59:00.000Z",
    },
    operatorUserId: CASHIER_ID,
    ...extra,
  };
}

function ctxFor(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }),
  } as unknown as ExecutionContext;
}

/** The device guard publishes exactly what PosDeviceAuthGuard publishes. */
function deviceGuardAccepting(): { canActivate: jest.Mock } {
  return {
    canActivate: jest.fn(async (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<FakeRequest>();
      req.principal = {
        kind: "token",
        tokenId: DEVICE_ID,
        tenantId: TENANT_ID,
        userId: null,
        storeId: STORE_ID,
        scope: "pos",
      };
      req.context = {
        userId: null,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        isPlatformAdmin: false,
        source: "token",
      };
      req.posDeviceId = DEVICE_ID;
      return true;
    }),
  };
}

function deviceGuardRefusing(): { canActivate: jest.Mock } {
  return {
    canActivate: jest.fn(async () => {
      throw new UnauthorizedException("Unauthorized");
    }),
  };
}

function verifier(
  verdict: SaleVoidCashierVerdict,
): SaleVoidCashierVerifier & { verify: jest.Mock } {
  return { verify: jest.fn(async (_scope: DeviceScope, _userId: string) => verdict) };
}

function makeGuard(opts: {
  device?: { canActivate: jest.Mock };
  cashier?: SaleVoidCashierVerifier & { verify: jest.Mock };
}) {
  const device = opts.device ?? deviceGuardAccepting();
  const cashier = opts.cashier ?? verifier({ ok: true });
  const logger = { warn: jest.fn() };
  const guard = new SaleVoidAuthGuard(cashier, device, logger);
  return { guard, device, cashier, logger };
}

function bearerRequest(body: unknown): FakeRequest {
  return { headers: { authorization: "Bearer device-token" }, body, requestId: "req-1" };
}

describe("SaleVoidAuthGuard — the cashier route is device-only", () => {
  it("always runs the device guard first, whatever the body carries", async () => {
    for (const body of [voidBody(), undefined, "operatorUserId", [voidBody()]]) {
      const t = makeGuard({});
      await t.guard.canActivate(ctxFor(bearerRequest(body))).catch(() => undefined);
      expect(t.device.canActivate).toHaveBeenCalledTimes(1);
    }
  });

  it("an operator envelope (or any non-device bearer) is the device guard's generic 401, nothing else runs", async () => {
    const t = makeGuard({ device: deviceGuardRefusing() });
    const req = bearerRequest(voidBody());
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(t.cashier.verify).not.toHaveBeenCalled();
    expect(req.context).toBeUndefined();
  });

  it("there is no envelope path: a body without operatorUserId is a 400 from the strict body, never an envelope fallback", async () => {
    const t = makeGuard({});
    const { operatorUserId: _omit, ...withoutClaim } = voidBody();
    await expect(t.guard.canActivate(ctxFor(bearerRequest(withoutClaim)))).rejects.toBeInstanceOf(ZodError);
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });
});

describe("SaleVoidAuthGuard — device path", () => {
  it("verifies the claimed cashier against the DEVICE's scope (tenant, store, device from the device row)", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(voidBody())));
    expect(t.cashier.verify).toHaveBeenCalledTimes(1);
    expect(t.cashier.verify).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID },
      CASHIER_ID,
    );
  });

  it("on success publishes the VERIFIED cashier as the actor (context + principal), keeps the device", async () => {
    const t = makeGuard({});
    const req = bearerRequest(voidBody());
    await expect(t.guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.context).toEqual({
      userId: CASHIER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    });
    expect(req.principal).toEqual({
      kind: "token",
      tokenId: DEVICE_ID,
      tenantId: TENANT_ID,
      userId: CASHIER_ID,
      storeId: STORE_ID,
      scope: "pos",
    });
    expect(req.posDeviceId).toBe(DEVICE_ID);
  });

  it("an unauthenticated device with a malformed body is still a 401, never a 400", async () => {
    const t = makeGuard({ device: deviceGuardRefusing() });
    const req = bearerRequest({ operatorUserId: "not-a-uuid" });
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("an authenticated device with a malformed operatorUserId is the usual validation 400", async () => {
    const t = makeGuard({});
    const req = bearerRequest(voidBody({ operatorUserId: "not-a-uuid" }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });

  it("operatorUserId: null is a 400 too", async () => {
    const t = makeGuard({});
    await expect(
      t.guard.canActivate(ctxFor(bearerRequest(voidBody({ operatorUserId: null })))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });

  it("an authenticated device whose body smuggles scope fields is a 400 (strict body)", async () => {
    const t = makeGuard({});
    const req = bearerRequest(voidBody({ tenantId: TENANT_ID, createdBy: CASHIER_ID }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS))(
    "refusal %s -> the same generic 403 refused (never the device's 401), and the cashier is never published",
    async (cause) => {
      const t = makeGuard({
        cashier: verifier({ ok: false, cause } as SaleVoidCashierVerdict),
      });
      const req = bearerRequest(voidBody());
      const err = await t.guard.canActivate(ctxFor(req)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getStatus()).toBe(403);
      expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
      expect(req.context?.userId ?? null).toBeNull();
      expect(req.principal?.userId ?? null).toBeNull();
    },
  );

  it("the approval's requester is the service's check, not the guard's: another requester still passes the guard", async () => {
    // The guard publishes the claimed-and-verified cashier. A body whose
    // approval names ANOTHER requester still passes the guard; the service
    // refuses it (`void_requester_mismatch`), covered by void-approval.spec.ts
    // and the device-path integration spec.
    const t = makeGuard({});
    const body = voidBody();
    (body["approval"] as Record<string, unknown>)["requesterUserId"] = MANAGER_ID;
    const req = bearerRequest(body);
    await expect(t.guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.context?.userId).toBe(CASHIER_ID);
  });
});

describe("SaleVoidAuthGuard — refusal log (redaction matrix)", () => {
  const ALLOWED = new Set(["event", "request_id", "tenant_id", "store_id", "status", "outcome"]);

  it("logs one warn with allowlisted fields and a closed-set event name", async () => {
    const t = makeGuard({ cashier: verifier({ ok: false, cause: "no_live_admission" }) });
    const req = bearerRequest(voidBody());
    await t.guard.canActivate(ctxFor(req)).catch(() => undefined);
    expect(t.logger.warn).toHaveBeenCalledTimes(1);
    const fields = t.logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(fields).filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(fields).toEqual({
      event: SALE_VOID_CASHIER_REFUSAL_EVENTS.no_live_admission,
      request_id: "req-1",
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      status: 403,
      outcome: "failure",
    });
    // Never the claimed user, the token, the approval or the sale.
    const serialized = JSON.stringify(t.logger.warn.mock.calls[0]);
    expect(serialized).not.toContain(CASHIER_ID);
    expect(serialized).not.toContain(MANAGER_ID);
    expect(serialized).not.toContain(SALE_REF);
    expect(serialized).not.toContain("device-token");
  });

  it("covers every refusal cause of the shared verifier plus the suspension, with fixed, distinct event names", () => {
    expect(Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS).sort()).toEqual(
      [...Object.keys(TRACKED_LINE_CASHIER_REFUSAL_EVENTS), "suspended"].sort(),
    );
    expect(SALE_VOID_CASHIER_REFUSAL_EVENTS.suspended).toBe("sale_void.operator_refused.suspended");
    for (const name of Object.values(SALE_VOID_CASHIER_REFUSAL_EVENTS)) {
      expect(name).toMatch(/^sale_void\.operator_refused\.[a-z_]+$/);
    }
    expect(new Set(Object.values(SALE_VOID_CASHIER_REFUSAL_EVENTS)).size).toBe(
      Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS).length,
    );
  });

  it("a success logs nothing", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(voidBody())));
    expect(t.logger.warn).not.toHaveBeenCalled();
  });
});

describe("PgSaleVoidCashierVerifier — suspension (review H2)", () => {
  const SCOPE: DeviceScope = { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID };

  /** A pool whose tenant-scoped client answers the live-admission query, and records every query. */
  function poolWith(live: boolean): { pool: never; queries: string[] } {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || /set_config|SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [{ live }], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    return { pool: { connect: jest.fn(async () => client) } as never, queries };
  }

  function eligibility(opts: { eligible: boolean; suspended: boolean }): CashierEligibilityReader & {
    isSuspended: jest.Mock;
  } {
    return {
      check: jest.fn(async () =>
        opts.eligible
          ? { eligible: true as const, displayName: "Cashier", operatorId: "op-1" }
          : { eligible: false as const, reason: "membership_inactive" as const },
      ),
      isSuspended: jest.fn(async () => opts.suspended),
      roster: jest.fn(),
    } as never;
  }

  it("accepts a live, eligible, NOT suspended cashier", async () => {
    const e = eligibility({ eligible: true, suspended: false });
    const v = new PgSaleVoidCashierVerifier(poolWith(true).pool, e);
    await expect(v.verify(SCOPE, CASHIER_ID)).resolves.toEqual({ ok: true });
    expect(e.isSuspended).toHaveBeenCalledTimes(1);
  });

  it("refuses a suspended cashier even with a live admission and eligibility (cause suspended)", async () => {
    const e = eligibility({ eligible: true, suspended: true });
    const v = new PgSaleVoidCashierVerifier(poolWith(true).pool, e);
    await expect(v.verify(SCOPE, CASHIER_ID)).resolves.toEqual({ ok: false, cause: "suspended" });
  });

  it("no live admission wins and never reads eligibility or the suspension", async () => {
    const e = eligibility({ eligible: true, suspended: true });
    const v = new PgSaleVoidCashierVerifier(poolWith(false).pool, e);
    await expect(v.verify(SCOPE, CASHIER_ID)).resolves.toEqual({ ok: false, cause: "no_live_admission" });
    expect(e.isSuspended).not.toHaveBeenCalled();
  });

  it("an ineligible cashier is refused with the eligibility cause before the suspension is read", async () => {
    const e = eligibility({ eligible: false, suspended: true });
    const v = new PgSaleVoidCashierVerifier(poolWith(true).pool, e);
    await expect(v.verify(SCOPE, CASHIER_ID)).resolves.toEqual({ ok: false, cause: "membership_inactive" });
    expect(e.isSuspended).not.toHaveBeenCalled();
  });
});
