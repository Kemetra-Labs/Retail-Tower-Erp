/**
 * RT-1539 — the Manager Sales route over HTTP, DB-less: the real controller, scope service, feature,
 * evidence builder and AiGateway; fake session guards, entitlement/budget ports and sales reads. What it
 * proves (the contract's denial order and tier-0 economics):
 *
 *   - 401 for a token principal, 404 for a platform admin (for ANY input), a role outside the list,
 *     an unknown store, an out-of-scope store and an empty list without tenant-wide authority: the
 *     whole request is refused, never narrowed, and the Gateway and the reads are never reached;
 *   - kill switch off and every entitlement/quota denial are a 200 `unavailable` with no read;
 *   - a refusal (finance, forecast, write, unsupported) is a 200 `refusal`: no budget call, no
 *     reservation, no read, no charge;
 *   - an answer reserves ONE unit under the Idempotency-Key, commits it at zero provider cost with no
 *     provider, and emits ONE audit event with no question text and no figure;
 *   - an evidence failure is `unavailable / evidence_unavailable` with the reservation released and no
 *     audit event.
 *
 * The idempotency replay (409 / 425) is the global interceptor's, covered by its own specs; here the
 * route is proved to ask for it (`@Idempotent("required")`).
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer, type AuditJobPayload } from "../../../src/audit";
import { RolesGuard, SessionOnlyAdminGuard } from "../../../src/auth";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../../src/common/logging.interceptor";
import { MembershipRepository, TenantContextGuard, type ResolvedContext, type TenantContextRequest } from "../../../src/context";
import { PG_POOL } from "../../../src/database";
import { IDEMPOTENT_POLICY_KEY } from "../../../src/idempotency/idempotent.decorator";
import { AiGateway } from "../../../src/ai/gateway/ai-gateway.service";
import { AI_GATEWAY_RUNTIME } from "../../../src/ai/ai.tokens";
import type { AiDeterministicFeatureDefinition } from "../../../src/ai/gateway/ai-feature";
import type {
  AiBudgetDecision,
  AiEntitlementDecision,
  AiReservation,
  AiReserveInput,
  AiUsageSettlement,
  AiBudgetInput,
} from "../../../src/ai/gateway/ai-gateway.types";
import { ManagerSalesController } from "../../../src/ai/manager-sales/manager-sales.controller";
import { MSX_FEATURE_ID } from "../../../src/ai/manager-sales/msx.constants";
import { ManagerSalesEvidenceBuilder } from "../../../src/ai/manager-sales/msx.evidence";
import { managerSalesFeature } from "../../../src/ai/manager-sales/msx.feature";
import { ManagerSalesScope, NoPlatformAdminGuard } from "../../../src/ai/manager-sales/msx.scope";
import { SAME_ORIGIN } from "../../_helpers/same-origin";
import { fakeReads, managerCtx, ownerCtx, STORE_A1, STORE_A2, STORE_A3, TENANT_A, USER_ID, type FakeReads } from "./__support__/msx-fixtures";

const PATH = "/api/v1/ai/manager-sales/explain";
const KEY = "rt1539-route-key-0001";
const RESERVATION = "0191e540-0000-7000-8000-0000000000c1";
const WEEK = { from: "2026-11-08", to: "2026-11-14" };
const NOT_FOUND = { error: { code: "not_found", message: "Not Found" } };

type Who =
  | "owner"
  | "manager"
  | "manager_a1"
  | "platform"
  | "token"
  | "staff"
  // A session whose ACTIVE store is set (`sessions.active_store_id`): the Console sets it.
  | "owner_active"
  | "admin_active"
  | "manager_active"
  | "owner_specific";

/** The membership role of each caller (what `MembershipRepository` would answer inside the tenant). */
const ROLE_OF: Readonly<Record<Who, string>> = {
  owner: "owner",
  manager: "store_manager",
  manager_a1: "store_manager",
  platform: "owner",
  token: "owner",
  staff: "store_staff",
  owner_active: "owner",
  admin_active: "tenant_admin",
  manager_active: "store_manager",
  owner_specific: "owner",
};

let currentRole = "owner";

