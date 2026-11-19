/**
 * RT-1484 (RT-282 PR-09a) — Price Books and Zones over HTTP against real Postgres
 * (Testcontainers, every migration including 0121 and 0123, the NOBYPASSRLS `app_test` pool
 * holding only the production pricing grants of `pricing.grants.ts` and
 * `price-change-set-content.grants.ts`: SELECT and INSERT, column UPDATE, no DELETE) and the real
 * module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`, the shared
 * `IdempotencyInterceptor` over a fake Redis). Only cookie authentication is faked.
 *
 * What this proves (`pricing/price-structure.yaml` 1.0.0-draft):
 *   - roles: writes are owner / tenant_admin; reads add store_manager; store_staff is the
 *     non-disclosing 404; a bearer is 401; a cookie write without `Origin` is 403;
 *   - the Book create writes the Book, its default Zone and one audit row; replays on its
 *     `Idempotency-Key`, refuses key reuse with another body, and refuses a second Book
 *     (`price_book_exists`); a currency with no minor unit is 400 and writes nothing;
 *   - Zones: create (`price_zone_code_taken`), retire (`default_price_zone_immutable`,
 *     `price_zone_retired`, `price_zone_in_use` for an active membership and for an open Change
 *     Set line), each with its audit row, the retirement replaying on its key;
 *   - reads at a revision and an instant: explicit and default members of a Zone, the store
 *     scope of a `specific` tenant_admin, a revision above the head (422), keyset pages whose
 *     cursor fixes the evaluation, and a Store's membership timeline as known at a revision;
 *   - RLS isolation of two tenants: tenant B never sees, reads or writes tenant A's structure,
 *     and both tenants may hold the same Book code;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import type { GrantFragment } from "../../src/auth/grant-fragment";
import { GRANTS as CONTENT_GRANTS } from "../../src/auth/grants/price-change-set-content.grants";
import { GRANTS as PRICING_GRANTS } from "../../src/auth/grants/pricing.grants";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { PriceStructureModule } from "../../src/pricing/structure/price-structure.module";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  bootScopedApp,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  DASHBOARD_TOKEN,
  SES_MANAGER,
  SES_STAFF,
  seedConsoleSalesFixture,
} from "../console-sales/__support__/console-sales-fixture";

type Path = string;
type Session = string;

const BOOKS = "/api/v1/pricing/books";
const bookPath = (id: string): Path => `${BOOKS}/${id}`;
const zonesPath = (book: string): Path => `${BOOKS}/${book}/zones`;
const retirePath = (book: string, zone: string): Path => `${BOOKS}/${book}/zones/${zone}/retire`;
const zoneStoresPath = (book: string, zone: string): Path => `${BOOKS}/${book}/zones/${zone}/stores`;
const membershipsPath = (store: string): Path => `/api/v1/pricing/stores/${store}/zone-memberships`;
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT = "price-structure";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const SES_OWNER_B = b("1484a1");
const ACTOR = a("1484e1");
const ABSENT = a("1484ff");

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
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

interface Zone {
  id: string;
  priceBookId: string;
  code: string;
  isDefault: boolean;
  retiredAt: string | null;
  retireReason: string | null;
}
interface Book {
  id: string;
  code: string;
  defaultZone: Zone;
}
interface StorePage {
  zoneId: string;
  evaluatedAt: string;
  asOfRevision: number | null;
  items: { storeId: string; membership: "explicit" | "default"; membershipId: string | null }[];
  nextCursor: string | null;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let schema: (name: string) => ValidateFunction;

/** Production grants only: the fragment's table privileges and UPDATE columns, nothing else. */
async function restrictToPricingGrants(admin: Pool): Promise<void> {
  const fragments: readonly GrantFragment[] = [PRICING_GRANTS, CONTENT_GRANTS];
  const statements: string[] = [];
  for (const fragment of fragments) {
    const tables = new Map<string, string[]>();
    for (const [table, privilege] of fragment.domainRequired) tables.set(table, [...(tables.get(table) ?? []), privilege]);
    for (const [table, privileges] of tables) {
      statements.push(`REVOKE ALL ON ${table} FROM ${APP_ROLE_NAME}`, `GRANT ${privileges.join(", ")} ON ${table} TO ${APP_ROLE_NAME}`);
    }
    for (const [table, column, privilege] of fragment.domainRequiredColumns ?? []) {
      statements.push(`GRANT ${privilege} (${column}) ON ${table} TO ${APP_ROLE_NAME}`);
    }
  }
  await admin.query(statements.join(";\n"));
}

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT) as object, CONTRACT);
  schema = (name) => {
    const v = ajv.getSchema(`${CONTRACT}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-1484 price structure] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("1484b1"),
    email: "rt1484-owner-b@example.test",
    membershipId: b("1484c1"),
    roleId: b("1484d1"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
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
  app = await bootScopedApp(env, PriceStructureModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1484 price structure] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(name: string, body: unknown): void {
  const v = schema(name);
  if (!v(body)) throw new Error(`${name} contract violation: ${JSON.stringify(v.errors)} in ${JSON.stringify(body)}`);
}

function get(path: Path, session: Session | null): request.Test {
  const req = request(app!.getHttpServer()).get(path);
  return session === null ? req : req.set("x-test-session", session);
}

function post(path: Path, session: Session | null, body: unknown, idemKey: string | null = key()): request.Test {
  let req = request(app!.getHttpServer()).post(path).set("Origin", ORIGIN).send(body as object);
  if (idemKey !== null) req = req.set("Idempotency-Key", idemKey);
  return session === null ? req : req.set("x-test-session", session);
}

function key(): string {
  seq += 1;
  return `rt1484-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
}

function expectStatus(res: request.Response, status: number): void {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
}

function refused(res: request.Response, status: number, code: string): void {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

async function audits(action: string, targetId: string): Promise<{ actor_user_id: string; metadata: Record<string, unknown> }[]> {
  const r = await env!.admin.query(
    `SELECT actor_user_id::text, metadata FROM audit_events WHERE action = $1 AND target_id = $2::uuid`,
    [action, targetId],
  );
  return r.rows as { actor_user_id: string; metadata: Record<string, unknown> }[];
}

async function countAll(table: "price_books" | "price_zones", tenantId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0]!.n);
}

