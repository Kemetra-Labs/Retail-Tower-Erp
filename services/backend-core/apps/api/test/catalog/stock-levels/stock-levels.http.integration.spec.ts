/**
 * RT-1066 — the console stock-levels read and writes (`catalog/stock-levels.yaml`;
 * RT-1064 TH-1 to TH-5) over HTTP against real Postgres (Testcontainers, every
 * migration including 0078, the NOBYPASSRLS `app_test` pool) and the real
 * module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`, the shared `IdempotencyInterceptor` over a fake
 * Redis). Only cookie authentication is faked: a header names the session;
 * without it the real guard decides, so a bearer is 401 and a cookie write
 * with no trusted `Origin` is 403.
 *
 * What this proves (RT-1066 acceptance):
 *   - roles (TH-4): the read is owner / tenant_admin / store_manager; the
 *     tenant level writes owner / tenant_admin; the store level writes add
 *     store_manager for a store in its scope; every other role, a product of
 *     another tenant, an absent product and a store outside the scope, of
 *     another tenant or soft-deleted are one non-disclosing 404;
 *   - the store levels read follow the caller's store scope;
 *   - 422 `critical_above_reorder` (equal allowed), 409 `stale_write` (both
 *     ways of the `expectedUpdatedAt` precondition), 409 `product_retired`
 *     (a retire stays allowed on a retired product), 400 bodies;
 *   - both sets require an `Idempotency-Key`: replay, key conflict, missing
 *     and malformed keys, and the RT-1064 retire → recreate retry scenario
 *     (a replayed set never recreates a level another caller retired);
 *   - a retried retire is 404, or 409 `stale_write` once a new level exists;
 *   - exactly one `audit_events` row per accepted write with old / new values,
 *     none for a refused write, and nothing in `catalog_change_log`;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { StockLevelsModule } from "../../../src/catalog/stock-levels/stock-levels.module";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import {
  DASHBOARD_TOKEN,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
} from "../../console-sales/__support__/console-sales-fixture";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A } from "../__support__/isolation-harness";
import { P_B, seedConsoleCatalogFixture } from "../console-catalog/__support__/console-catalog-fixture";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_SPEC,
} from "../erpnext-reconciliation/__support__/read-store-scope";

type ProductId = string;
type StoreId = string;
type SessionHeader = string;
type RequestPath = string;
type ErrorCode = string;
type HttpStatus = number;
type RedisKey = string;
type SchemaName = string;

const levels = (productId: ProductId): RequestPath => `/api/v1/catalog/products/${productId}/stock-levels`;
const storeLevel = (productId: ProductId, storeId: StoreId): RequestPath => `${levels(productId)}/stores/${storeId}`;
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "stock-levels";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("1066e01");

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: RedisKey): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: RedisKey, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

interface Level {
  reorderLevel: string;
  criticalLevel: string | null;
  updatedAt: string;
}
interface Levels {
  productId: string;
  tenantLevel: Level | null;
  storeLevels: (Level & { storeId: string })[];
}
interface AuditRow {
  action: string;
  actor_user_id: string;
  store_id: string | null;
  target_type: string;
  metadata: Record<string, unknown>;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let levelsSchema: ValidateFunction;
let errorSchema: ValidateFunction;
let setRequestSchema: ValidateFunction;
let retireRequestSchema: ValidateFunction;

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  const compiled = (name: SchemaName): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  levelsSchema = compiled("ProductStockLevels");
  errorSchema = compiled("Error");
  setRequestSchema = compiled("SetStockLevelRequest");
  retireRequestSchema = compiled("RetireStockLevelRequest");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleCatalogFixture(env);
    await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1066-actor@example.test')`, [ACTOR]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1066 stock levels] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    {
      provide: APP_INTERCEPTOR,
      useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker),
    },
  ];
  app = await bootScopedApp(env, StockLevelsModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1066 stock levels] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

function key(): string {
  seq += 1;
  return `rt1066-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
}

function read(path: RequestPath, session: SessionHeader): request.Test {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session);
}

/** A set (PUT) as `session` with a trusted Origin; `idempotencyKey` null sends none. */
function put(path: RequestPath, session: SessionHeader, body: unknown, idempotencyKey: string | null = key()): request.Test {
  const req = request(app!.getHttpServer()).put(path).set("Origin", ORIGIN).set("x-test-session", session);
  return (idempotencyKey === null ? req : req.set("Idempotency-Key", idempotencyKey)).send(body as object);
}