function contextOf(who: Who): ResolvedContext {
  switch (who) {
    case "manager":
      return managerCtx([STORE_A1, STORE_A2]);
    case "manager_a1":
      return managerCtx([STORE_A1]);
    case "platform":
      return ownerCtx({ isPlatformAdmin: true });
    case "owner_active":
    case "admin_active":
      return ownerCtx({ storeId: STORE_A1 });
    case "manager_active":
      return managerCtx([STORE_A1, STORE_A2], STORE_A1);
    case "owner_specific":
      return managerCtx([STORE_A1]);
    default:
      return ownerCtx();
  }
}

/** The fakes of the real guard chain: the session, the context and the role gate. */
const sessionGuard: CanActivate = {
  canActivate(context: ExecutionContext) {
    if (context.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers["x-who"] === "token") throw new UnauthorizedException();
    return true;
  },
};
const contextGuard: CanActivate = {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<TenantContextRequest & { headers: Record<string, string> }>();
    const who = (req.headers["x-who"] ?? "owner") as Who;
    req.context = contextOf(who);
    currentRole = ROLE_OF[who];
    (req as unknown as { principal: unknown }).principal = { userId: USER_ID };
    return true;
  },
};
const rolesGuard: CanActivate = {
  canActivate(context: ExecutionContext) {
    if (context.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers["x-who"] === "staff") throw new NotFoundException();
    return true;
  },
};

interface World {
  readonly entitlement?: AiEntitlementDecision;
  readonly reservation?: AiReservation;
  readonly budget?: AiBudgetDecision;
  readonly enabled?: boolean;
  readonly reads?: Parameters<typeof fakeReads>[0];
  /** Store ids the tenant has as live stores. */
  readonly live?: readonly string[];
  /** How many live stores a tenant-wide scope holds (for `scope_too_large`). */
  readonly scopeCount?: number;
  readonly auditFails?: boolean;
  /** An audit queue that never answers: the response must not wait for it. */
  readonly auditHangs?: boolean;
  /** Replaces the registered feature (to force a gateway fault). */
  readonly feature?: AiDeterministicFeatureDefinition;
}

interface Rig {
  readonly app: INestApplication;
  readonly reads: FakeReads;
  readonly calls: { check: number; budget: number; reserve: number };
  readonly reserves: AiReserveInput[];
  readonly budgetInputs: AiBudgetInput[];
  readonly settlements: AiUsageSettlement[];
  readonly audits: AuditJobPayload[];
  readonly logs: unknown[];
  readonly poolQueries: string[];
}

