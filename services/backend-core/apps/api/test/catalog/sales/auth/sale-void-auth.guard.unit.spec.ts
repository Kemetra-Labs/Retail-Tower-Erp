/**
 * RT-1403 (RT-530 owner decision c12029; [GATED: contract] approval: RT-1403
 * c18071) — SaleVoidAuthGuard unit spec. Docker-free.
 *
 * recordVoid accepts two alternative credentials, the captureSale model:
 *
 *   - the operator-authorization envelope (unchanged, RT-530): the body
 *     carries no `operatorUserId`, so the guard hands the request to
 *     PosOperatorEnvelopeSaleGuard and does nothing else;
 *   - the device bearer + `operatorUserId`: the presence of the field selects
 *     this path. PosDeviceAuthGuard resolves the device, the strict void body
 *     is validated, and the cashier verifier (a cashier admission live NOW on
 *     the paired device, plus live eligibility) must accept. Only then is the
 *     verified cashier published as the actor, which is what binds the void's
 *     requester to the admitted cashier (the service's `requesterIsActor`).
 *
 * Refusals: a bad, revoked or missing device credential is the generic 401; a
 * refused cashier claim from an AUTHENTICATED device is the generic 403
 * `refused`, one body for every cause. A device 401 means "device revoked" to
 * the POS, so a refused void must never look like one.
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
  TRACKED_LINE_CASHIER_REFUSAL_EVENTS,
  type TrackedLineCashierVerdict,
  type TrackedLineCashierVerifier,
} from "../../../../src/catalog/sales/tracked-lines/tracked-line-cashier";

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
  verdict: TrackedLineCashierVerdict,
): TrackedLineCashierVerifier & { verify: jest.Mock } {
  return { verify: jest.fn(async (_scope: DeviceScope, _userId: string) => verdict) };
}

function makeGuard(opts: {
  envelope?: { canActivate: jest.Mock };
  device?: { canActivate: jest.Mock };
  cashier?: TrackedLineCashierVerifier & { verify: jest.Mock };
}) {
  const envelope = opts.envelope ?? { canActivate: jest.fn(async () => true) };
  const device = opts.device ?? deviceGuardAccepting();
  const cashier = opts.cashier ?? verifier({ ok: true });
  const logger = { warn: jest.fn() };
  const guard = new SaleVoidAuthGuard(cashier, envelope, device, logger);
  return { guard, envelope, device, cashier, logger };
}

function bearerRequest(body: unknown): FakeRequest {
  return { headers: { authorization: "Bearer device-token" }, body, requestId: "req-1" };
}

describe("SaleVoidAuthGuard — path selection", () => {
  it("a body without operatorUserId takes the envelope path only (unchanged behaviour)", async () => {
    const t = makeGuard({});
    await expect(t.guard.canActivate(ctxFor(bearerRequest(voidBody())))).resolves.toBe(true);
    expect(t.envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(t.device.canActivate).not.toHaveBeenCalled();
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });

  it("an envelope refusal propagates unchanged", async () => {
    const refusal = new UnauthorizedException("Unauthorized");
    const t = makeGuard({ envelope: { canActivate: jest.fn(async () => Promise.reject(refusal)) } });
    await expect(t.guard.canActivate(ctxFor(bearerRequest(voidBody())))).rejects.toBe(refusal);
    expect(t.device.canActivate).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing body", undefined],
    ["an array body", [voidBody({ operatorUserId: CASHIER_ID })]],
    ["a string body", "operatorUserId"],
  ])("%s takes the envelope path", async (_label, body) => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(body)));
    expect(t.envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(t.device.canActivate).not.toHaveBeenCalled();
  });

  it("operatorUserId selects the device path; the envelope guard never runs", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(voidBody({ operatorUserId: CASHIER_ID }))));
    expect(t.device.canActivate).toHaveBeenCalledTimes(1);
    expect(t.envelope.canActivate).not.toHaveBeenCalled();
  });

  it("operatorUserId: null still selects the device path (and fails validation, 400)", async () => {
    const t = makeGuard({});
    await expect(
      t.guard.canActivate(ctxFor(bearerRequest(voidBody({ operatorUserId: null })))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(t.envelope.canActivate).not.toHaveBeenCalled();
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });
});

describe("SaleVoidAuthGuard — device path", () => {
  it("verifies the claimed cashier against the DEVICE's scope (tenant, store, device from the device row)", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(voidBody({ operatorUserId: CASHIER_ID }))));
    expect(t.cashier.verify).toHaveBeenCalledTimes(1);
    expect(t.cashier.verify).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID },
      CASHIER_ID,
    );
  });

  it("on success publishes the VERIFIED cashier as the actor (context + principal), keeps the device", async () => {
    const t = makeGuard({});
    const req = bearerRequest(voidBody({ operatorUserId: CASHIER_ID }));
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

  it("an unauthenticated device is a 401 and nothing else runs", async () => {
    const t = makeGuard({ device: deviceGuardRefusing() });
    const req = bearerRequest(voidBody({ operatorUserId: CASHIER_ID }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(t.cashier.verify).not.toHaveBeenCalled();
    expect(req.context).toBeUndefined();
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

  it("an authenticated device whose body smuggles scope fields is a 400 (strict body)", async () => {
    const t = makeGuard({});
    const req = bearerRequest(
      voidBody({ operatorUserId: CASHIER_ID, tenantId: TENANT_ID, createdBy: CASHIER_ID }),
    );
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.cashier.verify).not.toHaveBeenCalled();
  });

  it.each(Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS))(
    "refusal %s -> the same generic 403 refused (never the device's 401), and the cashier is never published",
    async (cause) => {
      const t = makeGuard({
        cashier: verifier({ ok: false, cause } as TrackedLineCashierVerdict),
      });
      const req = bearerRequest(voidBody({ operatorUserId: CASHIER_ID }));
      const err = await t.guard.canActivate(ctxFor(req)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getStatus()).toBe(403);
      expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
      expect(req.context?.userId ?? null).toBeNull();
      expect(req.principal?.userId ?? null).toBeNull();
    },
  );

  it("the void is requested by the verified cashier only: the approval's requester is the service's check, not the guard's", async () => {
    // The guard publishes the claimed-and-verified cashier. A body whose
    // approval names ANOTHER requester still passes the guard; the service
    // refuses it (`void_requester_mismatch`), covered by void-approval.spec.ts.
    const t = makeGuard({});
    const body = voidBody({ operatorUserId: CASHIER_ID });
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
    const req = bearerRequest(voidBody({ operatorUserId: CASHIER_ID }));
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

  it("covers every refusal cause of the shared verifier, with fixed, distinct event names", () => {
    expect(Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS).sort()).toEqual(
      Object.keys(TRACKED_LINE_CASHIER_REFUSAL_EVENTS).sort(),
    );
    for (const name of Object.values(SALE_VOID_CASHIER_REFUSAL_EVENTS)) {
      expect(name).toMatch(/^sale_void\.operator_refused\.[a-z_]+$/);
    }
    expect(new Set(Object.values(SALE_VOID_CASHIER_REFUSAL_EVENTS)).size).toBe(
      Object.keys(SALE_VOID_CASHIER_REFUSAL_EVENTS).length,
    );
  });

  it("a success logs nothing", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(bearerRequest(voidBody({ operatorUserId: CASHIER_ID }))));
    expect(t.logger.warn).not.toHaveBeenCalled();
  });
});