/** A retire (POST) as `session` with a trusted Origin. */
function retire(path: RequestPath, session: SessionHeader, body: unknown): request.Test {
  return request(app!.getHttpServer())
    .post(`${path}/retire`)
    .set("Origin", ORIGIN)
    .set("x-test-session", session)
    .send(body as object);
}

/** A 200: asserts no-store and the `ProductStockLevels` shape. */
function ok(res: request.Response): Levels {
  if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(levelsSchema, res.body);
  return res.body as Levels;
}

/** A refusal: asserts the status and the error code of the envelope. */
function refused(res: request.Response, status: HttpStatus, code: ErrorCode): void {
  if (res.status !== status) throw new Error(`expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expectValid(errorSchema, res.body);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

function notFound(res: request.Response): void {
  refused(res, 404, "not_found");
  expect((res.body as { error: object }).error).toEqual(expect.objectContaining(NOT_FOUND));
}

/** A fresh tenant-A product (admin pool), so every test owns its rows. */
async function seedProduct(opts: { retired?: boolean } = {}): Promise<string> {
  seq += 1;
  const id = a(`1066${seq.toString(16).padStart(4, "0")}`);
  await env!.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, 'standard', CASE WHEN $4::boolean THEN now() END, $5, $5)`,
    [id, TENANT_A, `RT1066 product ${seq}`, opts.retired ?? false, ACTOR],
  );
  return id;
}

async function audits(productId: ProductId): Promise<AuditRow[]> {
  const r = await env!.admin.query(
    `SELECT action, actor_user_id::text, store_id::text, target_type, metadata FROM audit_events
      WHERE action LIKE 'catalog.%stock_level.%' AND metadata->>'product_id' = $1::text
      ORDER BY occurred_at, id`,
    [productId],
  );
  return r.rows as AuditRow[];
}

async function rowCount(productId: ProductId): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM product_stock_levels WHERE product_id = $1`, [
    productId,
  ]);
  return Number(r.rows[0]!.n);
}

async function activeTenantLevelCount(productId: ProductId): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM product_stock_levels WHERE product_id = $1 AND store_id IS NULL AND retired_at IS NULL`,
    [productId],
  );
  return Number(r.rows[0]!.n);
}

/** A tenant level created as SES_OWNER_ALL; returns its levels. */
async function createTenantLevel(productId: ProductId, body: { reorderLevel: string; criticalLevel?: string | null }): Promise<Levels> {
  return ok(await put(levels(productId), SES_OWNER_ALL, { expectedUpdatedAt: null, ...body }));
}

