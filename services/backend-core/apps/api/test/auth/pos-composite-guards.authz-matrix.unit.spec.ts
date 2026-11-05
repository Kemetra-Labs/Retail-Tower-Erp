/**
 * RT-1229 — authorization matrix of the three composite POS guards.
 * Docker-free. Written BEFORE the composite-base refactor, so it must pass on
 * the old code and on the new one unchanged.
 *
 * Guards: SaleCaptureAuthGuard (captureSale), ShiftCashUpAuthGuard (the
 * cash-up writes) and SaleHistoryAuthGuard (the POS sale history, list and
 * reprint). Each is "the operator envelope, OR the device + a cashier claim".
 *
 * What runs for real: PosOperatorEnvelopeSaleGuard (canonical bearer lookup,
 * scope check, live re-verify) and PosDeviceAuthGuard (device row lookup),
 * both keyed by the bearer string. So the cross-credential cells are genuine:
 * a device token on the envelope path, an envelope token on the device path.
 *
 * What is in-memory: the repositories behind those two guards, the live
 * re-verifier, the attribution verifier and the admission selector. All of
 * them read one small WORLD below. The re-verifier follows the rule order of
 * OperatorContextResolver.reverify (device, membership, role in
 * owner/tenant_admin/store_manager, store access). The verifier and selector
 * check the admission window, then the real `classifyEligibility`. Their SQL
 * is covered against Postgres by the HTTP integration suites
 * (device-operator-capture, shift cash-up, sale-history).
 *
 * Every cell asserts the outcome (true, or the exact exception and body),
 * which collaborators ran and in what order, the published context and
 * principal, the refusal log events and, on the reprint route, the refusal
 * audit row.
 */
import "reflect-metadata";