async function rig(world: World = {}): Promise<Rig> {
  const reads = fakeReads(world.reads);
  const calls = { check: 0, budget: 0, reserve: 0 };
  const reserves: AiReserveInput[] = [];
  const budgetInputs: AiBudgetInput[] = [];
  const settlements: AiUsageSettlement[] = [];
  const audits: AuditJobPayload[] = [];
  const logs: unknown[] = [];
  const poolQueries: string[] = [];
  const live = world.live ?? [STORE_A1, STORE_A2, STORE_A3];

  const runtime = { isEnabled: () => world.enabled ?? true, isProduction: () => false };
  const gateway = new AiGateway({
    features: [world.feature ?? managerSalesFeature],
    entitlement: {
      async check() {
        calls.check += 1;
        return world.entitlement ?? { allowed: true };
      },
      async reserve(input) {
        calls.reserve += 1;
        reserves.push(input);
        return world.reservation ?? { allowed: true, reservationId: RESERVATION, entitlementVersion: 1, runnable: true };
      },
      async settle(settlement) {
        settlements.push(settlement);
      },
      reservationTtlMs: 900_000,
    },
    budget: {
      async check(input) {
        calls.budget += 1;
        budgetInputs.push(input);
        return world.budget ?? { allowed: true };
      },
    },
    evidence: new ManagerSalesEvidenceBuilder(reads.summary as never, reads.byStore as never),
    routes: [],
    providers: [],
    runtime,
    metrics: { recordRun: () => undefined, recordProviderCall: () => undefined },
    logger: { info: (obj, msg) => logs.push({ obj, msg }), warn: (obj, msg) => logs.push({ obj, msg }) },
  });

  // A pool that answers only the store lookups of the scope service.
  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          poolQueries.push(sql);
          if (!sql.includes("FROM stores")) return { rows: [], rowCount: 0 };
          const requested = params?.[2] as string[] | null;
          const limit = params?.[3] as number;
          const ids = requested === null ? Array.from({ length: world.scopeCount ?? live.length }, (_v, i) => `store-${i}`) : live.filter((id) => requested.includes(id));
          return { rows: ids.slice(0, limit).map((id) => ({ id })), rowCount: Math.min(ids.length, limit) };
        },
        release() {},
      };
    },
  };

  const enqueuer: AuditJobEnqueuer = {
    async enqueue(payload) {
      if (world.auditFails === true) throw new Error("queue down");
      audits.push(payload);
      if (world.auditHangs === true) await new Promise<void>(() => undefined);
    },
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ManagerSalesController],
    providers: [
      { provide: AiGateway, useValue: gateway },
      ManagerSalesScope,
      NoPlatformAdminGuard,
      { provide: PG_POOL, useValue: pool },
      { provide: AI_GATEWAY_RUNTIME, useValue: runtime },
      { provide: MembershipRepository, useValue: { findRoleCodeForUserInTenant: async () => currentRole } },
      { provide: AUDIT_JOB_ENQUEUER, useValue: enqueuer },
      { provide: ROOT_LOGGER, useValue: { error: (obj: unknown) => logs.push(obj), info: () => undefined, warn: () => undefined } },
    ],
  })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue(sessionGuard)
    .overrideGuard(TenantContextGuard)
    .useValue(contextGuard)
    .overrideGuard(RolesGuard)
    .useValue(rolesGuard)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { app, reads, calls, reserves, budgetInputs, settlements, audits, logs, poolQueries };
}

let current: Rig | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

async function post(world: World, body: Record<string, unknown>, who: Who = "owner", key: string | null = KEY) {
  current = await rig(world);
  let req = request(current.app.getHttpServer()).post(PATH).set(SAME_ORIGIN).set("x-who", who);
  if (key !== null) req = req.set("Idempotency-Key", key);
  const res = await req.send(body);
  return { res, rig: current };
}

const ask = (extra: Record<string, unknown> = {}) => ({ templateId: "T-01", storeIds: [], ...WEEK, locale: "en", ...extra });