// ===========================================================================
// Auth, origin and roles
// ===========================================================================
describe("stock levels — auth, origin and roles", () => {
  it("refuses a bearer with 401 and a cookie write without a trusted Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const bearer = await request(app!.getHttpServer()).get(levels(id)).set("Authorization", `Bearer ${DASHBOARD_TOKEN}`);
    expect(bearer.status).toBe(401);
    const noOrigin = await request(app!.getHttpServer())
      .put(levels(id))
      .set("Cookie", "dp2_session=rt1066-not-a-session")
      .set("Idempotency-Key", key())
      .send({ expectedUpdatedAt: null, reorderLevel: "5" });
    refused(noOrigin, 403, "origin_rejected");
    const foreignOrigin = await request(app!.getHttpServer())
      .post(`${levels(id)}/retire`)
      .set("Cookie", "dp2_session=rt1066-not-a-session")
      .set("Origin", "https://evil.example")
      .send({ expectedUpdatedAt: new Date().toISOString() });
    refused(foreignOrigin, 403, "origin_rejected");
    expect(await rowCount(id)).toBe(0);
  });

  it("answers store_staff on all five operations and store_manager on the tenant level writes with the identical 404", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const created = await createTenantLevel(id, { reorderLevel: "10" });
    const at = created.tenantLevel!.updatedAt;
    const before = await audits(id);

    notFound(await read(levels(id), SES_STAFF));
    for (const session of [SES_STAFF, SES_MANAGER]) {
      notFound(await put(levels(id), session, { expectedUpdatedAt: at, reorderLevel: "3" }));
      notFound(await retire(levels(id), session, { expectedUpdatedAt: at }));
    }
    notFound(await put(storeLevel(id, STORE_A_X), SES_STAFF, { expectedUpdatedAt: null, reorderLevel: "3" }));
    notFound(await retire(storeLevel(id, STORE_A_X), SES_STAFF, { expectedUpdatedAt: at }));

    expect(await audits(id)).toEqual(before);
    expect(await rowCount(id)).toBe(1);
  });

  it("answers a product of another tenant and an absent product with the same 404 on every operation", async () => {
    if (skip()) return;
    const at = new Date().toISOString();
    for (const productId of [P_B, NON_EXISTENT]) {
      notFound(await read(levels(productId), SES_OWNER_ALL));
      notFound(await put(levels(productId), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "5" }));
      notFound(await retire(levels(productId), SES_OWNER_ALL, { expectedUpdatedAt: at }));
      notFound(await put(storeLevel(productId, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "5" }));
      notFound(await retire(storeLevel(productId, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: at }));
    }
    const leaked = await env!.admin.query(`SELECT 1 FROM product_stock_levels WHERE product_id = ANY($1::uuid[])`, [
      [P_B, NON_EXISTENT],
    ]);
    expect(leaked.rowCount).toBe(0);
  });

  it("answers a store outside the caller's scope, of another tenant or soft-deleted with the same 404", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const body = { expectedUpdatedAt: null, reorderLevel: "5" };
    // tenant_admin granted X only; store_manager narrowed to its active store Y.
    notFound(await put(storeLevel(id, STORE_A_Y), SES_ADMIN_SPEC, body));
    notFound(await put(storeLevel(id, STORE_A_X), SES_MANAGER_ACTIVE, body));
    // Another tenant's store, a soft-deleted store (granted to the specific owner), an absent store.
    notFound(await put(storeLevel(id, STORE_B_X), SES_OWNER_ALL, body));
    notFound(await put(storeLevel(id, S_DELETED), SES_OWNER_SPEC, body));
    notFound(await put(storeLevel(id, NON_EXISTENT), SES_OWNER_ALL, body));
    notFound(await retire(storeLevel(id, STORE_A_Y), SES_ADMIN_SPEC, { expectedUpdatedAt: new Date().toISOString() }));
    expect(await rowCount(id)).toBe(0);
    expect(await audits(id)).toEqual([]);
  });
});