import { ForbiddenException, HttpException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { OperatorReverifier } from "../../src/auth/operator-context-resolver";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../src/auth/pos-operator-envelope-sale.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import {
  SALE_REPRINT_ROUTE_KEY,
  SaleHistoryAuthGuard,
  type CashierAdmissionInput,
  type CashierAdmissionVerdict,
  type SaleHistoryRefusal,
} from "../../src/catalog/sales/history/sale-history-auth.guard";
import {
  ATTRIBUTION_REFUSAL_EVENTS,
  type AttributionVerdict,
  type OperatorAttributionInput,
} from "../../src/catalog/sales/operator-attribution";
import { SaleCaptureAuthGuard } from "../../src/catalog/sales/sale-capture-auth.guard";
import type { TenantContextRequest } from "../../src/context/types";
import { classifyEligibility, type Eligibility } from "../../src/pos-cashier-admissions/cashier-eligibility";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";
import {
  SHIFT_FACT_ROUTE_KEY,
  ShiftCashUpAuthGuard,
  shiftRefusalEvent,
  type ShiftFactRouteSpec,
} from "../../src/pos-shifts/shift-cash-up-auth.guard";
import { OpenShiftRequestSchema } from "../../src/pos-shifts/shift-cash-up.dto";

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const TENANT = "0c122900-0000-4000-8000-000000000001";
const STORE_A = "0c122900-0000-4000-8000-0000000000a1"; // the device's store
const STORE_B = "0c122900-0000-4000-8000-0000000000b1"; // another store of the tenant
const DEVICE_A = "0c122900-0000-4000-8000-0000000000e1";
const DEVICE_REVOKED = "0c122900-0000-4000-8000-0000000000e2";

const MANAGER = "0c122900-0000-4000-8000-0000000000d1"; // store_manager, all stores
const CASHIER = "0c122900-0000-4000-8000-0000000000d2"; // store_staff, STORE_A
const DELETED = "0c122900-0000-4000-8000-0000000000d3"; // store_staff, user and membership deleted
const PLATFORM_ADMIN = "0c122900-0000-4000-8000-0000000000d4"; // no membership in TENANT
const OTHER_STORE_MANAGER = "0c122900-0000-4000-8000-0000000000d5"; // store_manager, STORE_B only
const OTHER_STORE_CASHIER = "0c122900-0000-4000-8000-0000000000d6"; // store_staff, STORE_B only

const ADM_LIVE = "0c122900-0000-4000-8000-00000000aa01"; // CASHIER on DEVICE_A, live
const ADM_EXPIRED = "0c122900-0000-4000-8000-00000000aa02"; // CASHIER on DEVICE_A, expired
const ADM_OTHER_STORE = "0c122900-0000-4000-8000-00000000aa03"; // OTHER_STORE_CASHIER on DEVICE_A, STORE_B
const ADM_DELETED = "0c122900-0000-4000-8000-00000000aa04"; // DELETED on DEVICE_A, live
const ADM_PLATFORM = "0c122900-0000-4000-8000-00000000aa05"; // PLATFORM_ADMIN on DEVICE_A, live

/** "Now" for the in-memory windows, and the fact time every body carries. */
const NOW = Date.parse("2026-11-05T10:00:00.000Z");
const FACT_AT = "2026-11-05T09:59:00.000Z";
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** After ADM_EXPIRED ended and before ADM_LIVE began: no window of CASHIER covers it. */
const GAP_AT = new Date(NOW - 45 * MINUTE).toISOString();

type Role = "owner" | "tenant_admin" | "store_manager" | "store_staff";

interface WorldUser {
  readonly deleted: boolean;
  /** The user's membership in TENANT; null = none. */
  readonly membership: {
    readonly role: Role;
    readonly active: boolean;
    /** null = every store of the tenant. */
    readonly stores: readonly string[] | null;
  } | null;
}

/**
 * The deleted user's membership is soft-deleted with it. (The live re-verify
 * reads memberships, not users.deleted_at; this slice changes neither.)
 */
const USERS: Readonly<Record<string, WorldUser>> = {
  [MANAGER]: { deleted: false, membership: { role: "store_manager", active: true, stores: null } },
  [CASHIER]: { deleted: false, membership: { role: "store_staff", active: true, stores: [STORE_A] } },
  [DELETED]: { deleted: true, membership: { role: "store_staff", active: false, stores: [STORE_A] } },
  [PLATFORM_ADMIN]: { deleted: false, membership: null },
  [OTHER_STORE_MANAGER]: { deleted: false, membership: { role: "store_manager", active: true, stores: [STORE_B] } },
  [OTHER_STORE_CASHIER]: { deleted: false, membership: { role: "store_staff", active: true, stores: [STORE_B] } },
};

interface WorldDevice {
  readonly id: string;
  readonly storeId: string;
  readonly revoked: boolean;
}

/** Device tokens (the raw bearer) → devices rows. */
const DEVICE_TOKENS: Readonly<Record<string, WorldDevice>> = {
  "device-a": { id: DEVICE_A, storeId: STORE_A, revoked: false },
  "device-revoked": { id: DEVICE_REVOKED, storeId: STORE_A, revoked: true },
};

interface WorldEnvelope {
  readonly id: string;
  readonly userId: string;
  readonly storeId: string;
  readonly deviceId: string;
}

/** Operator envelopes (the raw bearer) → auth_tokens rows, scope pos_operator. */
const ENVELOPES: Readonly<Record<string, WorldEnvelope>> = {
  "env-manager": { id: "tok-manager", userId: MANAGER, storeId: STORE_A, deviceId: DEVICE_A },
  "env-manager-revoked-device": { id: "tok-mgr-rev", userId: MANAGER, storeId: STORE_A, deviceId: DEVICE_REVOKED },
  "env-wrong-store": { id: "tok-wrong-store", userId: OTHER_STORE_MANAGER, storeId: STORE_A, deviceId: DEVICE_A },
  "env-deleted": { id: "tok-deleted", userId: DELETED, storeId: STORE_A, deviceId: DEVICE_A },
  "env-staff": { id: "tok-staff", userId: CASHIER, storeId: STORE_A, deviceId: DEVICE_A },
  "env-platform": { id: "tok-platform", userId: PLATFORM_ADMIN, storeId: STORE_A, deviceId: DEVICE_A },
};

interface WorldAdmission {
  readonly userId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly createdAt: number;
  /** min(ended_at, expires_at). */
  readonly endsAt: number;
}

const ADMISSIONS: Readonly<Record<string, WorldAdmission>> = {
  [ADM_LIVE]: { userId: CASHIER, storeId: STORE_A, deviceId: DEVICE_A, createdAt: NOW - 30 * MINUTE, endsAt: NOW + HOUR },
  [ADM_EXPIRED]: { userId: CASHIER, storeId: STORE_A, deviceId: DEVICE_A, createdAt: NOW - 9 * HOUR, endsAt: NOW - HOUR },
  [ADM_OTHER_STORE]: { userId: OTHER_STORE_CASHIER, storeId: STORE_B, deviceId: DEVICE_A, createdAt: NOW - HOUR, endsAt: NOW + HOUR },
  [ADM_DELETED]: { userId: DELETED, storeId: STORE_A, deviceId: DEVICE_A, createdAt: NOW - HOUR, endsAt: NOW + HOUR },
  [ADM_PLATFORM]: { userId: PLATFORM_ADMIN, storeId: STORE_A, deviceId: DEVICE_A, createdAt: NOW - HOUR, endsAt: NOW + HOUR },
};

/** The RT-113 eligibility of `userId` at the device's store, through the real classifier. */
function eligibilityOf(userId: string, storeId: string): Eligibility {
  const user = USERS[userId];
  const m = user?.membership;
  if (user === undefined || m === null || m === undefined || !m.active) return classifyEligibility(undefined);
  return classifyEligibility({
    user_deleted: user.deleted,
    display_name: "Cashier",
    operator_id: "0042",
    role_eligible: m.role === "store_staff",
    store_active: true,
    store_accessible: m.stores === null || m.stores.includes(storeId),
  });
}

// ---------------------------------------------------------------------------
// In-memory collaborators (the "calls" log records the order they ran in)
// ---------------------------------------------------------------------------

interface Harness {
  readonly calls: string[];
  readonly warn: jest.Mock;
  readonly audits: SaleHistoryRefusal[];
  readonly envelope: PosOperatorEnvelopeSaleGuard;
  readonly device: PosDeviceAuthGuard;
  readonly envelopeGate: { canActivate(ctx: ExecutionContext): Promise<boolean> };
  readonly deviceGate: { canActivate(ctx: ExecutionContext): Promise<boolean> };
  readonly verifier: { verify(input: OperatorAttributionInput): Promise<AttributionVerdict> };
  readonly selector: { resolve(input: CashierAdmissionInput): Promise<CashierAdmissionVerdict> };
  readonly audit: { recordRefusal(refusal: SaleHistoryRefusal): Promise<void> };
}

function harness(opts: { auditFails?: boolean } = {}): Harness {
  const calls: string[] = [];
  const audits: SaleHistoryRefusal[] = [];

  const sessions = {
    findActiveByCredential: () => Promise.reject(new Error("no cookie in this matrix")),
  } as unknown as SessionRepository;
  const authTokens = {
    findActiveByRawToken: async (raw: string) => {
      const env = ENVELOPES[raw];
      if (env === undefined) return null;
      return { id: env.id, tenantId: TENANT, userId: env.userId, storeId: env.storeId, scope: "pos_operator" };
    },
  } as unknown as AuthTokenRepository;
  const reverifier: OperatorReverifier = {
    recoverDeviceId: async (tokenId) => Object.values(ENVELOPES).find((e) => e.id === tokenId)?.deviceId ?? null,
    reverify: async (userId, deviceId, storeId) => {
      const device = Object.values(DEVICE_TOKENS).find((d) => d.id === deviceId);
      if (device === undefined || device.revoked) return { kind: "refused", reason: "device_invalid" };
      const m = USERS[userId]?.membership ?? null;
      if (m === null) return { kind: "refused", reason: "membership_missing" };
      if (!m.active) return { kind: "refused", reason: "membership_revoked" };
      if (m.role === "store_staff") return { kind: "refused", reason: "role_ineligible" };
      if (m.stores !== null && !m.stores.includes(storeId)) return { kind: "refused", reason: "store_not_in_access_set" };
      return { kind: "ok" };
    },
  };
  const devices = {
    findActiveByAttestationWithExpiry: async (raw: string) => {
      const d = DEVICE_TOKENS[raw];
      if (d === undefined || d.revoked) return null;
      return {
        id: d.id,
        tenantId: TENANT,
        storeId: d.storeId,
        expiresAt: new Date(NOW + 90 * 24 * HOUR),
        presentedPreviousUntil: null,
      };
    },
  } as unknown as DeviceRepository;

  const envelope = new PosOperatorEnvelopeSaleGuard(sessions, authTokens, reverifier);
  const device = new PosDeviceAuthGuard(devices, new Reflector());

  const covering = (a: WorldAdmission | undefined, scope: { storeId: string; deviceId: string }, at: number) =>
    a !== undefined && a.storeId === scope.storeId && a.deviceId === scope.deviceId && a.createdAt <= at && at < a.endsAt;

  return {
    calls,
    audits,
    warn: jest.fn(),
    envelope,
    device,
    envelopeGate: {
      canActivate: (ctx) => {
        calls.push("envelope");
        return envelope.canActivate(ctx);
      },
    },
    deviceGate: {
      canActivate: (ctx) => {
        calls.push("device");
        return device.canActivate(ctx);
      },
    },
    verifier: {
      verify: async (input) => {
        calls.push("verify");
        expect(input.tenantId).toBe(TENANT);
        const at = Date.parse(input.admissionCheckAt ?? input.occurredAt);
        const any = Object.values(ADMISSIONS).some((a) => a.userId === input.userId && covering(a, input, at));
        if (!any) return { ok: false, cause: "no_covering_admission" };
        const e = eligibilityOf(input.userId, input.storeId);
        return e.eligible ? { ok: true } : { ok: false, cause: e.reason };
      },
    },
    selector: {
      resolve: async (input) => {
        calls.push("resolve");
        expect(input.tenantId).toBe(TENANT);
        const a = ADMISSIONS[input.admissionId];
        if (a === undefined || a.storeId !== input.storeId || a.deviceId !== input.deviceId) {
          return { ok: false, cause: "admission_unknown", userId: null };
        }
        const live = input.checkAt === null ? a.endsAt > NOW : covering(a, input, Date.parse(input.checkAt));
        if (!live) {
          return { ok: false, cause: input.checkAt === null ? "admission_not_live" : "admission_not_covering", userId: a.userId };
        }
        const e = eligibilityOf(a.userId, input.storeId);
        return e.eligible ? { ok: true, userId: a.userId } : { ok: false, cause: e.reason, userId: a.userId };
      },
    },
    audit: {
      recordRefusal: async (refusal) => {
        calls.push("audit");
        audits.push(refusal);
        if (opts.auditFails === true) throw new Error("audit store down");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Requests and outcomes
// ---------------------------------------------------------------------------

type Req = TenantContextRequest & { params?: Record<string, string> };

function requestWith(bearer: string, body: unknown, headers: Record<string, string> = {}, params: Record<string, string> = {}): Req {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, ...headers },
    cookies: {},
    params,
    body,
    requestId: "0c122900-0000-4000-8000-0000000000ff",
  } as unknown as Req;
}

function ctxFor(request: Req, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Object,
  } as unknown as ExecutionContext;
}

/** What a cell expects: allowed with an actor, or a refusal with its status and body. */
type Expected =
  | { readonly allow: { readonly userId: string; readonly scope: "pos" | "pos_operator" } }
  | { readonly status: 400 | 401 | 403 };

const REFUSED_BODY = { code: "refused", message: "Forbidden" };

async function outcomeOf(run: () => Promise<boolean>): Promise<true | HttpException | Error> {
  try {
    const result = await run();
    expect(result).toBe(true);
    return true;
  } catch (err) {
    return err as Error;
  }
}

function statusOf(err: Error): number {
  if (err instanceof HttpException) return err.getStatus();
  if (err.name === "ZodError") return 400; // the global filter maps a ZodError to the 400 validation_error
  return 500;
}

/** The shared assertions of every cell: outcome, published actor, nothing published on a refusal. */
function assertOutcome(result: true | Error, request: Req, expected: Expected, deviceStore = STORE_A): void {
  if ("allow" in expected) {
    expect(result).toBe(true);
    const { userId, scope } = expected.allow;
    expect(request.context).toEqual({
      userId,
      tenantId: TENANT,
      storeId: deviceStore,
      isPlatformAdmin: false,
      source: "token",
    });
    expect(request.principal).toMatchObject({ kind: "token", tenantId: TENANT, userId, storeId: deviceStore, scope });
    expect(request.posDeviceId).toBe(DEVICE_A);
    return;
  }
  expect(result).not.toBe(true);
  const err = result as Error;
  expect(statusOf(err)).toBe(expected.status);
  if (expected.status === 403) {
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual(REFUSED_BODY);
  }
  if (expected.status === 401) expect((err as HttpException).getResponse()).toMatchObject({ statusCode: 401, message: "Unauthorized" });
  // A refused request never publishes a person as the request's actor.
  expect(request.context?.userId ?? null).toBeNull();
  const principal = request.principal;
  if (principal?.kind === "token" && principal.scope === "pos") expect(principal.userId).toBeNull();
}

/** The refusal log events of a run (event field only), in order. */
function events(h: Harness): string[] {
  return h.warn.mock.calls.map((c) => (c[0] as { event: string }).event);
}

/** Every refusal log line is the allowlisted shape and names no user, token or body. */
function assertRedacted(h: Harness): void {
  for (const [fields] of h.warn.mock.calls as [Record<string, unknown>][]) {
    const allowed = new Set(["event", "request_id", "tenant_id", "store_id", "status", "outcome", "err_class"]);
    expect(Object.keys(fields).filter((k) => !allowed.has(k))).toEqual([]);
    const s = JSON.stringify(fields);
    for (const secret of [CASHIER, DELETED, PLATFORM_ADMIN, MANAGER, OTHER_STORE_CASHIER, "device-a", "env-", FACT_AT, GAP_AT]) {
      expect(s).not.toContain(secret);
    }
  }
}

// ---------------------------------------------------------------------------
// SaleCaptureAuthGuard
// ---------------------------------------------------------------------------

const saleBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceSystem: "pos-pulse",
  externalId: "rt1229-matrix-1",
  currencyCode: "EGP",
  posTotal: "5.00",
  occurredAt: FACT_AT,
  lines: [{ lineName: "Tea", unitPrice: "5.00", currencyCode: "EGP", quantity: "1", lineAmount: "5.00", unit: "unit" }],
  ...extra,
});

