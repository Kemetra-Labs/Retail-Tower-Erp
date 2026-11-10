/**
 * RT-61 — inventory store authorization for COOKIE SESSIONS, end to end, on
 * the documented production DB-role layout.
 *
 * The app runs as the non-superuser, NOBYPASSRLS `app_test` role on a pool
 * with ONE connection, so every request reuses a connection whose
 * transaction-local `app.current_tenant` has already reset to ''. Before
 * RT-61, `InventoryController.authorizeStore` re-queried `memberships` /
 * `store_access` on that plain connection, outside `runWithTenantContext`:
 * `''::uuid` raised 22P02 (→ 400) and even the tenant owner could not read
 * inventory. It now uses the store access TenantContextGuard already resolved
 * inside its tenant context (the RT-131 `resolveStoreScope` rule).
 *
 * Also covers the RT-120 scope amendment: a transfer must be authorized for
 * the DESTINATION store, not only the source.
 *
 * RT-1312 F7 (RT-132 c10674): inventory writes need owner, tenant_admin or
 * store_manager. The specific-store member is therefore a store_manager (its
 * scope tests are about store scope, not role); a separate store_staff clerk,
 * granted store A, proves a write is a non-disclosing 404 that records nothing
 * while its reads still work.
 */
import "reflect-metadata";

import { hashPassword } from "@data-pulse-2/auth";
import { createLogger } from "@data-pulse-2/shared";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import request from "supertest";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../../src/auth/auth.module";
import { EMAIL_JOB_ENQUEUER, NoOpEmailJobEnqueuer } from "../../../src/auth/email-job.enqueuer";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { LoggingInterceptor } from "../../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../../src/common/request-id.interceptor";
import { ZodValidationPipe } from "../../../src/common/zod-validation.pipe";
import { ContextModule } from "../../../src/context/context.module";
import { InventoryModule } from "../../../src/inventory/inventory.module";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { SAME_ORIGIN } from "../../_helpers/same-origin";

delete process.env["REDIS_URL"]; // AuthModule falls back to its in-process Redis stub

const TENANT = "aaaaaaaa-6161-4161-8161-aaaaaaaaaaaa";
const ROLE_OWNER = "cccccccc-6161-4161-8161-cccccccccccc";
const ROLE_STAFF = "dddddddd-6161-4161-8161-dddddddddddd";
const ROLE_CLERK = "dddddddd-6161-4161-8161-ddddddddddd3";
const OWNER_ID = "11111111-6161-4161-8161-111111111111";
const STAFF_ID = "22222222-6161-4161-8161-222222222222";
const CLERK_ID = "33333333-6161-4161-8161-333333333333";
const OWNER_EMAIL = "rt61-owner@example.com";
const STAFF_EMAIL = "rt61-staff@example.com";
const CLERK_EMAIL = "rt61-clerk@example.com";
const PASSWORD = "Rt61-Password-123!";
const M_OWNER = "eeeeeeee-6161-4161-8161-eeeeeeeeeee1";
const M_STAFF = "eeeeeeee-6161-4161-8161-eeeeeeeeeee2";
const M_CLERK = "eeeeeeee-6161-4161-8161-eeeeeeeeeee3";
const STORE_A = "11111111-aaaa-4aaa-8aaa-616161616161";
const STORE_B = "22222222-aaaa-4aaa-8aaa-616161616161";
const PRODUCT = "33333333-aaaa-4aaa-8aaa-616161616161";

let env: PgTestEnv | null = null;
let singleConnectionPool: Pool | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

function appRoleUri(adminUri: string): string {
  const url = new URL(adminUri);
  url.username = APP_ROLE_NAME;
  url.password = APP_ROLE_PASSWORD;
  return url.toString();
}

