/**
 * RT-1574 — the tenant transit warehouse mapping (get / set / retire), against a Testcontainers Postgres 16.
 *
 * Migration 0125 (RT-1513) made `purpose = 'transit'` a valid `erpnext_warehouse_map` row: no store, at most one
 * active per tenant. Shipment transfers refuse to switch on without one (`transit_warehouse_unmapped`). These routes
 * are the only writer, on their own schema, so the 014 `ErpnextWarehouseMapping` routes never carry a transit row
 * (its `store_id` would be null, a breaking change for the Admin Console).
 *
 * Routes under test (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml):
 *   GET  /api/v1/catalog/erpnext-transit-warehouse-mapping             (get,    200)
 *   POST /api/v1/catalog/erpnext-transit-warehouse-mapping             (set,    201)
 *   POST /api/v1/catalog/erpnext-transit-warehouse-mapping/:id/retire  (retire, 200)
 * and, for the transit row, the 014 list (excludes it) and the 014 retire (404).
 *
 * The harness mirrors set-retire.spec.ts: production controller + service, guards overridden, RLS-active pool.
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";
import request from "supertest";

import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { hasActiveTransitWarehouse } from "../../../../src/catalog/erpnext-posting/transfer-posting.port";
import { ErpnextWarehouseMapController } from "../../../../src/catalog/erpnext-warehouse-map/erpnext-warehouse-map.controller";
import { ErpnextWarehouseMapService } from "../../../../src/catalog/erpnext-warehouse-map/erpnext-warehouse-map.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import { PG_POOL } from "../../../../src/database";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../../_helpers/postgres-container";
import { MAP_A_STOCK, WAREHOUSE_MAP_FIXTURE_IDS, seedWarehouseMapFixture } from "../__support__/seed-warehouse-map";

const TENANT_A = WAREHOUSE_MAP_FIXTURE_IDS.tenantA;
const TENANT_B = WAREHOUSE_MAP_FIXTURE_IDS.tenantB;
const ACTOR_A = WAREHOUSE_MAP_FIXTURE_IDS.actorA;
const ACTOR_B = WAREHOUSE_MAP_FIXTURE_IDS.actorB;

const TRANSIT_URL = "/api/v1/catalog/erpnext-transit-warehouse-mapping";
const transitRetireUrl = (id: string): string => `${TRANSIT_URL}/${id}/retire`;
const STORE_MAPPINGS_URL = "/api/v1/catalog/erpnext-warehouse-mappings";

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public userId: string = ACTOR_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    req.context = { userId: this.userId, tenantId: this.tenantId, storeId: null, isPlatformAdmin: false, source: "session" };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[transit-mapping.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedWarehouseMapFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  const auditInterceptor = new AuditEmitterInterceptor(new Reflector(), auditSpy);

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextWarehouseMapController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextWarehouseMapService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
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
  auditSpy.calls = [];
  contextGuard.tenantId = TENANT_A;
  contextGuard.userId = ACTOR_A;
});

afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(`DELETE FROM erpnext_warehouse_map WHERE purpose = 'transit'`);
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[transit-mapping.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function setTransit(ref: string) {
  return http().post(TRANSIT_URL).send({ erpnext_warehouse_ref: ref });
}

describe("RT-1574 — get", () => {
  it("answers 200 { mapping: null } when the tenant has no transit warehouse", async () => {
    if (maybeSkip()) return;
    const res = await http().get(TRANSIT_URL);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mapping: null });
  });

  it("answers the active transit mapping once one is set", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Goods In Transit - RT");
    const res = await http().get(TRANSIT_URL);
    expect(res.status).toBe(200);
    expect(res.body.mapping).toEqual(set.body);
  });

  it("never discloses another tenant's transit warehouse", async () => {
    if (maybeSkip()) return;
    expect((await setTransit("Transit A")).status).toBe(201);
    contextGuard.tenantId = TENANT_B;
    contextGuard.userId = ACTOR_B;
    const res = await http().get(TRANSIT_URL);
    expect(res.body).toEqual({ mapping: null });
  });
});

describe("RT-1574 — set", () => {
  it("creates the tenant's transit row (store_id NULL, purpose 'transit', version 1) and projects no store or purpose", async () => {
    if (maybeSkip()) return;
    const res = await setTransit("Goods In Transit - RT");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      erpnext_warehouse_ref: "Goods In Transit - RT",
      version: 1,
      set_by: ACTOR_A,
      retired_at: null,
    });
    expect(Object.keys(res.body).sort()).toEqual(
      ["created_at", "erpnext_warehouse_ref", "id", "retired_at", "set_at", "set_by", "updated_at", "version"],
    );
    const row = await env!.admin.query<{ tenant_id: string; store_id: string | null; purpose: string }>(
      `SELECT tenant_id, store_id, purpose FROM erpnext_warehouse_map WHERE id = $1`,
      [res.body.id],
    );
    expect(row.rows[0]).toEqual({ tenant_id: TENANT_A, store_id: null, purpose: "transit" });
  });

  it.each([
    ["store_id", { store_id: WAREHOUSE_MAP_FIXTURE_IDS.storeAMapped }],
    ["tenant_id", { tenant_id: TENANT_B }],
    ["purpose", { purpose: "stock" }],
    ["version", { version: 7 }],
  ])("rejects a smuggled %s with 400 validation_error", async (_label, extra) => {
    if (maybeSkip()) return;
    const res = await http().post(TRANSIT_URL).send({ erpnext_warehouse_ref: "Transit X", ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("a second active transit warehouse → 409 conflict", async () => {
    if (maybeSkip()) return;
    expect((await setTransit("Transit 1")).status).toBe(201);
    const second = await setTransit("Transit 2");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");
    expect(second.body.error.message).toMatch(/transit warehouse is already mapped/);
  });

  it("a Warehouse already held by an active store mapping → 409 conflict, nothing inserted", async () => {
    if (maybeSkip()) return;
    const res = await setTransit("ERP-WH-A-001"); // MAP_A_STOCK's warehouse
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
    expect(res.body.error.message).toMatch(/already mapped by an active mapping/);
    expect((await http().get(TRANSIT_URL)).body).toEqual({ mapping: null });
  });

  it("emits exactly one erpnext_warehouse_map.set audit subject", async () => {
    if (maybeSkip()) return;
    await setTransit("Transit Audit");
    expect(auditSpy.calls.map((c) => c.action)).toEqual(["erpnext_warehouse_map.set"]);
  });
});

describe("RT-1574 — retire", () => {
  it("retires the active transit row (retired_at set, version++), then get answers null and a fresh set succeeds", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit Old");
    const res = await http().post(transitRetireUrl(set.body.id)).send({ version: set.body.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: set.body.id, version: 2 });
    expect(typeof res.body.retired_at).toBe("string");
    expect((await http().get(TRANSIT_URL)).body).toEqual({ mapping: null });
    expect((await setTransit("Transit New")).status).toBe(201);
  });

  it("a stale version → 409 conflict", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit V");
    await http().post(transitRetireUrl(set.body.id)).send({ version: 1 });
    const stale = await http().post(transitRetireUrl(set.body.id)).send({ version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });

  it("a store ('stock') mapping id → 404: this route retires only the transit row", async () => {
    if (maybeSkip()) return;
    const res = await http().post(transitRetireUrl(MAP_A_STOCK)).send({ version: 1 });
    expect(res.status).toBe(404);
  });

  it("another tenant's transit row → 404 (non-disclosing)", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit A2");
    contextGuard.tenantId = TENANT_B;
    contextGuard.userId = ACTOR_B;
    const res = await http().post(transitRetireUrl(set.body.id)).send({ version: 1 });
    expect(res.status).toBe(404);
  });

  it("emits exactly one erpnext_warehouse_map.retired audit subject", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit Audit 2");
    auditSpy.calls = [];
    await http().post(transitRetireUrl(set.body.id)).send({ version: 1 });
    expect(auditSpy.calls.map((c) => c.action)).toEqual(["erpnext_warehouse_map.retired"]);
  });
});

describe("RT-1574 — the 014 store-mapping routes never carry a transit row", () => {
  it("the 014 list leaves the transit row out", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit Hidden");
    const res = await http().get(STORE_MAPPINGS_URL);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(MAP_A_STOCK);
    expect(ids).not.toContain(set.body.id);
  });

  it("a 014 store set on the transit row's Warehouse → 409 conflict (one mapping per Warehouse, RT-433)", async () => {
    if (maybeSkip()) return;
    expect((await setTransit("Transit Shared")).status).toBe(201);
    await env!.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'T1574', 'RT-1574 Store') ON CONFLICT DO NOTHING`,
      ["0a000000-0000-7000-8000-000000157401", TENANT_A],
    );
    const res = await http()
      .post(STORE_MAPPINGS_URL)
      .send({ store_id: "0a000000-0000-7000-8000-000000157401", erpnext_warehouse_ref: "Transit Shared" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already mapped by an active mapping/);
  });

  it("the 014 retire answers 404 for the transit row and leaves it active", async () => {
    if (maybeSkip()) return;
    const set = await setTransit("Transit Kept");
    const res = await http().post(`${STORE_MAPPINGS_URL}/${set.body.id}/retire`).send({ version: 1 });
    expect(res.status).toBe(404);
    expect((await http().get(TRANSIT_URL)).body.mapping?.id).toBe(set.body.id);
  });
});

describe("RT-1574 — shipment-transfer readiness reads the row (real hasActiveTransitWarehouse port)", () => {
  const ready = (): Promise<boolean> =>
    runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (client) =>
      hasActiveTransitWarehouse(client, TENANT_A),
    );

  it("turns true after a transit set and false again after retire", async () => {
    if (maybeSkip()) return;
    expect(await ready()).toBe(false);
    const set = await setTransit("Transit Ready");
    expect(await ready()).toBe(true);
    await http().post(transitRetireUrl(set.body.id)).send({ version: 1 });
    expect(await ready()).toBe(false);
  });
});