interface Cell {
  readonly name: string;
  readonly bearer: string;
  /** The claimed cashier (device path); undefined = envelope path. */
  readonly claim?: string;
  readonly expected: Expected;
  readonly calls: readonly string[];
  readonly events: readonly string[];
}

const captureEvent = (cause: keyof typeof ATTRIBUTION_REFUSAL_EVENTS) => ATTRIBUTION_REFUSAL_EVENTS[cause];

const CAPTURE_MATRIX: readonly Cell[] = [
  { name: "envelope only (store_manager)", bearer: "env-manager", expected: { allow: { userId: MANAGER, scope: "pos_operator" } }, calls: ["envelope"], events: [] },
  { name: "device only (no claim) → the envelope path's generic 401", bearer: "device-a", expected: { status: 401 }, calls: ["envelope"], events: [] },
  { name: "envelope token carrying a claim → device auth's generic 401", bearer: "env-manager", claim: CASHIER, expected: { status: 401 }, calls: ["device"], events: [] },
  { name: "revoked device + claim → 401, nothing else runs", bearer: "device-revoked", claim: CASHIER, expected: { status: 401 }, calls: ["device"], events: [] },
  { name: "envelope bound to a revoked device → 401 (live re-verify)", bearer: "env-manager-revoked-device", expected: { status: 401 }, calls: ["envelope"], events: [] },
  { name: "device + store_staff claim with a live admission → allowed as the cashier", bearer: "device-a", claim: CASHIER, expected: { allow: { userId: CASHIER, scope: "pos" } }, calls: ["device", "verify"], events: [] },
  { name: "store_staff holding an envelope → 401 (role not eligible)", bearer: "env-staff", expected: { status: 401 }, calls: ["envelope"], events: [] },
  { name: "wrong store: the claimed cashier's only admission is another store's → 403", bearer: "device-a", claim: OTHER_STORE_CASHIER, expected: { status: 403 }, calls: ["device", "verify"], events: [captureEvent("no_covering_admission")] },
  { name: "wrong store: envelope of a manager without access to the store → 401", bearer: "env-wrong-store", expected: { status: 401 }, calls: ["envelope"], events: [] },
  { name: "deleted user claimed on the device → 403", bearer: "device-a", claim: DELETED, expected: { status: 403 }, calls: ["device", "verify"], events: [captureEvent("membership_inactive")] },
  { name: "deleted user's envelope → 401", bearer: "env-deleted", expected: { status: 401 }, calls: ["envelope"], events: [] },
  { name: "platform admin without membership, claimed on the device → 403", bearer: "device-a", claim: PLATFORM_ADMIN, expected: { status: 403 }, calls: ["device", "verify"], events: [captureEvent("membership_inactive")] },
  { name: "platform admin without membership, own envelope → 401", bearer: "env-platform", expected: { status: 401 }, calls: ["envelope"], events: [] },
];