async function seed(admin: Pool): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await admin.query(
    `INSERT INTO users (id, email, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, false), ($4, $5, $3, false), ($6, $7, $3, false)`,
    [OWNER_ID, OWNER_EMAIL, hash, STAFF_ID, STAFF_EMAIL, CLERK_ID, CLERK_EMAIL],
  );
  await admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt61', 'RT-61')`, [TENANT]);
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner', 'Owner'), ($2, $3, 'store_manager', 'Store Manager'),
       ($4, $3, 'store_staff', 'Store Staff')`,
    [ROLE_OWNER, ROLE_STAFF, TENANT, ROLE_CLERK],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $3, $4, $5, 'all'), ($2, $3, $6, $7, 'specific'), ($8, $3, $9, $10, 'specific')`,
    [M_OWNER, M_STAFF, TENANT, OWNER_ID, ROLE_OWNER, STAFF_ID, ROLE_STAFF, M_CLERK, CLERK_ID, ROLE_CLERK],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $3, 'A', 'Store A'), ($2, $3, 'B', 'Store B')`,
    [STORE_A, STORE_B, TENANT],
  );
  // The staff member is granted store A only.
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3), ($4, $2, $3)`,
    [M_STAFF, STORE_A, TENANT, M_CLERK],
  );
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'RT-61 Product', 'standard', $3, $3)`,
    [PRODUCT, TENANT, OWNER_ID],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[session-store-authz.rls.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seed(env.admin);

  // One connection: every request reuses it after a transaction-local
  // set_config has reset app.current_tenant to '' (the production failure).
  singleConnectionPool = new Pool({ connectionString: appRoleUri(env.adminUri), max: 1 });

  const moduleRef = await Test.createTestingModule({
    imports: [AuthModule, ContextModule, InventoryModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(singleConnectionPool)
    // RT-1249: sign-in reads password_hash on the lookup role, which the
    // domain role (app_test) no longer may; the admin pool stands in for it.
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(env.admin)
    .overrideProvider(EMAIL_JOB_ENQUEUER)
    .useValue(new NoOpEmailJobEnqueuer())
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new LoggingInterceptor(createLogger({ service: "api-test", level: "silent" })),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close().catch(() => undefined);
  if (singleConnectionPool) await singleConnectionPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function http(): ReturnType<typeof request> {
  return request(app!.getHttpServer());
}

async function sessionFor(email: string): Promise<string> {
  const res = await http().post("/api/v1/auth/signin").send({ email, password: PASSWORD }).expect(200);
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list.find((c: string) => c.startsWith("dp2_session="))!.split(";")[0]!;
  await http().post("/api/v1/context/tenant").set("Cookie", cookie).set(SAME_ORIGIN).send({ tenant_id: TENANT }).expect(200);
  return cookie;
}

let seq = 0;
function idemKey(): string {
  seq += 1;
  return `rt61${String(seq).padStart(28, "0")}`;
}

describe("RT-61 inventory authorization for cookie sessions (NOBYPASSRLS role, reused connection)", () => {
  it("the tenant owner reads on-hand and movements for any store (200, not 400/404)", async () => {
    if (dockerSkipped) return;
    const owner = await sessionFor(OWNER_EMAIL);
    for (const store of [STORE_A, STORE_B]) {
      await http().get(`/api/inventory/v1/on-hand/${store}/${PRODUCT}`).set("Cookie", owner).set(SAME_ORIGIN).expect(200);
      await http().get(`/api/inventory/v1/stores/${store}/movements`).set("Cookie", owner).set(SAME_ORIGIN).expect(200);
    }
  });

  it("a specific-store member reads its granted store, and gets a non-disclosing 404 elsewhere", async () => {
    if (dockerSkipped) return;
    const staff = await sessionFor(STAFF_EMAIL);
    await http().get(`/api/inventory/v1/on-hand/${STORE_A}/${PRODUCT}`).set("Cookie", staff).set(SAME_ORIGIN).expect(200);
    await http().get(`/api/inventory/v1/on-hand/${STORE_B}/${PRODUCT}`).set("Cookie", staff).set(SAME_ORIGIN).expect(404);
    await http().get(`/api/inventory/v1/stores/${STORE_B}/movements`).set("Cookie", staff).set(SAME_ORIGIN).expect(404);
  });

  it("an owner addressing a store that is not in the tenant gets a non-disclosing 404, never 5xx", async () => {
    if (dockerSkipped) return;
    const owner = await sessionFor(OWNER_EMAIL);
    const unknownStore = "99999999-aaaa-4aaa-8aaa-616161616161";
    const probes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["get", `/api/inventory/v1/on-hand/${unknownStore}/${PRODUCT}`, undefined],
      ["get", `/api/inventory/v1/stores/${unknownStore}/movements`, undefined],
      ["post", `/api/inventory/v1/stores/${unknownStore}/movements`, { movementType: "inbound", quantity: "1", stockingUnit: "each" }],
      ["post", `/api/inventory/v1/stores/${unknownStore}/counts`, { tenantProductRef: PRODUCT, countedQuantity: "1", stockingUnit: "each" }],
      ["post", "/api/inventory/v1/transfers", { sourceStoreId: unknownStore, destinationStoreId: STORE_A, tenantProductRef: PRODUCT, quantity: "1", stockingUnit: "each" }],
      ["post", "/api/inventory/v1/transfers", { sourceStoreId: STORE_A, destinationStoreId: unknownStore, tenantProductRef: PRODUCT, quantity: "1", stockingUnit: "each" }],
    ];
    for (const [method, path, body] of probes) {
      let req = http()[method as "get" | "post"](path).set("Cookie", owner).set(SAME_ORIGIN);
      if (method === "post") req = req.set("Idempotency-Key", idemKey()).send(body);
      const res = await req;
      expect({ path, body, status: res.status }).toEqual({ path, body, status: 404 });
    }
  });

  it("unknown product / provenance refs on a granted store never produce a 5xx", async () => {
    if (dockerSkipped) return;
    const owner = await sessionFor(OWNER_EMAIL);
    const unknown = "88888888-aaaa-4aaa-8aaa-616161616161";
    const probes: Array<[string, Record<string, unknown>]> = [
      [`/api/inventory/v1/stores/${STORE_A}/movements`, { movementType: "inbound", quantity: "1", stockingUnit: "each", tenantProductRef: unknown }],
      [`/api/inventory/v1/stores/${STORE_A}/movements`, { movementType: "outbound", quantity: "-1", stockingUnit: "each", saleId: unknown, saleLineId: unknown }],
      [`/api/inventory/v1/stores/${STORE_A}/movements`, { movementType: "adjustment", quantity: "1", stockingUnit: "each", terminalEventRef: unknown }],
      [`/api/inventory/v1/stores/${STORE_A}/counts`, { tenantProductRef: unknown, countedQuantity: "1", stockingUnit: "each" }],
      ["/api/inventory/v1/transfers", { sourceStoreId: STORE_A, destinationStoreId: STORE_B, tenantProductRef: unknown, quantity: "1", stockingUnit: "each" }],
    ];
    for (const [path, body] of probes) {
      const res = await http().post(path).set("Cookie", owner).set(SAME_ORIGIN).set("Idempotency-Key", idemKey()).send(body);
      expect({ path, body, status: res.status < 500 }).toEqual({ path, body, status: true });
    }
  });

  it("a transfer is authorized for the destination store too", async () => {
    if (dockerSkipped) return;
    const body = (src: string, dst: string): Record<string, unknown> => ({
      sourceStoreId: src,
      destinationStoreId: dst,
      tenantProductRef: PRODUCT,
      quantity: "1",
      stockingUnit: "each",
    });
    const staff = await sessionFor(STAFF_EMAIL);
    const movementCount = async (): Promise<number> => {
      const r = await env!.admin.query(
        `SELECT count(*)::int AS n FROM stock_movements WHERE tenant_id = $1`,
        [TENANT],
      );
      return r.rows[0]!.n as number;
    };
    const before = await movementCount();
    // Granted source, non-granted destination → 404 and nothing written.
    await http()
      .post("/api/inventory/v1/transfers")
      .set("Cookie", staff)
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", idemKey())
      .send(body(STORE_A, STORE_B))
      .expect(404);
    expect(await movementCount()).toBe(before);

    // A tenant-wide member may transfer between any two of its stores.
    const owner = await sessionFor(OWNER_EMAIL);
    await http()
      .post("/api/inventory/v1/transfers")
      .set("Cookie", owner)
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", idemKey())
      .send(body(STORE_A, STORE_B))
      .expect(201);
  });

  it("RT-1312 F7: a store_staff clerk reads its store but every inventory write is a 404 that records nothing", async () => {
    if (dockerSkipped) return;
    const clerk = await sessionFor(CLERK_EMAIL);
    await http().get(`/api/inventory/v1/on-hand/${STORE_A}/${PRODUCT}`).set("Cookie", clerk).set(SAME_ORIGIN).expect(200);
    const movementCount = async (): Promise<number> => {
      const r = await env!.admin.query(`SELECT count(*)::int AS n FROM stock_movements WHERE tenant_id = $1`, [TENANT]);
      return r.rows[0]!.n as number;
    };
    const before = await movementCount();
    const writes: Array<[string, Record<string, unknown>]> = [
      [`/api/inventory/v1/stores/${STORE_A}/movements`, { movementType: "inbound", quantity: "1", stockingUnit: "each", tenantProductRef: PRODUCT }],
      [`/api/inventory/v1/stores/${STORE_A}/counts`, { tenantProductRef: PRODUCT, countedQuantity: "1", stockingUnit: "each" }],
      ["/api/inventory/v1/transfers", { sourceStoreId: STORE_A, destinationStoreId: STORE_A, tenantProductRef: PRODUCT, quantity: "1", stockingUnit: "each" }],
    ];
    for (const [path, body] of writes) {
      const res = await http().post(path).set("Cookie", clerk).set(SAME_ORIGIN).set("Idempotency-Key", idemKey()).send(body);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(await movementCount()).toBe(before);
  });

  it("RT-1312 F7: a store_manager may write inventory in its granted store", async () => {
    if (dockerSkipped) return;
    const manager = await sessionFor(STAFF_EMAIL);
    await http()
      .post(`/api/inventory/v1/stores/${STORE_A}/movements`)
      .set("Cookie", manager)
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", idemKey())
      .send({ movementType: "inbound", quantity: "1", stockingUnit: "each", tenantProductRef: PRODUCT })
      .expect(201);
  });
});
