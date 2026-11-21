/**
 * RT-1540 (W8 P-07 part 2) — the replay rig: the P-06 route harness (`msx-route.http.spec.ts`),
 * with recording ports, serving the `msx-eval` synthetic world.
 *
 * REAL: `ManagerSalesController`, `RolesGuard`, `NoPlatformAdminGuard`, `ManagerSalesScope`, the
 * request validation pipe, `AiGateway` with its preflight, `managerSalesFeature` (matcher, renderer,
 * output schema), `ManagerSalesEvidenceBuilder`, the response mapping and `GlobalExceptionFilter`;
 * the sales reads' own pure assemblers run over the world's fact rows.
 *
 * SYNTHETIC: the session and tenant-context guards (they hand the case's caller to the route), the
 * membership role lookup, the store-liveness query, the two sales reads' fact rows, the
 * entitlement and budget ports (recording fakes) and the audit queue. No provider is registered:
 * the gateway has no route and no provider to call, and a recording metric would show one.
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";

import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer, type AuditJobPayload } from "../../../../src/audit";
import { RolesGuard, SessionOnlyAdminGuard } from "../../../../src/auth";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../../../src/common/logging.interceptor";
import { MembershipRepository, TenantContextGuard, type TenantContextRequest } from "../../../../src/context";
import { PG_POOL } from "../../../../src/database";
import { AI_GATEWAY_RUNTIME } from "../../../../src/ai/ai.tokens";
import type {
  AiBudgetDecision,
  AiBudgetInput,
  AiEntitlementDecision,
  AiPolicyInput,
  AiReserveInput,
  AiUsageSettlement,
} from "../../../../src/ai/gateway/ai-gateway.types";
import { AiGateway } from "../../../../src/ai/gateway/ai-gateway.service";
import { ManagerSalesController } from "../../../../src/ai/manager-sales/manager-sales.controller";
import { ManagerSalesEvidenceBuilder } from "../../../../src/ai/manager-sales/msx.evidence";
import { managerSalesFeature } from "../../../../src/ai/manager-sales/msx.feature";
import { ManagerSalesScope, NoPlatformAdminGuard } from "../../../../src/ai/manager-sales/msx.scope";
import { fakeReads, managerCtx, ownerCtx, USER_ID, type FakeReads } from "../../manager-sales/__support__/msx-fixtures";
import type { ResolvedContext } from "../../../../src/context/types";
import { SAME_ORIGIN } from "../../../_helpers/same-origin";
import type { MsxCase, MsxCaller } from "./msx.types";
import { AS_OF, BASELINE_WEEK, STORE_A1, STORE_A2, STORE_A3 } from "./msx.world";
import { REPLAY_OTHER, REPLAY_SALES } from "./msx.replay.world";
import supertest from "supertest";

const REPLAY_PATH = "/api/v1/ai/manager-sales/explain";

/** The synthetic reservation ids are sequential; the idempotency key is the unit of uniqueness. */
const RESERVATION_PREFIX = "0191e540-0000-7000-8000-0000000000c";

export interface Recorded {
  /** The ordered port and read events of the run, e.g. `entitlement.check`, `read.summary`, `settle.ok`. */
  readonly events: string[];
  readonly checks: AiPolicyInput[];
  readonly budgetChecks: AiBudgetInput[];
  readonly reserves: AiReserveInput[];
  readonly settlements: AiUsageSettlement[];
  readonly audits: AuditJobPayload[];
  readonly logs: unknown[];
  /** Provider calls the gateway's metrics reported. Tier 0 has no provider, so this stays 0. */
  providerCalls: number;
  /** Distinct reservations granted: a same-key replay is never granted a second one. */
  readonly granted: Set<string>;
}

interface ReplayRig {
  readonly app: INestApplication;
  readonly reads: FakeReads;
  readonly recorded: Recorded;
  post(body: Record<string, unknown>, key: string | null): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  close(): Promise<void>;
}

function contextOf(caller: MsxCaller): ResolvedContext {
  if (caller.role === "platform_admin") return ownerCtx({ isPlatformAdmin: true });
  return caller.storeAccess === "all" ? ownerCtx() : managerCtx(caller.storeIds);
}

/** The membership role the caller has inside the tenant (what `MembershipRepository` answers). */
function membershipRoleOf(caller: MsxCaller): string {
  return caller.role === "store_manager" ? "store_manager" : "owner";
}

const liveStores = [STORE_A1, STORE_A2, STORE_A3];