describe("RT-1229 matrix — SaleCaptureAuthGuard", () => {
  const capture = (h: Harness) => new SaleCaptureAuthGuard(h.envelopeGate, h.deviceGate, h.verifier, { warn: h.warn });

  it.each(CAPTURE_MATRIX.map((c) => [c.name, c] as const))("%s", async (_name, cell) => {
    const h = harness();
    const body = cell.claim === undefined ? saleBody() : saleBody({ operatorUserId: cell.claim });
    const request = requestWith(cell.bearer, body);
    const result = await outcomeOf(() => capture(h).canActivate(ctxFor(request, () => undefined)));
    assertOutcome(result, request, cell.expected);
    expect(h.calls).toEqual(cell.calls);
    expect(events(h)).toEqual(cell.events);
    assertRedacted(h);
  });

  it("expired admission: a sale after the admission ended → 403 no_covering_admission", async () => {
    const h = harness();
    // An ended admission still covers sales inside its window; this sale is after it.
    const request = requestWith("device-a", saleBody({ operatorUserId: CASHIER, occurredAt: GAP_AT }));
    const result = await outcomeOf(() => capture(h).canActivate(ctxFor(request, () => undefined)));
    assertOutcome(result, request, { status: 403 });
    expect(h.calls).toEqual(["device", "verify"]);
    expect(events(h)).toEqual([captureEvent("no_covering_admission")]);
  });

  it("an unauthenticated device with a malformed body is the 401, never the 400 (auth first)", async () => {
    const h = harness();
    const request = requestWith("device-revoked", { operatorUserId: "not-a-uuid" });
    const result = await outcomeOf(() => capture(h).canActivate(ctxFor(request, () => undefined)));
    assertOutcome(result, request, { status: 401 });
    expect(h.calls).toEqual(["device"]);
  });

  it("an authenticated device with a malformed body is the 400, before the verifier", async () => {
    const h = harness();
    const request = requestWith("device-a", saleBody({ operatorUserId: "not-a-uuid" }));
    const result = await outcomeOf(() => capture(h).canActivate(ctxFor(request, () => undefined)));
    assertOutcome(result, request, { status: 400 });
    expect(h.calls).toEqual(["device"]);
  });
});

