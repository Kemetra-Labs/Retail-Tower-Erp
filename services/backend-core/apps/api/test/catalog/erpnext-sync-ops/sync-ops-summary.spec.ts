/**
 * 025-US1 🎯 MVP — the consolidated sync-ops summary.
 *
 * Exercises `consoleGetSyncOpsSummary` end-to-end against Testcontainers
 * Postgres 16, mirroring the 017 posting-backlog harness (ConfigurableContextGuard
 * + overridden production guards + RLS-active PG_POOL bound to env.app). The
 * summary is a LIVE compute-on-read projection over 015 erpnext_posting_status +
 * 017 erpnext_reconciliation_run/_result (READ-NOT-MIRROR) — 025 stores nothing.
 *
 * Reuses the 017 `seedReconciliationFixture` (it seeds, across two tenants, the
 * same 015 posting rows + 017 runs/results 025 reads).
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/summary
 *
 * Sub-cases (T009/T010/T011):
 *   §1 the summary aggregates posting-health (015) + reconciliation-health (017),
 *      with 020 connector_health + 021 product_master = not_available (FR-004).
 *   §2 empty-tenant zeroed case (no rows → ok / zero counts; deferred still N/A).
 *   §3 tenant isolation — tenant B's state never bleeds into tenant A's summary.
 *   §4 §XII strict DTO — a smuggled tenant_id query key → 400.
 *   §5 auth: the route is guarded (DashboardAuthGuard + RolesGuard); a machine
 *      credential is rejected (unit-level guard wiring asserted separately).
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../src/database";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { MembershipRepository } from "../../../src/context/membership.repository";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { ErpnextSyncOpsController } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller";
import { ErpnextSyncOpsReadModelService } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.read-model.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  RECONCILIATION_FIXTURE_IDS,
  seedReconciliationFixture,
} from "../erpnext-reconciliation/__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
// A tenant with no seeded sync-ops state (the empty-tenant zeroed case).
const TENANT_EMPTY = "0c000000-0000-7000-8000-00000e0517c0";
const BASE = "/api/v1/catalog/erpnext-sync-ops/summary";

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      // RT-192: the reads are bound to the membership store scope; this is what
      // TenantContextGuard resolves for an 'all' membership.
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[sync-ops-summary.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextSyncOpsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextSyncOpsReadModelService,
      { provide: MembershipRepository, useFactory: (): MembershipRepository => new MembershipRepository(localEnv.app) },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

interface DomainSummary {
  domain: string;
  status: string;
  headlineCount: number | null;
  detail: string | null;
}
const byDomain = (body: { domains: DomainSummary[] }) =>
  Object.fromEntries(body.domains.map((d) => [d.domain, d]));

describe("025-US1 §1 — consolidated summary aggregates posting + reconciliation", () => {
  it("returns one DomainSummary per domain; posting + reconciliation populated", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(Object.keys(d).sort()).toEqual(
      ["connector_health", "posting", "product_master", "reconciliation"].sort(),
    );
    // Tenant A has a permanently_rejected posting (POSTING_DEADLETTER_A) → posting
    // domain reports a non-null headline count >= 1.
    expect(d["posting"]!.status).toBe("attention");
    expect(d["posting"]!.headlineCount).toBeGreaterThanOrEqual(1);
    // Tenant A has a reconciliation run (RUN_A) with an open result → reconciliation
    // reports attention with the open-mismatch count.
    expect(["ok", "attention"]).toContain(d["reconciliation"]!.status);
    expect(typeof d["reconciliation"]!.headlineCount).toBe("number");
  });

  it("reports 021 product_master as not_available (FR-004); connector_health with no instances too (RT-563)", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(d["connector_health"]!.status).toBe("not_available");
    expect(d["connector_health"]!.headlineCount).toBeNull();
    expect(d["product_master"]!.status).toBe("not_available");
    expect(d["product_master"]!.headlineCount).toBeNull();
  });
});

describe("025-US1 §2 — empty tenant is zeroed (not errored)", () => {
  it("a tenant with no sync-ops state returns ok/zero domains, deferred still N/A", async () => {
    if (skip()) return;
    contextGuard.tenantId = TENANT_EMPTY;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(d["posting"]!.status).toBe("ok");
    expect(d["posting"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.headlineCount).toBe(0);
    expect(d["connector_health"]!.status).toBe("not_available");
  });
});

describe("025-US1 §3 — tenant isolation (RLS actually in effect)", () => {
  it("tenant A sees its own dead-letter count; the EMPTY tenant control sees 0", async () => {
    if (skip()) return;
    // Tenant A has the seeded POSTING_DEADLETTER_A → posting count >= 1.
    const a = byDomain((await http().get(BASE).expect(200)).body);
    expect(a["posting"]!.headlineCount).toBeGreaterThanOrEqual(1);
    // The EMPTY tenant is the control: if RLS were disabled it would see A's rows
    // (count >= 1); proving it sees 0 proves the per-tenant GUC filter is active.
    contextGuard.tenantId = TENANT_EMPTY;
    const empty = byDomain((await http().get(BASE).expect(200)).body);
    expect(empty["posting"]!.headlineCount).toBe(0);
    expect(empty["reconciliation"]!.headlineCount).toBe(0);
  });
});

describe("025-US1 §5 — reconciliation status rollup (failed run → attention)", () => {
  it("a failed latest run yields attention even with zero open mismatches", async () => {
    if (skip()) return;
    // Seed (under TENANT_A, on a NEW dedicated store) a FAILED run with NO results
    // → query the summary FILTERED to that store, so posting + open-mismatch counts
    // are both 0 for the store, but the latest run is 'failed'. The rollup must be
    // 'attention' (a failed run still needs operator eyes), NOT 'ok'. Fails against
    // a count-only rollup. (Also exercises the store-filtered path.)
    const FAILED_RUN = "0a000000-0000-7000-8000-00000e0517cf";
    const FAIL_STORE = "0a000000-0000-7000-8000-00000e0517ce";
    await env!.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, 'FAIL1', 'Fail Store') ON CONFLICT DO NOTHING`,
      [FAIL_STORE, TENANT_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'failed', now(), now())
       ON CONFLICT DO NOTHING`,
      [FAILED_RUN, TENANT_A, FAIL_STORE],
    );
    const d = byDomain(
      (await http().get(BASE).query({ store_id: FAIL_STORE }).expect(200)).body,
    );
    expect(d["posting"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.status).toBe("attention");
  });
});

describe("025-US1 §4 — §XII strict DTO", () => {
  it("a smuggled tenant_id query key → 400 (strict)", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });

  it("a well-formed but out-of-scope store_id → non-disclosing 404 (FR-009/SC-002)", async () => {
    if (skip()) return;
    // A valid UUID that is NOT a store in tenant A's scope must be 404, not an
    // empty 200 (the contract's stated non-disclosing behaviour).
    await http()
      .get(BASE)
      .query({ store_id: "0d000000-0000-7000-8000-00000e0517dd" })
      .expect(404);
  });

  it("a non-uuid store_id → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ store_id: "not-a-uuid" }).expect(400);
  });
});

describe("RT-563 — connector_health derived from the 020 read model", () => {
  const T_STALE = "0c000000-0000-7000-8000-00000e0563a1";
  const T_NEVER = "0c000000-0000-7000-8000-00000e0563a2";
  const T_OK = "0c000000-0000-7000-8000-00000e0563a3";
  const T_DISABLED = "0c000000-0000-7000-8000-00000e0563a4";
  const REG = (n: number): string =>
    `0c000000-0000-7000-8000-00000e0563b${n}`;

  const seedTenant = async (
    tenant: string,
    slug: string,
    regs: ReadonlyArray<{
      id: string;
      lastSeenSql: string | null; // null = no health row
      disabled?: boolean;
    }>,
  ): Promise<void> => {
    const a = env!.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, $2, $2, 'USD') ON CONFLICT (id) DO NOTHING`,
      [tenant, slug],
    );
    for (const r of regs) {
      await a.query(
        `INSERT INTO connector_registration
           (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
         VALUES ($1, $2, $3, $4, 'pilot', $5) ON CONFLICT (id) DO NOTHING`,
        [r.id, tenant, `C ${r.id.slice(-2)}`, `erp-${r.id.slice(-4)}.rt563`, ACTOR_A],
      );
      if (r.disabled) {
        await a.query(
          `UPDATE connector_registration SET disabled_at = now(), disabled_by = $2
            WHERE id = $1`,
          [r.id, ACTOR_A],
        );
      }
      if (r.lastSeenSql !== null) {
        await a.query(
          `INSERT INTO connector_health
             (id, tenant_id, connector_registration_id, last_seen_at)
           VALUES (gen_random_uuid(), $1, $2, ${r.lastSeenSql})
           ON CONFLICT (connector_registration_id) DO NOTHING`,
          [tenant, r.id],
        );
      }
    }
  };

  const get = async (tenant: string): Promise<DomainSummary> => {
    contextGuard.tenantId = tenant;
    const res = await http().get(BASE).expect(200);
    return byDomain(res.body)["connector_health"]!;
  };

  it("no instances -> not_available (empty tenant)", async () => {
    if (skip()) return;
    const d = await get(TENANT_EMPTY);
    expect(d.status).toBe("not_available");
    expect(d.headlineCount).toBeNull();
  });

  it("all never_seen -> attention, not ok", async () => {
    if (skip()) return;
    await seedTenant(T_NEVER, "rt563never", [
      { id: REG(1), lastSeenSql: null },
      { id: REG(2), lastSeenSql: null },
    ]);
    const d = await get(T_NEVER);
    expect(d.status).toBe("attention");
    expect(d.headlineCount).toBe(2);
  });

  it("mixed healthy + stale -> attention with count 1", async () => {
    if (skip()) return;
    await seedTenant(T_STALE, "rt563stale", [
      { id: REG(3), lastSeenSql: "now()" },
      { id: REG(4), lastSeenSql: "now() - interval '1 hour'" },
    ]);
    const d = await get(T_STALE);
    expect(d.status).toBe("attention");
    expect(d.headlineCount).toBe(1);
  });

  it("all healthy -> ok", async () => {
    if (skip()) return;
    await seedTenant(T_OK, "rt563ok", [{ id: REG(5), lastSeenSql: "now()" }]);
    const d = await get(T_OK);
    expect(d.status).toBe("ok");
    expect(d.headlineCount).toBe(0);
  });

  it("disabled-only -> not_available; disabled never makes a tenant ok", async () => {
    if (skip()) return;
    await seedTenant(T_DISABLED, "rt563dis", [
      { id: REG(6), lastSeenSql: "now()", disabled: true },
    ]);
    const d = await get(T_DISABLED);
    expect(d.status).toBe("not_available");
  });

  it("tenant isolation: another tenant's instances do not leak", async () => {
    if (skip()) return;
    // Self-contained: seed a foreign tenant's healthy + stale connectors here.
    await seedTenant(T_STALE, "rt563stale", [
      { id: REG(3), lastSeenSql: "now()" },
      { id: REG(4), lastSeenSql: "now() - interval '1 hour'" },
    ]);
    expect((await get(T_STALE)).status).toBe("attention");
    expect((await get(TENANT_EMPTY)).status).toBe("not_available");
  });
});

describe("RT-1404 — reconciliation.latestRun (structured latest run)", () => {
  // Each case gets its own store and reads the summary filtered to it, so the
  // tenant-wide latest run (other tests insert runs at now()) never interferes.
  const STORE = (n: number): string => `0a000000-0000-7000-8000-00000e1404a${n}`;
  const RUN = (n: number): string => `0a000000-0000-7000-8000-00000e1404b${n}`;

  const seedStore = async (storeId: string): Promise<void> => {
    await env!.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`,
      [storeId, TENANT_A, `RT1404-${storeId.slice(-2)}`],
    );
  };
  const seedRun = async (
    runId: string,
    storeId: string,
    status: "running" | "completed" | "failed",
    startedAt: string,
  ): Promise<void> => {
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'stock', 'on_demand', $4, $5::timestamptz,
               CASE WHEN $4 = 'running' THEN NULL ELSE $5::timestamptz END)
       ON CONFLICT DO NOTHING`,
      [runId, TENANT_A, storeId, status, startedAt],
    );
  };
  const reconFor = async (storeId: string): Promise<Record<string, unknown>> => {
    const res = await http().get(BASE).query({ store_id: storeId }).expect(200);
    return (res.body.domains as Array<Record<string, unknown>>).find(
      (d) => d["domain"] === "reconciliation",
    )!;
  };

  it("no run in scope -> latestRun is null (present, not omitted)", async () => {
    if (skip()) return;
    await seedStore(STORE(1));
    const r = await reconFor(STORE(1));
    expect(r).toHaveProperty("latestRun");
    expect(r["latestRun"]).toBeNull();
    expect(r["detail"]).toBe("No reconciliation runs yet");
  });

  it.each([
    ["running", 2, "2026-11-20T08:00:00.123Z", "ok"],
    ["completed", 3, "2026-11-20T09:00:00.000Z", "ok"],
    ["failed", 4, "2026-11-20T10:30:00.500Z", "attention"],
  ] as const)("a %s latest run -> { status, at = started_at }", async (status, n, startedAt, tile) => {
    if (skip()) return;
    await seedStore(STORE(n));
    await seedRun(RUN(n), STORE(n), status, startedAt);
    const r = await reconFor(STORE(n));
    expect(r["latestRun"]).toEqual({ status, at: startedAt });
    expect(r["status"]).toBe(tile);
    expect(r["detail"]).toBe(`Latest run ${status}`);
  });

  it("picks the newest run by started_at within the filtered store", async () => {
    if (skip()) return;
    await seedStore(STORE(5));
    await seedRun(RUN(5), STORE(5), "failed", "2026-11-19T10:00:00.000Z");
    await seedRun(RUN(6), STORE(5), "completed", "2026-11-21T10:00:00.000Z");
    const r = await reconFor(STORE(5));
    expect(r["latestRun"]).toEqual({ status: "completed", at: "2026-11-21T10:00:00.000Z" });
  });

  it("latestRun appears only on the reconciliation tile; instances only on connector_health", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    for (const d of res.body.domains as Array<Record<string, unknown>>) {
      if (d["domain"] !== "reconciliation") expect(d).not.toHaveProperty("latestRun");
      if (d["domain"] !== "connector_health") expect(d).not.toHaveProperty("instances");
    }
  });
});

describe("RT-1404 — connector_health.instances over HTTP", () => {
  const T_MIX = "0c000000-0000-7000-8000-00000e1404c1";
  const T_DIS = "0c000000-0000-7000-8000-00000e1404c2";
  const REG = (n: number): string => `0c000000-0000-7000-8000-00000e1404d${n}`;

  const seed = async (
    tenant: string,
    regs: ReadonlyArray<{ id: string; lastSeenSql: string | null; disabled?: boolean }>,
  ): Promise<void> => {
    const a = env!.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, $2, $2, 'USD') ON CONFLICT (id) DO NOTHING`,
      [tenant, `rt1404-${tenant.slice(-2)}`],
    );
    for (const r of regs) {
      await a.query(
        `INSERT INTO connector_registration
           (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
         VALUES ($1, $2, $3, $4, 'pilot', $5) ON CONFLICT (id) DO NOTHING`,
        [r.id, tenant, `C ${r.id.slice(-2)}`, `erp-${r.id.slice(-4)}.rt1404`, ACTOR_A],
      );
      if (r.disabled) {
        await a.query(
          `UPDATE connector_registration SET disabled_at = now(), disabled_by = $2 WHERE id = $1`,
          [r.id, ACTOR_A],
        );
      }
      if (r.lastSeenSql !== null) {
        await a.query(
          `INSERT INTO connector_health (id, tenant_id, connector_registration_id, last_seen_at)
           VALUES (gen_random_uuid(), $1, $2, ${r.lastSeenSql})
           ON CONFLICT (connector_registration_id) DO NOTHING`,
          [tenant, r.id],
        );
      }
    }
  };
  const connFor = async (tenant: string): Promise<Record<string, unknown>> => {
    contextGuard.tenantId = tenant;
    const res = await http().get(BASE).expect(200);
    return (res.body.domains as Array<Record<string, unknown>>).find(
      (d) => d["domain"] === "connector_health",
    )!;
  };

  it("counts active instances: healthy, stale, never_seen; disabled excluded", async () => {
    if (skip()) return;
    await seed(T_MIX, [
      { id: REG(1), lastSeenSql: "now()" },
      { id: REG(2), lastSeenSql: "now() - interval '1 hour'" },
      { id: REG(3), lastSeenSql: null },
      { id: REG(4), lastSeenSql: "now()", disabled: true },
    ]);
    const c = await connFor(T_MIX);
    expect(c["status"]).toBe("attention");
    expect(c["headlineCount"]).toBe(2);
    expect(c["instances"]).toEqual({ total: 3, stale: 1, neverSeen: 1 });
  });

  it("not_available (no instances, or disabled only) omits instances", async () => {
    if (skip()) return;
    expect(await connFor(TENANT_EMPTY)).not.toHaveProperty("instances");
    await seed(T_DIS, [{ id: REG(5), lastSeenSql: "now()", disabled: true }]);
    const c = await connFor(T_DIS);
    expect(c["status"]).toBe("not_available");
    expect(c).not.toHaveProperty("instances");
  });
});