export async function buildRig(testCase: MsxCase): Promise<ReplayRig> {
  const preconditions = new Set(testCase.preconditions);
  const hostile = testCase.untrusted?.where === "store_name" ? { [STORE_A2]: testCase.untrusted.text } : undefined;
  // The reads serve the caller's own scope, as the real reads' store filter does.
  const scope = testCase.caller.storeAccess === "all" ? undefined : testCase.caller.storeIds;
  const reads = fakeReads({
    ...(scope === undefined ? {} : { scope }),
    // Each summary read has its own instant: the baseline summary is a later read than the current one.
    summaryAsOf: (from) => (from === BASELINE_WEEK.from ? AS_OF.ssb : AS_OF.ss),
    sales: preconditions.has("store_a2_no_sales") ? REPLAY_SALES.filter((sale) => sale.store !== STORE_A2) : REPLAY_SALES,
    other: REPLAY_OTHER,
    ...(hostile === undefined ? {} : { names: hostile }),
    ...(preconditions.has("summary_read_throws") ? { fail: "summary" as const } : {}),
  });
  const recorded: Recorded = { events: [], checks: [], budgetChecks: [], reserves: [], settlements: [], audits: [], logs: [], providerCalls: 0, granted: new Set() };
  const ledger = new Map<string, string>();
  const callerCtx = contextOf(testCase.caller);
  const callerRole = membershipRoleOf(testCase.caller);

  const entitlementDecision: AiEntitlementDecision = preconditions.has("tenant_owner_opted_out")
    ? { allowed: false, reason: "feature_disabled_tenant" }
    : { allowed: true };
  const budgetDecision: AiBudgetDecision = { allowed: true };

  // The sales reads record themselves; wrap them so the event log is one ordered list, and a read
  // that throws leaves a `.failed` event (the observed evidence failure).
  async function logged<T>(name: string, read: () => Promise<T>): Promise<T> {
    recorded.events.push(name);
    try {
      return await read();
    } catch (err) {
      recorded.events.push(`${name}.failed`);
      throw err;
    }
  }
  const loggedReads = {
    summary: { summary: (input: Parameters<FakeReads["summary"]["summary"]>[0]) => logged("read.summary", () => reads.summary.summary(input)) },
    byStore: { byStore: (input: Parameters<FakeReads["byStore"]["byStore"]>[0]) => logged("read.byStore", () => reads.byStore.byStore(input)) },
  };

  const runtime = { isEnabled: () => !preconditions.has("kill_switch_off"), isProduction: () => false };
  const gateway = new AiGateway({
    features: [managerSalesFeature],
    entitlement: {
      async check(input) {
        recorded.events.push("entitlement.check");
        recorded.checks.push(input);
        return entitlementDecision;
      },
      async reserve(input) {
        recorded.events.push("reserve");
        recorded.reserves.push(input);
        const key = [input.tenantId, input.featureId, input.idempotencyKey].join("|");
        const held = ledger.get(key);
        if (held !== undefined) return { allowed: true, reservationId: held, entitlementVersion: 1, runnable: false };
        const reservationId = `${RESERVATION_PREFIX}${String(ledger.size + 1)}`;
        ledger.set(key, reservationId);
        recorded.granted.add(reservationId);
        return { allowed: true, reservationId, entitlementVersion: 1, runnable: true };
      },
      async settle(settlement) {
        recorded.events.push(`settle.${settlement.outcome}`);
        recorded.settlements.push(settlement);
      },
      reservationTtlMs: 900_000,
    },
    budget: {
      async check(input) {
        recorded.events.push("budget.check");
        recorded.budgetChecks.push(input);
        return budgetDecision;
      },
    },
    evidence: new ManagerSalesEvidenceBuilder(loggedReads.summary as never, loggedReads.byStore as never),
    routes: [],
    providers: [],
    runtime,
    metrics: {
      recordRun: () => undefined,
      recordProviderCall: () => {
        recorded.providerCalls += 1;
      },
    },
    logger: { info: (obj, msg) => recorded.logs.push({ obj, msg }), warn: (obj, msg) => recorded.logs.push({ obj, msg }) },
  });

  // A pool that answers only the store-liveness lookup of the scope service.
  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          if (!sql.includes("FROM stores")) return { rows: [], rowCount: 0 };
          const requested = params?.[2] as string[] | null;
          const limit = params?.[3] as number;
          const ids = requested === null ? liveStores : liveStores.filter((id) => requested.includes(id));
          return { rows: ids.slice(0, limit).map((id) => ({ id })), rowCount: Math.min(ids.length, limit) };
        },
        release() {},
      };
    },
  };

  const enqueuer: AuditJobEnqueuer = {
    async enqueue(payload) {
      recorded.audits.push(payload);
    },
  };

  // The synthetic session: a human cookie session whose resolved context is the case's caller.
  const session: CanActivate = { canActivate: () => true };
  const tenantContext: CanActivate = {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest<TenantContextRequest>();
      req.context = callerCtx;
      (req as unknown as { principal: unknown }).principal = { kind: "session", userId: USER_ID };
      return true;
    },
  };

  const memberships = { findRoleCodeForUserInTenant: async () => callerRole, isPlatformAdmin: async () => testCase.caller.role === "platform_admin" };
  const moduleRef = await Test.createTestingModule({
    controllers: [ManagerSalesController],
    providers: [
      { provide: AiGateway, useValue: gateway },
      ManagerSalesScope,
      NoPlatformAdminGuard,
      { provide: PG_POOL, useValue: pool },
      { provide: AI_GATEWAY_RUNTIME, useValue: runtime },
      { provide: MembershipRepository, useValue: memberships },
      { provide: AUDIT_JOB_ENQUEUER, useValue: enqueuer },
      { provide: ROOT_LOGGER, useValue: { error: (obj: unknown) => recorded.logs.push(obj), info: () => undefined, warn: () => undefined } },
    ],
  })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue(session)
    // The real role gate on its repository-only path (no system-privilege pool): `@Roles` is read from the route.
    .overrideGuard(RolesGuard)
    .useValue(new RolesGuard(new Reflector(), memberships as unknown as MembershipRepository))
    .overrideGuard(TenantContextGuard)
    .useValue(tenantContext)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  return {
    app,
    reads,
    recorded,
    async post(body, key) {
      let req = supertest(app.getHttpServer()).post(REPLAY_PATH).set(SAME_ORIGIN);
      if (key !== null) req = req.set("Idempotency-Key", key);
      const res = await req.send(body);
      return { status: res.status, body: res.body as unknown, headers: res.headers as Record<string, string> };
    },
    close: async () => {
      await app.close();
    },
  };
}