// ---------------------------------------------------------------------------
// ShiftCashUpAuthGuard (openShift: stated user = the claim)
// ---------------------------------------------------------------------------

const OPEN_ROUTE: ShiftFactRouteSpec = { schema: OpenShiftRequestSchema, timeField: "openedAt", actorField: "openingUserId" };
const openHandler = (): void => undefined;
Reflect.defineMetadata(SHIFT_FACT_ROUTE_KEY, OPEN_ROUTE, openHandler);

const openBody = (opening: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab01",
  openedAt: FACT_AT,
  openingUserId: opening,
  currencyCode: "EGP",
  openingFloat: "500.00",
  ...extra,
});

const SHIFT_MATRIX: readonly Cell[] = CAPTURE_MATRIX.map((c) => ({
  ...c,
  events: c.events.map((e) => shiftRefusalEvent(e.slice("sale.capture.operator_refused.".length) as never)),
}));

describe("RT-1229 matrix — ShiftCashUpAuthGuard", () => {
  const shift = (h: Harness) => new ShiftCashUpAuthGuard(h.envelopeGate, h.deviceGate, h.verifier, { warn: h.warn });

  it.each(SHIFT_MATRIX.map((c) => [c.name, c] as const))("%s", async (_name, cell) => {
    const h = harness();
    const body = cell.claim === undefined ? openBody(MANAGER) : openBody(cell.claim, { operatorUserId: cell.claim });
    const request = requestWith(cell.bearer, body);
    const result = await outcomeOf(() => shift(h).canActivate(ctxFor(request, openHandler)));
    assertOutcome(result, request, cell.expected);
    expect(h.calls).toEqual(cell.calls);
    expect(events(h)).toEqual(cell.events);
    assertRedacted(h);
  });

  it("expired admission → 403 no_covering_admission", async () => {
    const h = harness();
    const request = requestWith("device-a", openBody(CASHIER, { operatorUserId: CASHIER, openedAt: GAP_AT }));
    const result = await outcomeOf(() => shift(h).canActivate(ctxFor(request, openHandler)));
    assertOutcome(result, request, { status: 403 });
    expect(events(h)).toEqual([shiftRefusalEvent("no_covering_admission")]);
  });

  it("a claim whose stated user differs → 403 actor_mismatch, before the verifier", async () => {
    const h = harness();
    const request = requestWith("device-a", openBody(MANAGER, { operatorUserId: CASHIER }));
    const result = await outcomeOf(() => shift(h).canActivate(ctxFor(request, openHandler)));
    assertOutcome(result, request, { status: 403 });
    expect(h.calls).toEqual(["device"]);
    expect(events(h)).toEqual([shiftRefusalEvent("actor_mismatch")]);
  });

  it("a route without its spec is a 500 before any credential is checked", async () => {
    const h = harness();
    const request = requestWith("device-a", openBody(CASHIER, { operatorUserId: CASHIER }));
    const result = await outcomeOf(() => shift(h).canActivate(ctxFor(request, () => undefined)));
    expect(result).not.toBe(true);
    expect(statusOf(result as Error)).toBe(500);
    expect(h.calls).toEqual([]);
  });

  it("an unauthenticated device with a malformed body is the 401, never the 400", async () => {
    const h = harness();
    const request = requestWith("device-revoked", { operatorUserId: "not-a-uuid" });
    const result = await outcomeOf(() => shift(h).canActivate(ctxFor(request, openHandler)));
    assertOutcome(result, request, { status: 401 });
    expect(h.calls).toEqual(["device"]);
  });
});