// ===========================================================================
// Read
// ===========================================================================
describe("stock levels — read (consoleGetProductStockLevels)", () => {
  it("reads null and [] for a product with no level, whatever its status", async () => {
    if (skip()) return;
    for (const id of [await seedProduct(), await seedProduct({ retired: true })]) {
      expect(ok(await read(levels(id), SES_MANAGER))).toEqual({ productId: id, tenantLevel: null, storeLevels: [] });
    }
  });

  it("lists only the store levels of the caller's scope, ordered by storeId; the tenant level for every role", async () => {
    if (skip()) return;
    const id = await seedProduct();
    await createTenantLevel(id, { reorderLevel: "20", criticalLevel: "5" });
    ok(await put(storeLevel(id, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "8", criticalLevel: null }));
    ok(await put(storeLevel(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "6.25" }));
    // A soft-deleted store's leftover row is never shown.
    await env!.admin.query(
      `INSERT INTO product_stock_levels (id, tenant_id, product_id, store_id, reorder_level, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 4, $5, $5)`,
      [a(`1066f${seq.toString(16).padStart(3, "0")}`), TENANT_A, id, S_DELETED, ACTOR],
    );

    const all = ok(await read(levels(id), SES_OWNER_ALL));
    expect(all.tenantLevel).toEqual(expect.objectContaining({ reorderLevel: "20.0000", criticalLevel: "5.0000" }));
    expect(all.storeLevels.map((l) => [l.storeId, l.reorderLevel, l.criticalLevel])).toEqual(
      [
        [STORE_A_X, "8.0000", null],
        [STORE_A_Y, "6.2500", null],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(ok(await read(levels(id), SES_ADMIN_SPEC)).storeLevels.map((l) => l.storeId)).toEqual([STORE_A_X]);
    expect(ok(await read(levels(id), SES_MANAGER_ACTIVE)).storeLevels.map((l) => l.storeId)).toEqual([STORE_A_Y]);
    expect(ok(await read(levels(id), SES_OWNER_SPEC)).storeLevels.map((l) => l.storeId)).toEqual([STORE_A_X]);
    expect(ok(await read(levels(id), SES_MANAGER_ACTIVE)).tenantLevel).not.toBeNull();
  });

  it("refuses a malformed productId and any query key with 400 validation_error", async () => {
    if (skip()) return;
    const id = await seedProduct();
    refused(await read(levels("not-a-uuid"), SES_OWNER_ALL), 400, "validation_error");
    refused(await read(`${levels(id)}?storeId=${STORE_A_X}`, SES_OWNER_ALL), 400, "validation_error");
  });

  it("writes no audit row for a read", async () => {
    if (skip()) return;
    const id = await seedProduct();
    ok(await read(levels(id), SES_OWNER_ALL));
    expect(await audits(id)).toEqual([]);
  });
});

// ===========================================================================
// Tenant level writes
// ===========================================================================
describe("stock levels — tenant level set / retire", () => {
  it("creates, replaces and retires the tenant level, one audit row each, nothing in catalog_change_log", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const changeLogBefore = await env!.admin.query(`SELECT count(*)::int AS n FROM catalog_change_log WHERE product_id = $1`, [id]);

    const created = await createTenantLevel(id, { reorderLevel: "10", criticalLevel: "10" });
    expect(created.tenantLevel).toEqual(expect.objectContaining({ reorderLevel: "10.0000", criticalLevel: "10.0000" }));

    const replaced = ok(
      await put(levels(id), SES_ADMIN_SPEC, {
        expectedUpdatedAt: created.tenantLevel!.updatedAt,
        reorderLevel: "12.5",
        criticalLevel: null,
      }),
    );
    expect(replaced.tenantLevel).toEqual(expect.objectContaining({ reorderLevel: "12.5000", criticalLevel: null }));
    expect(Date.parse(replaced.tenantLevel!.updatedAt)).toBeGreaterThan(Date.parse(created.tenantLevel!.updatedAt));

    const retired = ok(await retire(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: replaced.tenantLevel!.updatedAt }));
    expect(retired.tenantLevel).toBeNull();
    expect(await rowCount(id)).toBe(1);

    const rows = await audits(id);
    expect(rows.map((r) => [r.action, r.store_id, r.target_type])).toEqual([
      ["catalog.stock_level.set", null, "product_stock_level"],
      ["catalog.stock_level.set", null, "product_stock_level"],
      ["catalog.stock_level.retire", null, "product_stock_level"],
    ]);
    expect(rows[0]!.metadata).toEqual({
      product_id: id,
      created: true,
      old: null,
      new: { reorderLevel: "10", criticalLevel: "10" },
    });
    expect(rows[1]!.metadata).toEqual({
      product_id: id,
      created: false,
      old: { reorderLevel: "10.0000", criticalLevel: "10.0000" },
      new: { reorderLevel: "12.5", criticalLevel: null },
    });
    expect(rows[2]!.metadata).toEqual({
      product_id: id,
      old: { reorderLevel: "12.5000", criticalLevel: null },
      new: null,
    });
    const changeLogAfter = await env!.admin.query(`SELECT count(*)::int AS n FROM catalog_change_log WHERE product_id = $1`, [id]);
    expect(changeLogAfter.rows[0]).toEqual(changeLogBefore.rows[0]);
  });

  it("refuses criticalLevel above reorderLevel with 422 critical_above_reorder and writes nothing", async () => {
    if (skip()) return;
    const id = await seedProduct();
    refused(
      await put(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "5", criticalLevel: "5.0001" }),
      422,
      "critical_above_reorder",
    );
    refused(
      await put(storeLevel(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: null, reorderLevel: "9.5", criticalLevel: "10" }),
      422,
      "critical_above_reorder",
    );
    expect(await rowCount(id)).toBe(0);
    expect(await audits(id)).toEqual([]);
  });

  it("refuses a stale precondition either way with 409 stale_write and writes nothing", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const created = await createTenantLevel(id, { reorderLevel: "10" });
    const at = created.tenantLevel!.updatedAt;
    // null asserts "no active level", but there is one.
    refused(await put(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "7" }), 409, "stale_write");
    // An instant that is not the level's updatedAt.
    const stale = new Date(Date.parse(at) - 1).toISOString();
    refused(await put(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: stale, reorderLevel: "7" }), 409, "stale_write");
    refused(await retire(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: stale }), 409, "stale_write");
    // An instant given while there is no level is stale too.
    const other = await seedProduct();
    refused(await put(levels(other), SES_OWNER_ALL, { expectedUpdatedAt: at, reorderLevel: "7" }), 409, "stale_write");

    expect(ok(await read(levels(id), SES_OWNER_ALL)).tenantLevel).toEqual(created.tenantLevel);
    expect((await audits(id)).length).toBe(1);
    expect(await rowCount(other)).toBe(0);
  });

  it("refuses a set on a retired product with 409 product_retired, but retires its level", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const created = await createTenantLevel(id, { reorderLevel: "10" });
    await env!.admin.query(`UPDATE tenant_products SET retired_at = now() WHERE id = $1`, [id]);
    refused(
      await put(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: created.tenantLevel!.updatedAt, reorderLevel: "3" }),
      409,
      "product_retired",
    );
    refused(
      await put(storeLevel(id, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "3" }),
      409,
      "product_retired",
    );
    const retired = ok(await retire(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: created.tenantLevel!.updatedAt }));
    expect(retired.tenantLevel).toBeNull();
    expect((await audits(id)).map((r) => r.action)).toEqual(["catalog.stock_level.set", "catalog.stock_level.retire"]);
  });

  it("answers a retried retire with 404, and with 409 stale_write once a new level exists", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const created = await createTenantLevel(id, { reorderLevel: "10" });
    const body = { expectedUpdatedAt: created.tenantLevel!.updatedAt };
    ok(await retire(levels(id), SES_OWNER_ALL, body));
    notFound(await retire(levels(id), SES_OWNER_ALL, body));
    const recreated = await createTenantLevel(id, { reorderLevel: "11" });
    expect(Date.parse(recreated.tenantLevel!.updatedAt)).toBeGreaterThan(Date.parse(created.tenantLevel!.updatedAt));
    refused(await retire(levels(id), SES_OWNER_ALL, body), 409, "stale_write");
    expect(ok(await read(levels(id), SES_OWNER_ALL)).tenantLevel).toEqual(recreated.tenantLevel);
    expect((await audits(id)).map((r) => r.action)).toEqual([
      "catalog.stock_level.set",
      "catalog.stock_level.retire",
      "catalog.stock_level.set",
    ]);
  });

  it.each([
    ["a JSON number", { expectedUpdatedAt: null, reorderLevel: 5 }],
    ["zero", { expectedUpdatedAt: null, reorderLevel: "0" }],
    ["a negative level", { expectedUpdatedAt: null, reorderLevel: "-1" }],
    ["five fractional digits", { expectedUpdatedAt: null, reorderLevel: "1.00001" }],
    ["sixteen integer digits", { expectedUpdatedAt: null, reorderLevel: "1234567890123456" }],
    ["an exponent", { expectedUpdatedAt: null, reorderLevel: "1e3" }],
    ["a zero critical level", { expectedUpdatedAt: null, reorderLevel: "5", criticalLevel: "0.0" }],
    ["no expectedUpdatedAt", { reorderLevel: "5" }],
    ["no reorderLevel", { expectedUpdatedAt: null }],
    ["an unknown key", { expectedUpdatedAt: null, reorderLevel: "5", storeId: STORE_A_X }],
    ["a server-owned key", { expectedUpdatedAt: null, reorderLevel: "5", updatedAt: new Date().toISOString() }],
    ["a malformed expectedUpdatedAt", { expectedUpdatedAt: "yesterday", reorderLevel: "5" }],
  ])("refuses a set body with %s with 400 validation_error (the contract agrees)", async (_label, body) => {
    if (skip()) return;
    expect(setRequestSchema(body)).toBe(false);
    const id = await seedProduct();
    refused(await put(levels(id), SES_OWNER_ALL, body), 400, "validation_error");
    expect(await rowCount(id)).toBe(0);
  });

  it("refuses a retire body without a usable expectedUpdatedAt, and any query key on a write, with 400", async () => {
    if (skip()) return;
    const id = await seedProduct();
    for (const body of [{}, { expectedUpdatedAt: null }, { expectedUpdatedAt: new Date().toISOString(), extra: 1 }]) {
      expect(retireRequestSchema(body)).toBe(false);
      refused(await retire(levels(id), SES_OWNER_ALL, body), 400, "validation_error");
    }
    const q = await request(app!.getHttpServer())
      .put(`${levels(id)}?x=1`)
      .set("Origin", ORIGIN)
      .set("x-test-session", SES_OWNER_ALL)
      .set("Idempotency-Key", key())
      .send({ expectedUpdatedAt: null, reorderLevel: "5" });
    refused(q, 400, "validation_error");
    refused(await put(levels("not-a-uuid"), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "5" }), 400, "validation_error");
    expect(await rowCount(id)).toBe(0);
  });
});