/**
 * Published structure for tenant A, seeded by the superuser with triggers off (the publish
 * runtime is a later RT-1484 slice): revision 1 moves STORE_A_X into `zone` from 2026-01-01;
 * revision 2 moves STORE_A_Y into it from 2030-01-01. A draft Change Set has a line targeting
 * `lineZone`.
 */
async function seedPublishedStructure(bookId: string, zone: string, lineZone: string): Promise<{ mX: string; mY: string }> {
  const c = await env!.admin.connect();
  const mX = a("1484f1");
  const mY = a("1484f2");
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    // Revision 1 is the tenant's legacy import, revision 2 an approved standard publish.
    const hash = `sha256:${"a".repeat(64)}`;
    for (const [n, cs, kind] of [[1, a("14840c1"), "legacy_import"], [2, a("14840c2"), "standard"]] as const) {
      const legacy = kind === "legacy_import";
      await c.query(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, revision_no, created_by_user_id, correlation_id,
                                  published_by_user_id, published_at, validated_at_revision, preview_hash,
                                  target_store_set_hash, sensitive, approved_by_user_id, approved_at)
         VALUES ($1, $2, 'pricing', $5, 'seed', 'published', $3, $4, $1, $4, now(), $6, $7, $7, $8, $9, $10)`,
        [cs, TENANT_A, n, ACTOR, kind, legacy ? null : 1, legacy ? null : hash, legacy ? null : false,
          legacy ? null : ACTOR, legacy ? null : new Date()],
      );
      await c.query(
        `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $5, $4, $3)`,
        [TENANT_A, n, cs, ACTOR, legacy ? "legacy_import" : "publish"],
      );
    }
    for (const [id, store, from, rev] of [[mX, STORE_A_X, "2026-01-01T00:00:00Z", 1], [mY, STORE_A_Y, "2030-01-01T00:00:00Z", 2]] as const) {
      await c.query(
        `INSERT INTO price_zone_memberships
           (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, published_in_revision, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1)`,
        [id, TENANT_A, bookId, zone, store, from, rev, ACTOR],
      );
    }
    const draft = a("14840c3");
    await c.query(
      `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'pricing', 'standard', 'draft', $3, $1)`,
      [draft, TENANT_A, ACTOR],
    );
    await c.query(
      `INSERT INTO price_change_set_lines
         (tenant_id, change_set_id, change_set_version, line_no, item_list_version, item_position, op, scope, price_book_id,
          price_zone_id, product_id, sell_unit, time_basis, effective_from_local, new_price, class, created_by_user_id,
          correlation_id)
       VALUES ($1, $2, 1, 1, 1, 1, 'set_price', 'zone', $3, $4, $5, 'each', 'store_local', '2031-01-01T00:00:00', 10, 'new', $6, $2)`,
      [TENANT_A, draft, bookId, lineZone, a("1484a9"), ACTOR],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  return { mX, mY };
}

describe("RT-1484 price structure over HTTP", () => {
  let book: Book;
  let north: Zone;
  let east: Zone;
  let seeded: { mX: string; mY: string };

  it("before any Book: an empty list, and a Store falls back to no Book at no revision", async () => {
    if (skip()) return;
    const list = await get(BOOKS, SES_OWNER_ALL);
    expectStatus(list, 200);
    expectValid("PriceBookList", list.body);
    expect(list.body).toEqual({ items: [] });
    const m = await get(membershipsPath(STORE_A_X), SES_OWNER_ALL);
    expectStatus(m, 200);
    expectValid("StorePriceZoneMemberships", m.body);
    expect(m.body).toEqual({ storeId: STORE_A_X, priceBookId: null, defaultZoneId: null, asOfRevision: null, items: [] });
  });

  it("refuses a Book create from a disallowed role, a bearer, a missing Origin and a missing key", async () => {
    if (skip()) return;
    const body = { code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "inclusive" };
    for (const s of [SES_MANAGER, SES_STAFF]) {
      const res = await post(BOOKS, s, body);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject(NOT_FOUND);
    }
    const bearer = await request(app!.getHttpServer())
      .post(BOOKS)
      .set("Origin", ORIGIN)
      .set("Authorization", `Bearer ${DASHBOARD_TOKEN}`)
      .set("Idempotency-Key", key())
      .send(body);
    expect(bearer.status).toBe(401);
    // The header stand-in skips the real guard, so the Origin check is proven with a cookie.
    const noOrigin = await request(app!.getHttpServer())
      .post(BOOKS)
      .set("Cookie", "dp2_session=rt1484-not-a-session")
      .set("Idempotency-Key", key())
      .send(body);
    refused(noOrigin, 403, "origin_rejected");
    const noKey = await post(BOOKS, SES_OWNER_ALL, body, null);
    expect(noKey.status).toBe(400);
    const badCurrency = await post(BOOKS, SES_OWNER_ALL, { ...body, currencyCode: "XXX" });
    refused(badCurrency, 400, "validation_error");
    expect(await countAll("price_books", TENANT_A)).toBe(0);
  });

  it("creates the Book with its default Zone and one audit row, and replays it on the same key", async () => {
    if (skip()) return;
    const body = { code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "inclusive", defaultZoneName: "Main" };
    const k = key();
    const res = await post(BOOKS, SES_OWNER_ALL, body, k);
    expectStatus(res, 201);
    expectValid("PriceBook", res.body);
    book = res.body as Book;
    expect(res.body).toMatchObject({ code: "RETAIL", currencyCode: "EGP", isDefault: true, retiredAt: null, pricingContext: "retail" });
    expect(book.defaultZone).toMatchObject({ code: "DEFAULT", name: "Main", isDefault: true, priceBookId: book.id });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();

    const replay = await post(BOOKS, SES_OWNER_ALL, body, k);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(res.body);
    const reuse = await post(BOOKS, SES_OWNER_ALL, { ...body, name: "Other" }, k);
    expect(reuse.status).toBe(409);

    expect(await countAll("price_books", TENANT_A)).toBe(1);
    expect(await countAll("price_zones", TENANT_A)).toBe(1);
    const rows = await audits("pricing.price_book.created", book.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ price_book_id: book.id, default_price_zone_id: book.defaultZone.id });
  });

  it("refuses a second retail Book (price_book_exists) for owner and tenant_admin, writing nothing", async () => {
    if (skip()) return;
    for (const s of [SES_OWNER_ALL, SES_ADMIN_SPEC]) {
      const res = await post(BOOKS, s, { code: "SECOND", name: "Second", currencyCode: "EGP", taxPriceBasis: "exclusive" });
      refused(res, 409, "price_book_exists");
    }
    expect(await countAll("price_books", TENANT_A)).toBe(1);
  });

  it("isolates tenants: B sees none of A's structure and may reuse A's Book code", async () => {
    if (skip()) return;
    const list = await get(BOOKS, SES_OWNER_B);
    expectStatus(list, 200);
    expect(list.body).toEqual({ items: [] });
    expect((await get(bookPath(book.id), SES_OWNER_B)).body.error).toMatchObject(NOT_FOUND);
    refused(await post(zonesPath(book.id), SES_OWNER_B, { code: "B", name: "B" }), 404, "not_found");
    refused(await post(retirePath(book.id, book.defaultZone.id), SES_OWNER_B, { reason: "x" }), 404, "not_found");
    refused(await get(zoneStoresPath(book.id, book.defaultZone.id), SES_OWNER_B), 404, "not_found");
    refused(await get(membershipsPath(STORE_A_X), SES_OWNER_B), 404, "not_found");
    const own = await post(BOOKS, SES_OWNER_B, { code: "RETAIL", name: "B retail", currencyCode: "KWD", taxPriceBasis: "exclusive" });
    expectStatus(own, 201);
    const bList = await get(BOOKS, SES_OWNER_B);
    expect((bList.body as { items: Book[] }).items.map((x) => x.id)).toEqual([own.body.id]);
    const aList = await get(BOOKS, SES_OWNER_ALL);
    expect((aList.body as { items: Book[] }).items.map((x) => x.id)).toEqual([book.id]);
    const bDefault = await get(zoneStoresPath(own.body.id, own.body.defaultZone.id), SES_OWNER_B);
    expectStatus(bDefault, 200);
    const bStores = (bDefault.body as StorePage).items.map((i) => i.storeId);
    expect(bStores).toContain(STORE_B_X);
    expect(bStores).not.toContain(STORE_A_X);
  });

  it("creates Zones (tenant_admin), refuses a taken code and a store_manager, and audits each create", async () => {
    if (skip()) return;
    const res = await post(zonesPath(book.id), SES_ADMIN_SPEC, { code: "NORTH", name: "North" });
    expectStatus(res, 201);
    expectValid("PriceZone", res.body);
    north = res.body as Zone;
    expect(north).toMatchObject({ code: "NORTH", isDefault: false, retiredAt: null, priceBookId: book.id });
    east = (await post(zonesPath(book.id), SES_OWNER_ALL, { code: "EAST", name: "East" })).body as Zone;
    refused(await post(zonesPath(book.id), SES_OWNER_ALL, { code: "NORTH", name: "Again" }), 409, "price_zone_code_taken");
    refused(await post(zonesPath(book.id), SES_OWNER_ALL, { code: "DEFAULT", name: "Again" }), 409, "price_zone_code_taken");
    refused(await post(zonesPath(ABSENT), SES_OWNER_ALL, { code: "X", name: "X" }), 404, "not_found");
    refused(await post(zonesPath("not-a-uuid"), SES_OWNER_ALL, { code: "X", name: "X" }), 400, "validation_error");
    expect((await post(zonesPath(book.id), SES_MANAGER, { code: "MGR", name: "Mgr" })).status).toBe(404);
    expect(await audits("pricing.price_zone.created", north.id)).toHaveLength(1);
    expect(await countAll("price_zones", TENANT_A)).toBe(3);
  });

  it("reads the Book with its Zones (default first, then by code), store_manager included", async () => {
    if (skip()) return;
    const res = await get(bookPath(book.id), SES_MANAGER);
    expectStatus(res, 200);
    expectValid("PriceBookDetail", res.body);
    expect((res.body as { zones: Zone[] }).zones.map((z) => z.code)).toEqual(["DEFAULT", "EAST", "NORTH"]);
    expect((await get(bookPath(book.id), SES_STAFF)).status).toBe(404);
    expect((await get(bookPath(ABSENT), SES_OWNER_ALL)).status).toBe(404);
  });

  it("retires an unused Zone once (replayable), never the default Zone", async () => {
    if (skip()) return;
    refused(await post(retirePath(book.id, book.defaultZone.id), SES_OWNER_ALL, { reason: "no" }), 409, "default_price_zone_immutable");
    const south = (await post(zonesPath(book.id), SES_OWNER_ALL, { code: "SOUTH", name: "South" })).body as Zone;
    const k = key();
    const res = await post(retirePath(book.id, south.id), SES_OWNER_ALL, { reason: "merged into north" }, k);
    expectStatus(res, 200);
    expectValid("PriceZone", res.body);
    expect(res.body).toMatchObject({ id: south.id, retireReason: "merged into north" });
    expect(res.body.retiredAt).not.toBeNull();
    const replay = await post(retirePath(book.id, south.id), SES_OWNER_ALL, { reason: "merged into north" }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    refused(await post(retirePath(book.id, south.id), SES_OWNER_ALL, { reason: "again" }), 409, "price_zone_retired");
    // A Zone of another Book (here: the zone id under an absent Book) is the 404.
    refused(await post(retirePath(ABSENT, north.id), SES_OWNER_ALL, { reason: "x" }), 404, "not_found");
    const rows = await audits("pricing.price_zone.retired", south.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("merged");
  });

  it("refuses to retire a Zone in use by an active membership or an open Change Set line", async () => {
    if (skip()) return;
    seeded = await seedPublishedStructure(book.id, north.id, east.id);
    refused(await post(retirePath(book.id, north.id), SES_OWNER_ALL, { reason: "x" }), 409, "price_zone_in_use");
    refused(await post(retirePath(book.id, east.id), SES_OWNER_ALL, { reason: "x" }), 409, "price_zone_in_use");
    const r = await env!.admin.query(`SELECT count(*)::int AS n FROM price_zones WHERE id = ANY($1) AND retired_at IS NOT NULL`, [
      [north.id, east.id],
    ]);
    expect(r.rows[0].n).toBe(0);
  });

  it("lists a Zone's Stores at an instant and a revision", async () => {
    if (skip()) return;
    const now = await get(zoneStoresPath(book.id, north.id), SES_OWNER_ALL);
    expectStatus(now, 200);
    expectValid("PriceZoneStorePage", now.body);
    expect(now.body).toMatchObject({ zoneId: north.id, asOfRevision: 2, nextCursor: null });
    expect((now.body as StorePage).items).toEqual([{ storeId: STORE_A_X, membership: "explicit", membershipId: seeded.mX }]);

    const later = await get(`${zoneStoresPath(book.id, north.id)}?at=2030-06-01T00:00:00Z`, SES_OWNER_ALL);
    expectStatus(later, 200);
    expect((later.body as StorePage).evaluatedAt).toBe("2030-06-01T00:00:00.000000Z");
    expect((later.body as StorePage).items.map((i) => i.storeId).sort()).toEqual([STORE_A_X, STORE_A_Y].sort());

    const atRev1 = await get(`${zoneStoresPath(book.id, north.id)}?at=2030-06-01T02:00:00%2B02:00&as_of_revision=1`, SES_OWNER_ALL);
    expectStatus(atRev1, 200);
    expect((atRev1.body as StorePage).asOfRevision).toBe(1);
    expect((atRev1.body as StorePage).items.map((i) => i.storeId)).toEqual([STORE_A_X]);

    refused(await get(`${zoneStoresPath(book.id, north.id)}?as_of_revision=3`, SES_OWNER_ALL), 422, "pricing_revision_unknown");
    refused(await get(`${zoneStoresPath(book.id, north.id)}?at=2026-02-31T00:00:00Z`, SES_OWNER_ALL), 400, "validation_error");
    refused(await get(zoneStoresPath(book.id, ABSENT), SES_OWNER_ALL), 404, "not_found");

    const def = await get(zoneStoresPath(book.id, book.defaultZone.id), SES_OWNER_ALL);
    const defIds = (def.body as StorePage).items.map((i) => i.storeId);
    expect(defIds).toContain(STORE_A_Y);
    expect(defIds).not.toContain(STORE_A_X);
    expect(defIds).not.toContain(S_DELETED);
    expect((def.body as StorePage).items.every((i) => i.membership === "default" && i.membershipId === null)).toBe(true);
  });

  it("pages the default Zone with a cursor that fixes the evaluation", async () => {
    if (skip()) return;
    const full = (await get(zoneStoresPath(book.id, book.defaultZone.id), SES_OWNER_ALL)).body as StorePage;
    const seen: string[] = [];
    let url = `${zoneStoresPath(book.id, book.defaultZone.id)}?page_size=1`;
    let first: StorePage | null = null;
    for (let i = 0; i < 50; i += 1) {
      const res = await get(url, SES_OWNER_ALL);
      expectStatus(res, 200);
      expectValid("PriceZoneStorePage", res.body);
      const page = res.body as StorePage;
      first ??= page;
      expect(page.evaluatedAt).toBe(first.evaluatedAt);
      seen.push(...page.items.map((x) => x.storeId));
      if (page.nextCursor === null) break;
      url = `${zoneStoresPath(book.id, book.defaultZone.id)}?page_size=1&cursor=${page.nextCursor}`;
    }
    expect(seen).toEqual(full.items.map((x) => x.storeId));
    const cursor = first!.nextCursor!;
    refused(
      await get(`${zoneStoresPath(book.id, book.defaultZone.id)}?cursor=${cursor}&as_of_revision=1`, SES_OWNER_ALL),
      400,
      "validation_error",
    );
    refused(await get(`${zoneStoresPath(book.id, north.id)}?cursor=${cursor}`, SES_OWNER_ALL), 400, "validation_error");
    refused(await get(`${zoneStoresPath(book.id, north.id)}?cursor=bm90LWpzb24`, SES_OWNER_ALL), 400, "validation_error");
  });

  it("bounds the reads by the caller's store scope", async () => {
    if (skip()) return;
    // tenant_admin with a `specific` grant of STORE_A_X only.
    const def = await get(`${zoneStoresPath(book.id, north.id)}?at=2030-06-01T00:00:00Z`, SES_ADMIN_SPEC);
    expectStatus(def, 200);
    expect((def.body as StorePage).items.map((i) => i.storeId)).toEqual([STORE_A_X]);
    refused(await get(membershipsPath(STORE_A_Y), SES_ADMIN_SPEC), 404, "not_found");
    expectStatus(await get(membershipsPath(STORE_A_Y), SES_MANAGER), 200);
    refused(await get(membershipsPath(S_DELETED), SES_OWNER_ALL), 404, "not_found");
    refused(await get(membershipsPath(ABSENT), SES_OWNER_ALL), 404, "not_found");
    expect((await get(membershipsPath(STORE_A_X), SES_STAFF)).status).toBe(404);
  });

  it("reads a Store's membership timeline as known at a revision", async () => {
    if (skip()) return;
    const x = await get(membershipsPath(STORE_A_X), SES_OWNER_ALL);
    expectStatus(x, 200);
    expectValid("StorePriceZoneMemberships", x.body);
    expect(x.body).toEqual({
      storeId: STORE_A_X,
      priceBookId: book.id,
      defaultZoneId: book.defaultZone.id,
      asOfRevision: 2,
      items: [
        {
          id: seeded.mX,
          priceZoneId: north.id,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveTo: null,
          publishedInRevision: 1,
          carriedForward: false,
        },
      ],
    });
    const yAt1 = await get(`${membershipsPath(STORE_A_Y)}?as_of_revision=1`, SES_OWNER_ALL);
    expect((yAt1.body as { items: unknown[] }).items).toEqual([]);
    const yHead = await get(membershipsPath(STORE_A_Y), SES_OWNER_ALL);
    expect((yHead.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([seeded.mY]);
    refused(await get(`${membershipsPath(STORE_A_X)}?as_of_revision=9`, SES_OWNER_ALL), 422, "pricing_revision_unknown");
    refused(await get(membershipsPath("nope"), SES_OWNER_ALL), 400, "validation_error");
  });
});