// ---------------------------------------------------------------------------
// SaleHistoryAuthGuard (list and reprint; the cashier selected by header)
// ---------------------------------------------------------------------------

const listHandler = (): void => undefined;
const reprintHandler = (): void => undefined;
Reflect.defineMetadata(SALE_REPRINT_ROUTE_KEY, true, reprintHandler);
const SALE_REF = "0c122900-0000-4000-8000-0000000000c1";
const REPRINT_BODY = { mode: "authorize", kind: "duplicate", printedAt: FACT_AT };

interface HistoryCell {
  readonly name: string;
  readonly bearer: string;
  /** The X-Cashier-Admission header; undefined = no header. */
  readonly admission?: string;
  readonly expected: Expected;
  readonly calls: readonly string[];
  /** The refusal reason (log event suffix and audit reason); undefined = none. */
  readonly reason?: string;
  /** The audit row's actor on the reprint route. */
  readonly auditActor?: string | null;
}

const HISTORY_MATRIX: readonly HistoryCell[] = [
  { name: "envelope only (store_manager)", bearer: "env-manager", expected: { allow: { userId: MANAGER, scope: "pos_operator" } }, calls: ["envelope"] },
  { name: "device only (no header) → probe, then 403 admission_missing", bearer: "device-a", expected: { status: 403 }, calls: ["envelope", "device"], reason: "admission_missing", auditActor: null },
  { name: "envelope token carrying the header → device auth's generic 401", bearer: "env-manager", admission: ADM_LIVE, expected: { status: 401 }, calls: ["device"] },
  { name: "revoked device + header → 401, nothing else runs", bearer: "device-revoked", admission: ADM_LIVE, expected: { status: 401 }, calls: ["device"] },
  { name: "revoked device, no header → envelope 401, probe 401 → 401", bearer: "device-revoked", expected: { status: 401 }, calls: ["envelope", "device"] },
  { name: "envelope bound to a revoked device → 401, probe refuses too", bearer: "env-manager-revoked-device", expected: { status: 401 }, calls: ["envelope", "device"] },
  { name: "device + store_staff's live admission → allowed as the cashier", bearer: "device-a", admission: ADM_LIVE, expected: { allow: { userId: CASHIER, scope: "pos" } }, calls: ["device", "resolve"] },
  { name: "store_staff holding an envelope → 401", bearer: "env-staff", expected: { status: 401 }, calls: ["envelope", "device"] },
  { name: "expired admission → 403 admission_not_live", bearer: "device-a", admission: ADM_EXPIRED, expected: { status: 403 }, calls: ["device", "resolve"], reason: "admission_not_live", auditActor: CASHIER },
  { name: "wrong store: another store's admission → 403 admission_unknown", bearer: "device-a", admission: ADM_OTHER_STORE, expected: { status: 403 }, calls: ["device", "resolve"], reason: "admission_unknown", auditActor: null },
  { name: "wrong store: envelope of a manager without access to the store → 401", bearer: "env-wrong-store", expected: { status: 401 }, calls: ["envelope", "device"] },
  { name: "deleted user's admission → 403 membership_inactive", bearer: "device-a", admission: ADM_DELETED, expected: { status: 403 }, calls: ["device", "resolve"], reason: "membership_inactive", auditActor: DELETED },
  { name: "deleted user's envelope → 401", bearer: "env-deleted", expected: { status: 401 }, calls: ["envelope", "device"] },
  { name: "platform admin without membership, admission → 403 membership_inactive", bearer: "device-a", admission: ADM_PLATFORM, expected: { status: 403 }, calls: ["device", "resolve"], reason: "membership_inactive", auditActor: PLATFORM_ADMIN },
  { name: "platform admin without membership, own envelope → 401", bearer: "env-platform", expected: { status: 401 }, calls: ["envelope", "device"] },
];