// ===========================================================================
// Idempotency
// ===========================================================================
describe("stock levels — Idempotency-Key on the sets", () => {
  it("replays an identical set (Idempotent-Replayed: true), writing nothing; key reuse with another body is 409", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const k = key();
    const body = { expectedUpdatedAt: null, reorderLevel: "10" };
    const first = await put(levels(id), SES_OWNER_ALL, body, k);
    const created = ok(first);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    const replay = await put(levels(id), SES_OWNER_ALL, body, k);
    expect(ok(replay)).toEqual(created);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    refused(await put(levels(id), SES_OWNER_ALL, { ...body, reorderLevel: "11" }, k), 409, "idempotency_key_conflict");
    expect(await rowCount(id)).toBe(1);
    expect((await audits(id)).length).toBe(1);
  });

  it("requires a well-formed key on both sets (400 idempotency_key_required / idempotency_key_malformed)", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const body = { expectedUpdatedAt: null, reorderLevel: "10" };
    for (const path of [levels(id), storeLevel(id, STORE_A_X)]) {
      refused(await put(path, SES_OWNER_ALL, body, null), 400, "idempotency_key_required");
      refused(await put(path, SES_OWNER_ALL, body, "short"), 400, "idempotency_key_malformed");
    }
    expect(await rowCount(id)).toBe(0);
  });

  it("RT-1064 retire → recreate: a retried set replays its first answer and never recreates the retired level", async () => {
    if (skip()) return;
    // The tenant level (set by an owner) and a store level (set by its store_manager).
    const scopes: [(id: ProductId) => RequestPath, SessionHeader][] = [
      [(id) => levels(id), SES_OWNER_ALL],
      [(id) => storeLevel(id, STORE_A_X), SES_MANAGER],
    ];
    for (const [path, session] of scopes) {
      const id = await seedProduct();
      const k = key();
      const body = { expectedUpdatedAt: null, reorderLevel: "10" };
      const created = ok(await put(path(id), session, body, k));
      const level = created.tenantLevel ?? created.storeLevels[0]!;
      // Another caller retires the level.
      ok(await retire(path(id), SES_ADMIN_SPEC, { expectedUpdatedAt: level.updatedAt }));
      // The first caller's retry of the same set: replayed, nothing written.
      const retry = await put(path(id), session, body, k);
      expect(ok(retry)).toEqual(created);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      const now = ok(await read(levels(id), SES_OWNER_ALL));
      expect(now.tenantLevel).toBeNull();
      expect(now.storeLevels).toEqual([]);
      expect(await rowCount(id)).toBe(1);
      expect(await activeTenantLevelCount(id)).toBe(0);
      expect((await audits(id)).map((r) => (r.action.endsWith(".set") ? "set" : "retire"))).toEqual(["set", "retire"]);
    }
  });
});