describe("POST /api/v1/ai/manager-sales/explain", () => {
  describe("the route's markers", () => {
    const handler = ManagerSalesController.prototype.explain;
    it("asks for the idempotency key, answers 200 (not 201) and is not cacheable", () => {
      expect(Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler)).toBe("required");
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    });
  });

  describe("an answer", () => {
    it("is a 200 answer with no-store, one unit reserved under the key at zero cost, and no provider", async () => {
      const { res, rig: r } = await post({}, ask());
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ kind: "answer", templateId: "T-01", ledger: { routeKey: "deterministic_no_model", routing_tier: 0 } });
      expect(Number.isInteger(res.body.ledger.latency_ms)).toBe(true);
      expect(r.reserves).toHaveLength(1);
      expect(r.reserves[0]).toMatchObject({ featureId: MSX_FEATURE_ID, units: 1, idempotencyKey: KEY, tenantId: TENANT_A });
      expect(r.budgetInputs[0]).toMatchObject({ providerCost: "zero", routeKey: "deterministic_no_model" });
      expect(r.settlements).toHaveLength(1);
      expect(r.settlements[0]).toMatchObject({ outcome: "ok", reservationId: RESERVATION });
      expect(r.settlements[0]!.telemetry).toMatchObject({ routeKey: "deterministic_no_model", promptTemplateId: "manager_sales.answer", outputSchemaId: "manager_sales.answer/1" });
      expect(r.settlements[0]!.telemetry).not.toHaveProperty("providerKey");
      expect(r.settlements[0]!.telemetry).not.toHaveProperty("inputTokens");
    });

    it("emits exactly one audit event: the template, scope mode, store count and range; never a figure or the question", async () => {
      const { res, rig: r } = await post({}, ask({ templateId: undefined, question: "How much did we sell this SECRET-QUESTION" }));
      expect(res.body.kind).toBe("answer");
      expect(r.audits).toHaveLength(1);
      expect(r.audits[0]).toMatchObject({
        actor_user_id: USER_ID,
        tenant_id: TENANT_A,
        action: "ai.manager_sales.explain",
        metadata: { template_id: "T-01", scope_mode: "all_in_scope", store_count: 3, from: WEEK.from, to: WEEK.to },
      });
      const dump = JSON.stringify([r.audits, r.logs, r.settlements]);
      expect(dump).not.toContain("SECRET-QUESTION");
      expect(dump).not.toContain("22065.5000");
    });

    it("the audit enqueue is fire-and-forget: a queue that never answers does not hold the response", async () => {
      const { res, rig: r } = await post({ auditHangs: true }, ask());
      expect(res.status).toBe(200);
      expect(r.audits).toHaveLength(1);
    });

    it("an audit failure never changes the answer", async () => {
      const { res, rig: r } = await post({ auditFails: true }, ask());
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("answer");
      expect(JSON.stringify(r.logs)).toContain("manager_sales.audit");
    });

    it("a manager's explicit own stores are answered for those stores only", async () => {
      const { res, rig: r } = await post({}, ask({ storeIds: [STORE_A1] }), "manager_a1");
      expect(res.body.scope).toEqual({ mode: "store", storeRefs: [STORE_A1] });
      expect(r.reads.calls.summary[0]).toMatchObject({ storeId: STORE_A1 });
    });
  });

  describe("a refusal reads nothing and charges nothing", () => {
    it.each([
      ["finance_source_absent", "What's my profit margin this month?"],
      ["forecast_not_supported", "forecast next month"],
      ["write_action_not_supported", "Refund the last sale and mark it posted"],
      ["unsupported_question", "tell me a joke"],
    ])("%s", async (code, question) => {
      const { res, rig: r } = await post({}, ask({ templateId: undefined, question }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: "refusal", family: "answer", code });
      expect(r.calls).toEqual({ check: 1, budget: 0, reserve: 0 });
      expect(r.settlements).toHaveLength(0);
      expect(r.reads.calls.summary).toHaveLength(0);
      expect(r.reads.calls.byStore).toHaveLength(0);
      expect(r.audits).toHaveLength(0);
    });

    it("a refusal wins over an exhausted quota (the match runs before the reservation)", async () => {
      const { res } = await post({ reservation: { allowed: false, reason: "quota_exhausted" } }, ask({ templateId: undefined, question: "what is the profit" }));
      expect(res.body).toEqual({ kind: "refusal", family: "answer", code: "finance_source_absent" });
    });
  });

  describe("a gateway denial is a 200 unavailable with no evidence read", () => {
    it("kill switch off: feature_disabled_system, nothing consulted", async () => {
      const { res, rig: r } = await post({ enabled: false }, ask());
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: "feature_disabled_system" });
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
      expect(r.reads.calls.summary).toHaveLength(0);
    });

    it.each(["not_entitled", "tenant_inactive", "trial_expired", "grace_read_only", "feature_disabled_tenant", "entitlement_unavailable"] as const)(
      "entitlement %s",
      async (reason) => {
        const { res, rig: r } = await post({ entitlement: { allowed: false, reason } }, ask());
        expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: reason });
        expect(r.calls).toEqual({ check: 1, budget: 0, reserve: 0 });
        expect(r.audits).toHaveLength(0);
      },
    );

    it.each(["spend_cap_reached", "free_credit_exhausted"] as const)("budget %s: no reservation", async (reason) => {
      const { res, rig: r } = await post({ budget: { allowed: false, reason } }, ask());
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: reason });
      expect(r.calls.reserve).toBe(0);
    });

    it("quota_exhausted at the reservation: no evidence read", async () => {
      const { res, rig: r } = await post({ reservation: { allowed: false, reason: "quota_exhausted" } }, ask());
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: "quota_exhausted" });
      expect(r.reads.calls.summary).toHaveLength(0);
      expect(r.settlements).toHaveLength(0);
    });

    it("an evidence failure is evidence_unavailable, the reservation released, no partial figure, no audit", async () => {
      const { res, rig: r } = await post({ reads: { fail: "summary" } }, ask());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: "evidence_unavailable" });
      expect(r.reserves).toHaveLength(1);
      expect(r.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
      expect(r.audits).toHaveLength(0);
    });
  });

  describe("the non-disclosing 404, decided before the Gateway", () => {
    const untouched = (r: Rig) => {
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
      expect(r.reads.calls.summary).toHaveLength(0);
      expect(r.reads.calls.byStore).toHaveLength(0);
      expect(r.audits).toHaveLength(0);
    };

    it("a platform admin, for ANY input (even one that is not valid)", async () => {
      for (const body of [ask(), {}, { tenant_id: "x" }]) {
        const { res, rig: r } = await post({}, body, "platform");
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject(NOT_FOUND);
        untouched(r);
        await r.app.close();
      }
      current = null;
    });

    it("a role outside the list", async () => {
      const { res, rig: r } = await post({}, ask(), "staff");
      expect(res.status).toBe(404);
      untouched(r);
    });

    it("a store outside the caller's scope: the whole request, never narrowed", async () => {
      const { res, rig: r } = await post({}, ask({ storeIds: [STORE_A1, STORE_A3] }), "manager");
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject(NOT_FOUND);
      untouched(r);
      expect(r.poolQueries.some((q) => q.includes("FROM stores"))).toBe(false);
    });

    it("an unknown (or deleted) store of the tenant is the same 404 and body", async () => {
      const unknown = "0191e540-0000-7000-8000-0000000000ee";
      const { res, rig: r } = await post({}, ask({ storeIds: [STORE_A1, unknown] }));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject(NOT_FOUND);
      untouched(r);
    });

    it("an empty list without tenant-wide authority", async () => {
      const { res, rig: r } = await post({}, ask({ storeIds: [] }), "manager");
      expect(res.status).toBe(404);
      untouched(r);
    });

    it("the gateway's own not_authorized (an entitlement port that refuses the stores) is the same 404", async () => {
      const { res, rig: r } = await post({ entitlement: { allowed: false, reason: "not_authorized" } }, ask({ storeIds: [STORE_A1] }));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject(NOT_FOUND);
      expect(r.calls.reserve).toBe(0);
    });
  });

  describe("the store scope is role-aware, as on the sales reads", () => {
    const A = STORE_A1;
    const B = STORE_A2;

    it.each(["owner_active", "admin_active"] as const)("%s (an ACTIVE store set): an empty list is tenant-wide and answers", async (who) => {
      const { res, rig: r } = await post({}, ask({ storeIds: [] }), who);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: "answer", scope: { mode: "all_in_scope" } });
      // The Gateway sees the membership authority, not the active-store narrowing.
      expect(r.reserves[0]!.ctx.storeId).toBeNull();
      expect(r.reserves[0]!.ctx.storeAccess).toEqual({ kind: "all" });
    });

    it.each([[A], [B]])("owner_active may ask the in-tenant store %s, whatever the active store", async (store) => {
      const { res, rig: r } = await post({}, ask({ storeIds: [store] }), "owner_active");
      expect(res.status).toBe(200);
      expect(res.body.scope).toEqual({ mode: "store", storeRefs: [store] });
      expect(r.reserves[0]!.ctx.storeId).toBeNull();
    });

    it("an unknown store is still the 404 for an owner with an active store", async () => {
      const { res } = await post({}, ask({ storeIds: ["0191e540-0000-7000-8000-0000000000ee"] }), "owner_active");
      expect(res.status).toBe(404);
    });

    it("a store_manager with an active store keeps the narrowed scope: its active store only", async () => {
      const allowed = await post({}, ask({ storeIds: [A] }), "manager_active");
      expect(allowed.res.status).toBe(200);
      expect(allowed.rig.reserves[0]!.ctx.storeId).toBe(A);
      await allowed.rig.app.close();
      for (const storeIds of [[B], [], [A, B]]) {
        const denied = await post({}, ask({ storeIds }), "manager_active");
        expect(denied.res.status).toBe(404);
        expect(denied.rig.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
        await denied.rig.app.close();
      }
      current = null;
    });

    it("an owner whose membership is SPECIFIC is never widened past it", async () => {
      const { res, rig: r } = await post({}, ask({ storeIds: [B] }), "owner_specific");
      expect(res.status).toBe(404);
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
      const empty = await post({}, ask({ storeIds: [] }), "owner_specific");
      expect(empty.res.status).toBe(404);
    });
  });

  describe("the kill switch is checked before the scope 404", () => {
    it("off, with an out-of-scope store: a 200 unavailable, never a 404, and the scope is not touched", async () => {
      const { res, rig: r } = await post({ enabled: false, live: [] }, ask({ storeIds: [STORE_A1, STORE_A3] }), "manager");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: "feature_disabled_system" });
      expect(r.poolQueries).toHaveLength(0);
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
    });

    it("off, a platform admin and a refused role stay the edge 404", async () => {
      for (const who of ["platform", "staff"] as const) {
        const { res, rig: r } = await post({ enabled: false }, ask(), who);
        expect(res.status).toBe(404);
        await r.app.close();
      }
      current = null;
    });

    it("on, the scope 404 applies as before", async () => {
      const { res } = await post({}, ask({ storeIds: [STORE_A1, STORE_A3] }), "manager");
      expect(res.status).toBe(404);
    });
  });

  describe("a gateway fault is a 500 that charges nothing", () => {
    it("internal_error: 500, the reservation is released (never committed), no audit event", async () => {
      const faulty: AiDeterministicFeatureDefinition = {
        ...managerSalesFeature,
        execute: () => {
          throw new Error("renderer bug");
        },
      };
      const { res, rig: r } = await post({ feature: faulty }, ask());
      expect(res.status).toBe(500);
      expect(r.reserves).toHaveLength(1);
      expect(r.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
      expect(r.settlements.some((s) => s.outcome === "ok")).toBe(false);
      expect(r.audits).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toContain("renderer bug");
    });
  });

  describe("401 and validation", () => {
    it("a token principal is 401 before anything", async () => {
      const { res, rig: r } = await post({}, ask(), "token");
      expect(res.status).toBe(401);
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
    });

    it.each([
      ["a smuggled tenant_id", { ...ask(), tenant_id: "x" }],
      ["an unknown key", { ...ask(), extra: 1 }],
      ["neither templateId nor question", { storeIds: [], ...WEEK, locale: "en" }],
      ["a template outside the catalogue (T-11)", ask({ templateId: "T-11" })],
      ["a currency-less by-store chip", ask({ templateId: "T-04" })],
      ["a 45-day range", ask({ from: "2026-10-05", to: "2026-11-18" })],
      ["an inverted range", ask({ from: WEEK.to, to: WEEK.from })],
      ["a repeated store id", ask({ storeIds: [STORE_A1, STORE_A1] })],
      ["a non-uuid store id", ask({ storeIds: ["nope"] })],
      ["a locale outside ar|en", ask({ locale: "fr" })],
      ["a question over 500 characters", ask({ templateId: undefined, question: "x".repeat(501) })],
      ["an empty question", ask({ templateId: undefined, question: "" })],
      ["a lower-case currency", ask({ currency: "egp" })],
    ])("400 validation_error: %s", async (_name, body) => {
      const { res, rig: r } = await post({}, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
      expect(r.reads.calls.summary).toHaveLength(0);
    });

    it("400 scope_too_large for a tenant-wide scope over 500 stores: nothing read or reserved", async () => {
      const { res, rig: r } = await post({ scopeCount: 501 }, ask());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("scope_too_large");
      expect(r.calls).toEqual({ check: 0, budget: 0, reserve: 0 });
    });

    it("a missing Idempotency-Key reaches the Gateway as no key: it cannot reserve and fails closed", async () => {
      const { res, rig: r } = await post({}, ask(), "owner", null);
      // The global IdempotencyInterceptor answers 400 first in the real app; here only the route is mounted.
      expect(res.body).toEqual({ kind: "unavailable", family: "gateway", code: "entitlement_unavailable" });
      expect(r.reserves).toHaveLength(0);
    });
  });
});