describe("RT-1229 matrix — SaleHistoryAuthGuard", () => {
  const history = (h: Harness) =>
    new SaleHistoryAuthGuard(h.envelopeGate, h.deviceGate, h.selector, h.audit, { warn: h.warn });
  const headersOf = (cell: HistoryCell) => (cell.admission === undefined ? {} : { "x-cashier-admission": cell.admission });

  describe("list route (no audit)", () => {
    it.each(HISTORY_MATRIX.map((c) => [c.name, c] as const))("%s", async (_name, cell) => {
      const h = harness();
      const request = requestWith(cell.bearer, undefined, headersOf(cell));
      const result = await outcomeOf(() => history(h).canActivate(ctxFor(request, listHandler)));
      assertOutcome(result, request, cell.expected);
      expect(h.calls).toEqual(cell.calls);
      expect(events(h)).toEqual(cell.reason === undefined ? [] : [`sale_history.cashier_refused.${cell.reason}`]);
      expect(h.audits).toEqual([]);
      assertRedacted(h);
    });
  });

  describe("reprint route (refusals audited)", () => {
    it.each(HISTORY_MATRIX.map((c) => [c.name, c] as const))("%s", async (_name, cell) => {
      const h = harness();
      const request = requestWith(cell.bearer, REPRINT_BODY, headersOf(cell), { saleRef: SALE_REF });
      const result = await outcomeOf(() => history(h).canActivate(ctxFor(request, reprintHandler)));
      assertOutcome(result, request, cell.expected);
      const audited = cell.reason !== undefined;
      expect(h.calls).toEqual(audited ? [...cell.calls, "audit"] : cell.calls);
      expect(events(h)).toEqual(audited ? [`sale_history.cashier_refused.${cell.reason}`] : []);
      if (audited) {
        expect(h.audits).toEqual([
          {
            scope: { deviceId: DEVICE_A, tenantId: TENANT, storeId: STORE_A },
            actorUserId: cell.auditActor,
            saleRef: SALE_REF,
            mode: "authorize",
            kind: "duplicate",
            reason: cell.reason,
            requestId: "0c122900-0000-4000-8000-0000000000ff",
          },
        ]);
      } else {
        expect(h.audits).toEqual([]);
      }
      assertRedacted(h);
    });

    it("a failed audit write keeps the same 403 and logs allowlisted fields only", async () => {
      const h = harness({ auditFails: true });
      const request = requestWith("device-a", REPRINT_BODY, { "x-cashier-admission": ADM_EXPIRED }, { saleRef: SALE_REF });
      const result = await outcomeOf(() => history(h).canActivate(ctxFor(request, reprintHandler)));
      assertOutcome(result, request, { status: 403 });
      expect(events(h)).toEqual(["sale_history.cashier_refused.admission_not_live", "sale_history.refusal_audit_failed"]);
      assertRedacted(h);
    });
  });

  it("a header that is not a uuid is the 400 after device auth, before the selector", async () => {
    const h = harness();
    const request = requestWith("device-a", undefined, { "x-cashier-admission": "nope" });
    const result = await outcomeOf(() => history(h).canActivate(ctxFor(request, listHandler)));
    assertOutcome(result, request, { status: 400 });
    expect(h.calls).toEqual(["device"]);
  });

  it("a header that is not a uuid from a revoked device is the 401, never the 400", async () => {
    const h = harness();
    const request = requestWith("device-revoked", undefined, { "x-cashier-admission": "nope" });
    const result = await outcomeOf(() => history(h).canActivate(ctxFor(request, listHandler)));
    assertOutcome(result, request, { status: 401 });
    expect(h.calls).toEqual(["device"]);
  });
});