// ===========================================================================
// Store level writes
// ===========================================================================
describe("stock levels — store level set / retire", () => {
  it("lets a store_manager set and retire its own store's level; audited with the store", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const tenant = await createTenantLevel(id, { reorderLevel: "20", criticalLevel: "5" });
    const set = ok(
      await put(storeLevel(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: null, reorderLevel: "8", criticalLevel: null }),
    );
    // The store level holds both values (TH-3): no critical level here, whatever the tenant level says.
    expect(set.storeLevels).toEqual([expect.objectContaining({ storeId: STORE_A_X, reorderLevel: "8.0000", criticalLevel: null })]);
    expect(set.tenantLevel).toEqual(tenant.tenantLevel);

    const replaced = ok(
      await put(storeLevel(id, STORE_A_X), SES_MANAGER, {
        expectedUpdatedAt: set.storeLevels[0]!.updatedAt,
        reorderLevel: "9",
        criticalLevel: "9",
      }),
    );
    const retired = ok(await retire(storeLevel(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: replaced.storeLevels[0]!.updatedAt }));
    expect(retired.storeLevels).toEqual([]);
    // Retiring the store level leaves the tenant level untouched.
    expect(retired.tenantLevel).toEqual(tenant.tenantLevel);
    notFound(await retire(storeLevel(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: replaced.storeLevels[0]!.updatedAt }));

    const rows = (await audits(id)).filter((r) => r.action.startsWith("catalog.store_stock_level."));
    expect(rows.map((r) => [r.action, r.store_id])).toEqual([
      ["catalog.store_stock_level.set", STORE_A_X],
      ["catalog.store_stock_level.set", STORE_A_X],
      ["catalog.store_stock_level.retire", STORE_A_X],
    ]);
    expect(rows[0]!.metadata).toEqual({
      product_id: id,
      store_id: STORE_A_X,
      created: true,
      old: null,
      new: { reorderLevel: "8", criticalLevel: null },
    });
    expect(rows[2]!.metadata).toEqual({
      product_id: id,
      store_id: STORE_A_X,
      old: { reorderLevel: "9.0000", criticalLevel: "9.0000" },
      new: null,
    });
  });

  it("keeps store levels per store; a store level does not satisfy the tenant precondition", async () => {
    if (skip()) return;
    const id = await seedProduct();
    ok(await put(storeLevel(id, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "1" }));
    ok(await put(storeLevel(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "2" }));
    const tenant = ok(await put(levels(id), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "3" }));
    expect(tenant.storeLevels).toHaveLength(2);
    refused(await put(storeLevel(id, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, reorderLevel: "4" }), 409, "stale_write");
    expect(await rowCount(id)).toBe(3);
  });
});
