/**
 * RT-1484 (RT-282 PR-08b) — price inquiry over HTTP against real Postgres (Testcontainers, every
 * migration including 0121 and 0123, the NOBYPASSRLS `app_test` pool holding only the production
 * pricing grants of `pricing.grants.ts` and `price-change-set-content.grants.ts`) and the real
 * module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`). Only cookie
 * authentication is faked.
 *
 * Published pricing is seeded by the superuser with triggers off (the publish runtime is a later
 * RT-1484 slice). Tenant A, Book RETAIL (EGP, inclusive), Zones DEFAULT and NORTH:
 *
 *   rev 1  book  P1 100.0000 from 2026-01-01Z (open)            ended by rev 3
 *          membership STORE_A_Y → NORTH from 2028-01-01Z        ended by rev 3
 *   rev 2  zone NORTH P1 90.0000 from 2026-01-01Z; membership STORE_A_X → NORTH from 2026-01-01Z
 *          store STORE_A_X P1 80.0000 [2026-03-01Z, 2026-04-01Z)
 *          book P2 60.0000 [2026-01-01Z, 2027-01-01Z); book P2 10.0050 [2027-01-01Z, 2027-02-01Z)
 *          store STORE_A_Y P2 50.0000 store_local from 2026-03-08T02:30 (America/New_York: DST gap)
 *          store STORE_A_X P2 absolute [2027-03-01Z, 2027-04-01Z) and store_local
 *            [2027-03-15T00:00, 2027-05-01T00:00) — an overlap the per-basis EXCLUDEs cannot see
 *          membership STORE_A_Y → DEFAULT from 2028-01-01Z (overlaps the rev-1 one until rev 3)
 *   rev 3  book P1 100.0000 [2026-01-01Z, 2026-06-01Z) and 110.0000 from 2026-06-01Z
 *
 * What this proves (`pricing/price-inquiry.yaml` 1.0.0-draft): roles and the non-disclosing 404
 * (another tenant, out of store scope, deleted Store, absent ids); store scope for tenant_admin
 * and store_manager; precedence Store > Zone > Book end to end; `as_of_revision` against the
 * head; 422 for an unknown revision; `no_price`, `no_price_book`, `not_representable`,
 * `overlap_violation` and `ambiguous_zone_membership`; a DST instant; timeline segments over a
 * window and its 366-day bound; the explain layers and next change; RLS isolation of two tenants;
 * no legacy fallback. Every 200 body validates against the contract schemas (AJV).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool, PoolClient } from "pg";
import request from "supertest";

import type { GrantFragment } from "../../src/auth/grant-fragment";
import { GRANTS as CONTENT_GRANTS } from "../../src/auth/grants/price-change-set-content.grants";
import { GRANTS as PRICING_GRANTS } from "../../src/auth/grants/pricing.grants";
import { PriceInquiryModule } from "../../src/pricing/inquiry/price-inquiry.module";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../catalog/__support__/isolation-harness";
import { bootScopedApp, S_DELETED, SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { DASHBOARD_TOKEN, SES_MANAGER, SES_STAFF, seedConsoleSalesFixture } from "../console-sales/__support__/console-sales-fixture";

const CONTRACT = "price-inquiry";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const P1 = PRODUCT_A_ACTIVE;
const P2 = PRODUCT_A_RETIRED;

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("1484e3");
const ABSENT = a("1484fe");
const SES_OWNER_B = b("1484a3");
const SES_MANAGER_X = a("1484a4");

const BOOK = a("14b001");
const ZONE_DEFAULT = a("14b0d0");
const ZONE_NORTH = a("14b0d1");
const CS = [a("14c501"), a("14c502"), a("14c503")] as const;
const E = {
  bookP1v1: a("14e101"),
  zoneP1: a("14e102"),
  storeXP1: a("14e103"),
  bookP2: a("14e104"),
  bookP2Odd: a("14e105"),
  storeYP2Local: a("14e106"),
  storeXP2Abs: a("14e107"),
  storeXP2Local: a("14e108"),
  bookP1v3a: a("14e109"),
  bookP1v3b: a("14e10a"),
} as const;
const M = { xNorth: a("14f101"), yNorthOld: a("14f102"), yDefault: a("14f103") } as const;
const B_BOOK = b("14b001");
const B_ZONE = b("14b0d0");
const B_CS = b("14c501");
const B_EVENT = b("14e101");

const pricePath = (store: string, product: string, query = ""): string =>
  `/api/v1/pricing/stores/${store}/products/${product}/price${query}`;
const timelinePath = (store: string, product: string, query: string): string =>
  `/api/v1/pricing/stores/${store}/products/${product}/timeline${query}`;
const explainPath = (store: string, product: string, query = ""): string =>
  `/api/v1/pricing/stores/${store}/products/${product}/explain${query}`;

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

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

/** Runs `fn` as the superuser in one transaction with triggers off (seeding published history). */
async function asSeeder(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await env!.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await fn(c);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

async function seedBook(c: PoolClient, tenant: string, book: string, zones: ReadonlyArray<[string, string, boolean]>, currency: string) {
  await c.query(
    `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'RETAIL', 'Retail', $3, 'inclusive', $4, $1)`,
    [book, tenant, currency, ACTOR],
  );
  for (const [id, code, isDefault] of zones) {
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $1)`,
      [id, tenant, book, code, isDefault, ACTOR],
    );
  }
}

async function seedRevision(c: PoolClient, tenant: string, n: number, cs: string): Promise<void> {
  const legacy = n === 1;
  const hash = `sha256:${"a".repeat(64)}`;
  await c.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, revision_no, created_by_user_id, correlation_id,
                              published_by_user_id, published_at, validated_at_revision, preview_hash,
                              target_store_set_hash, sensitive, approved_by_user_id, approved_at)
     VALUES ($1, $2, 'pricing', $5, 'seed', 'published', $3, $4, $1, $4, now(), $6, $7, $7, $8, $9, $10)`,
    [cs, tenant, n, ACTOR, legacy ? "legacy_import" : "standard", legacy ? null : n - 1, legacy ? null : hash,
      legacy ? null : false, legacy ? null : ACTOR, legacy ? null : new Date()],
  );
  await c.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $5, $4, $3)`,
    [tenant, n, cs, ACTOR, legacy ? "legacy_import" : "publish"],
  );
}

interface EventSeed {
  readonly id: string;
  readonly scope: "book" | "zone" | "store";
  readonly product: string;
  readonly price: string;
  readonly rev: number;
  readonly ended?: number;
  readonly zone?: string;
  readonly store?: string;
  readonly from?: string;
  readonly to?: string;
  readonly fromLocal?: string;
  readonly toLocal?: string;
}

async function seedEvent(c: PoolClient, tenant: string, book: string, cs: string, e: EventSeed, currency = "EGP") {
  const local = e.fromLocal !== undefined;
  await c.query(
    `INSERT INTO price_events
       (id, tenant_id, price_book_id, scope, price_zone_id, store_id, product_id, price, currency_code, time_basis,
        effective_from, effective_to, effective_from_local, effective_to_local, state, published_in_revision,
        ended_in_revision, change_set_id, source, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'change_set', $19, $1)`,
    [e.id, tenant, book, e.scope, e.zone ?? null, e.store ?? null, e.product, e.price, currency, local ? "store_local" : "absolute",
      local ? null : e.from, local ? null : (e.to ?? null), local ? e.fromLocal : null, local ? (e.toLocal ?? null) : null,
      e.ended === undefined ? "active" : "superseded", e.rev, e.ended ?? null, cs, ACTOR],
  );
}

async function seedMembership(c: PoolClient, m: { id: string; zone: string; store: string; from: string; rev: number; ended?: number }) {
  await c.query(
    `INSERT INTO price_zone_memberships
       (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, state, published_in_revision, ended_in_revision,
        created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $1)`,
    [m.id, TENANT_A, BOOK, m.zone, m.store, m.from, m.ended === undefined ? "active" : "superseded", m.rev, m.ended ?? null, ACTOR],
  );
}

async function seedTenantA(): Promise<void> {
  // STORE_A_X reads in UTC (the fixture sets Cairo for its sales); STORE_A_Y in New York for DST.
  await env!.admin.query(`UPDATE stores SET timezone = 'UTC' WHERE id = $1`, [STORE_A_X]);
  await env!.admin.query(`UPDATE stores SET timezone = 'America/New_York' WHERE id = $1`, [STORE_A_Y]);
  await asSeeder(async (c) => {
    await seedBook(c, TENANT_A, BOOK, [[ZONE_DEFAULT, "DEFAULT", true], [ZONE_NORTH, "NORTH", false]], "EGP");
    for (const [i, cs] of CS.entries()) await seedRevision(c, TENANT_A, i + 1, cs);
    const seed = (rev: number, e: EventSeed) => seedEvent(c, TENANT_A, BOOK, CS[rev - 1]!, e);
    await seed(1, { id: E.bookP1v1, scope: "book", product: P1, price: "100.0000", rev: 1, ended: 3, from: "2026-01-01T00:00:00Z" });
    await seed(2, { id: E.zoneP1, scope: "zone", zone: ZONE_NORTH, product: P1, price: "90.0000", rev: 2, from: "2026-01-01T00:00:00Z" });
    await seed(2, {
      id: E.storeXP1, scope: "store", store: STORE_A_X, product: P1, price: "80.0000", rev: 2,
      from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z",
    });
    await seed(2, { id: E.bookP2, scope: "book", product: P2, price: "60.0000", rev: 2, from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
    await seed(2, { id: E.bookP2Odd, scope: "book", product: P2, price: "10.0050", rev: 2, from: "2027-01-01T00:00:00Z", to: "2027-02-01T00:00:00Z" });
    await seed(2, { id: E.storeYP2Local, scope: "store", store: STORE_A_Y, product: P2, price: "50.0000", rev: 2, fromLocal: "2026-03-08T02:30:00" });
    await seed(2, {
      id: E.storeXP2Abs, scope: "store", store: STORE_A_X, product: P2, price: "40.0000", rev: 2,
      from: "2027-03-01T00:00:00Z", to: "2027-04-01T00:00:00Z",
    });
    await seed(2, {
      id: E.storeXP2Local, scope: "store", store: STORE_A_X, product: P2, price: "41.0000", rev: 2,
      fromLocal: "2027-03-15T00:00:00", toLocal: "2027-05-01T00:00:00",
    });
    await seed(3, { id: E.bookP1v3a, scope: "book", product: P1, price: "100.0000", rev: 3, from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" });
    await seed(3, { id: E.bookP1v3b, scope: "book", product: P1, price: "110.0000", rev: 3, from: "2026-06-01T00:00:00Z" });
    await seedMembership(c, { id: M.xNorth, zone: ZONE_NORTH, store: STORE_A_X, from: "2026-01-01T00:00:00Z", rev: 2 });
    await seedMembership(c, { id: M.yNorthOld, zone: ZONE_NORTH, store: STORE_A_Y, from: "2028-01-01T00:00:00Z", rev: 1, ended: 3 });
    await seedMembership(c, { id: M.yDefault, zone: ZONE_DEFAULT, store: STORE_A_Y, from: "2028-01-01T00:00:00Z", rev: 2 });
  });
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
      console.warn(`\n[RT-1484 price inquiry] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-inquiry-actor@example.test')`, [ACTOR]);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-inquiry-actor-b@example.test')`, [b("1484e3")]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("1484b3"),
    email: "rt1484-inquiry-owner-b@example.test",
    membershipId: b("1484c3"),
    roleId: b("1484d3"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_A,
    userId: a("1484b4"),
    email: "rt1484-inquiry-manager-x@example.test",
    membershipId: a("1484c4"),
    roleId: a("1484d4"),
    roleCode: "store_manager",
    stores: [STORE_A_X],
    sessions: { [SES_MANAGER_X]: null },
  });
  await seedTenantA();
  app = await bootScopedApp(env, PriceInquiryModule, undefined, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1484 price inquiry] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string | null = SES_OWNER_ALL): request.Test {
  const req = request(app!.getHttpServer()).get(path);
  return session === null ? req : req.set("x-test-session", session);
}

/** A 200 whose body validates against `name`, with `Cache-Control: no-store`. */
async function ok<T = Record<string, unknown>>(path: string, name: string, session: string | null = SES_OWNER_ALL): Promise<T> {
  const res = await get(path, session);
  if (res.status !== 200) throw new Error(`expected 200 for ${path}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  const v = schema(name);
  if (!v(res.body)) throw new Error(`${name} contract violation: ${JSON.stringify(v.errors)} in ${JSON.stringify(res.body)}`);
  return res.body as T;
}

async function refused(path: string, status: number, code: string, session: string | null = SES_OWNER_ALL): Promise<void> {
  const res = await get(path, session);
  if (res.status !== status) throw new Error(`expected ${status} for ${path}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

type Result = { status: string; reason?: string; price?: string; provenance?: Record<string, unknown>; eventIds?: string[]; membershipIds?: string[] };
const at = (iso: string): string => `?at=${encodeURIComponent(iso)}`;
const resultOf = async (store: string, product: string, query: string): Promise<Result> =>
  (await ok<{ result: Result }>(pricePath(store, product, query), "PriceInquiry")).result;

describe("RT-1484 price inquiry over HTTP", () => {
  it("resolves Store > Zone > Book end to end, with provenance at the head revision", async () => {
    if (skip()) return;
    const body = await ok<{ asOfRevision: number; storeTimeZone: string; evaluatedAt: string; result: Result }>(
      pricePath(STORE_A_X, P1, at("2026-03-15T10:00:00Z")),
      "PriceInquiry",
    );
    expect(body).toMatchObject({ storeId: STORE_A_X, productId: P1, sellUnit: "each", asOfRevision: 3, storeTimeZone: "UTC" });
    expect(body.evaluatedAt).toBe("2026-03-15T10:00:00Z");
    expect(body.result).toEqual({
      status: "priced",
      price: "80.0000",
      currencyCode: "EGP",
      taxPriceBasis: "inclusive",
      sellUnit: "each",
      provenance: {
        origin: "pricing",
        sourceScope: "store",
        priceEventId: E.storeXP1,
        priceKind: "regular",
        pricingRevision: 3,
        priceBookId: BOOK,
        priceZoneId: null,
        effectiveFrom: "2026-03-01T00:00:00Z",
        effectiveTo: "2026-04-01T00:00:00Z",
      },
    });
    // After the Store override ends, the Store's explicit Zone (NORTH) wins over the Book.
    const zone = await resultOf(STORE_A_X, P1, at("2026-04-15T00:00:00Z"));
    expect(zone).toMatchObject({ status: "priced", price: "90.0000", provenance: { sourceScope: "zone", priceZoneId: ZONE_NORTH } });
    // STORE_A_Y has no membership then: the default Zone holds nothing, so the Book applies.
    const bookPrice = await resultOf(STORE_A_Y, P1, at("2026-04-15T00:00:00Z"));
    expect(bookPrice).toMatchObject({ status: "priced", price: "100.0000", provenance: { sourceScope: "book", priceEventId: E.bookP1v3a } });
  });

  it("answers as known at as_of_revision, and 422 above the head", async () => {
    if (skip()) return;
    const head = await resultOf(STORE_A_Y, P1, at("2026-07-01T00:00:00Z"));
    expect(head).toMatchObject({ price: "110.0000", provenance: { priceEventId: E.bookP1v3b, pricingRevision: 3 } });
    const rev2 = await ok<{ asOfRevision: number; result: Result }>(
      pricePath(STORE_A_Y, P1, `${at("2026-07-01T00:00:00Z")}&as_of_revision=2`),
      "PriceInquiry",
    );
    expect(rev2.asOfRevision).toBe(2);
    expect(rev2.result).toMatchObject({ price: "100.0000", provenance: { priceEventId: E.bookP1v1, pricingRevision: 2 } });
    const rev1X = await resultOf(STORE_A_X, P1, `${at("2026-03-15T00:00:00Z")}&as_of_revision=1`);
    expect(rev1X).toMatchObject({ price: "100.0000", provenance: { sourceScope: "book" } });
    await refused(pricePath(STORE_A_X, P1, "?as_of_revision=4"), 422, "pricing_revision_unknown");
    await refused(explainPath(STORE_A_X, P1, "?as_of_revision=4"), 422, "pricing_revision_unknown");
    await refused(timelinePath(STORE_A_X, P1, "?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&as_of_revision=4"), 422, "pricing_revision_unknown");
  });

  it("reports no_price, not_representable, overlap_violation and ambiguous_zone_membership", async () => {
    if (skip()) return;
    expect(await resultOf(STORE_A_X, P2, at("2025-06-01T00:00:00Z"))).toEqual({ status: "unpriced", reason: "no_price" });
    expect(await resultOf(STORE_A_X, P2, at("2027-01-15T00:00:00Z"))).toEqual({ status: "unpriced", reason: "not_representable" });
    expect(await resultOf(STORE_A_X, P2, at("2027-03-20T00:00:00Z"))).toEqual({
      status: "error",
      reason: "overlap_violation",
      eventIds: [E.storeXP2Abs, E.storeXP2Local].sort(),
    });
    const ambiguous = await resultOf(STORE_A_Y, P1, `${at("2028-06-01T00:00:00Z")}&as_of_revision=2`);
    expect(ambiguous).toEqual({ status: "error", reason: "ambiguous_zone_membership", membershipIds: [M.yNorthOld, M.yDefault].sort() });
    // At the head the old membership is ended: the explicit default membership leaves the Book price.
    expect(await resultOf(STORE_A_Y, P1, at("2028-06-01T00:00:00Z"))).toMatchObject({ status: "priced", price: "110.0000" });
  });

  it("applies a store_local start in the Store's zone across the DST gap", async () => {
    if (skip()) return;
    // 2026-03-08T02:30 does not exist in New York: the event starts at the transition, 07:00Z.
    const before = await ok<{ evaluatedAt: string; storeTimeZone: string; result: Result }>(
      pricePath(STORE_A_Y, P2, at("2026-03-08T06:59:59Z")),
      "PriceInquiry",
    );
    expect(before.storeTimeZone).toBe("America/New_York");
    expect(before.evaluatedAt).toBe("2026-03-08T01:59:59-05:00");
    expect(before.result).toMatchObject({ price: "60.0000", provenance: { sourceScope: "book" } });
    const after = await resultOf(STORE_A_Y, P2, at("2026-03-08T03:00:00-04:00"));
    expect(after).toMatchObject({
      price: "50.0000",
      provenance: { sourceScope: "store", priceEventId: E.storeYP2Local, effectiveFrom: "2026-03-08T03:00:00-04:00", effectiveTo: null },
    });
  });

  it("returns the timeline as contiguous segments over the window, merged and as known at a revision", async () => {
    if (skip()) return;
    type Timeline = { from: string; to: string; asOfRevision: number; segments: { from: string; to: string; result: Result }[] };
    const x = await ok<Timeline>(timelinePath(STORE_A_X, P1, "?from=2026-02-01T00:00:00Z&to=2026-08-01T00:00:00Z"), "PriceTimeline");
    expect(x.segments.map((s) => [s.from, s.to, s.result.price])).toEqual([
      ["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z", "90.0000"],
      ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "80.0000"],
      // The Book change at 06-01 is shadowed by the Zone price: one segment.
      ["2026-04-01T00:00:00Z", "2026-08-01T00:00:00Z", "90.0000"],
    ]);
    const y = await ok<Timeline>(timelinePath(STORE_A_Y, P1, "?from=2025-12-01T00:00:00Z&to=2026-08-01T00:00:00Z"), "PriceTimeline");
    expect(y.from).toBe("2025-11-30T19:00:00-05:00");
    expect(y.segments.map((s) => [s.from, s.result.status, s.result.price ?? s.result.reason])).toEqual([
      ["2025-11-30T19:00:00-05:00", "unpriced", "no_price"],
      ["2025-12-31T19:00:00-05:00", "priced", "100.0000"],
      ["2026-05-31T20:00:00-04:00", "priced", "110.0000"],
    ]);
    expect(y.segments.at(-1)!.to).toBe(y.to);
    const yRev2 = await ok<Timeline>(
      timelinePath(STORE_A_Y, P1, "?from=2026-02-01T00:00:00Z&to=2026-08-01T00:00:00Z&as_of_revision=2"),
      "PriceTimeline",
    );
    expect(yRev2.asOfRevision).toBe(2);
    expect(yRev2.segments.map((s) => s.result.price)).toEqual(["100.0000"]);
    // A long window crossing every kind of segment stays ordered and contiguous.
    const long = await ok<Timeline>(timelinePath(STORE_A_X, P2, "?from=2026-06-01T00:00:00Z&to=2027-06-01T00:00:00Z"), "PriceTimeline");
    expect(long.segments.map((s) => s.result.status + ":" + (s.result.price ?? s.result.reason))).toEqual([
      "priced:60.0000",
      "unpriced:not_representable",
      "unpriced:no_price",
      "priced:40.0000",
      "error:overlap_violation",
      "priced:41.0000",
      "unpriced:no_price",
    ]);
    for (const [i, s] of long.segments.entries()) if (i > 0) expect(s.from).toBe(long.segments[i - 1]!.to);
  });

  it("refuses a malformed or too-long timeline window before any read", async () => {
    if (skip()) return;
    await refused(timelinePath(STORE_A_X, P1, "?from=2026-01-01T00:00:00Z"), 400, "validation_error");
    await refused(timelinePath(STORE_A_X, P1, "?from=2026-02-01T00:00:00Z&to=2026-02-01T00:00:00Z"), 400, "validation_error");
    await refused(timelinePath(STORE_A_X, P1, "?from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:00.001Z"), 400, "validation_error");
    await ok(timelinePath(STORE_A_X, P1, "?from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:00Z"), "PriceTimeline");
  });

  it("explains the price: the selected layer, what it shadows, and the next change", async () => {
    if (skip()) return;
    const body = await ok<Record<string, unknown>>(explainPath(STORE_A_X, P1, at("2026-03-15T00:00:00Z")), "PriceExplanation");
    expect(body["layers"]).toEqual([
      {
        scope: "store",
        outcome: "selected",
        priceEventId: E.storeXP1,
        price: "80.0000",
        effectiveFrom: "2026-03-01T00:00:00Z",
        effectiveTo: "2026-04-01T00:00:00Z",
        publishedInRevision: 2,
        changeSetId: CS[1],
      },
      {
        scope: "zone",
        outcome: "shadowed",
        priceZoneId: ZONE_NORTH,
        zoneMembership: "explicit",
        priceEventId: E.zoneP1,
        price: "90.0000",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveTo: null,
        publishedInRevision: 2,
        changeSetId: CS[1],
      },
      {
        scope: "book",
        outcome: "shadowed",
        priceEventId: E.bookP1v3a,
        price: "100.0000",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveTo: "2026-06-01T00:00:00Z",
        publishedInRevision: 3,
        changeSetId: CS[2],
      },
    ]);
    expect(body["next"]).toMatchObject({ at: "2026-04-01T00:00:00Z", result: { price: "90.0000", provenance: { sourceScope: "zone" } } });

    const ambiguous = await ok<{ layers: unknown[]; next: unknown }>(
      explainPath(STORE_A_Y, P1, `${at("2028-06-01T00:00:00Z")}&as_of_revision=2`),
      "PriceExplanation",
    );
    expect(ambiguous.layers).toEqual([
      { scope: "store", outcome: "none" },
      { scope: "zone", outcome: "conflict", priceZoneId: null, zoneMembership: "ambiguous" },
      { scope: "book", outcome: "none" },
    ]);
    expect(ambiguous.next).toBeNull();
    const defaulted = await ok<{ layers: { outcome: string; zoneMembership?: string; priceZoneId?: string }[] }>(
      explainPath(STORE_A_Y, P1, at("2026-04-15T00:00:00Z")),
      "PriceExplanation",
    );
    expect(defaulted.layers[1]).toEqual({ scope: "zone", outcome: "none", priceZoneId: ZONE_DEFAULT, zoneMembership: "default" });
    expect(defaulted.layers[2]!.outcome).toBe("selected");
  });

  it("resolves the current price without `at` and never falls back to the legacy catalogue price", async () => {
    if (skip()) return;
    const now = await ok<{ evaluatedAt: string; result: Result }>(pricePath(STORE_A_X, P1), "PriceInquiry");
    expect(Number.isNaN(Date.parse(now.evaluatedAt))).toBe(false);
    // P2 has a legacy default_price in the fixture, yet before any Pricing event it is unpriced.
    const legacy = await env!.admin.query(`SELECT default_price FROM tenant_products WHERE id = $1`, [P2]);
    expect(legacy.rows[0]).toBeDefined();
    expect(await resultOf(STORE_A_Y, P2, at("2025-01-01T00:00:00Z"))).toEqual({ status: "unpriced", reason: "no_price" });
  });

  it("bounds every read by role and store scope with the non-disclosing 404", async () => {
    if (skip()) return;
    const q = at("2026-03-15T00:00:00Z");
    // tenant_admin with a `specific` grant of STORE_A_X; a store_manager of STORE_A_X only.
    for (const session of [SES_ADMIN_SPEC, SES_MANAGER_X]) {
      await ok(pricePath(STORE_A_X, P1, q), "PriceInquiry", session);
      await refused(pricePath(STORE_A_Y, P1, q), 404, "not_found", session);
      await refused(explainPath(STORE_A_Y, P1, q), 404, "not_found", session);
      await refused(timelinePath(STORE_A_Y, P1, "?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"), 404, "not_found", session);
    }
    await ok(pricePath(STORE_A_Y, P1, q), "PriceInquiry", SES_MANAGER);
    const staff = await get(pricePath(STORE_A_X, P1, q), SES_STAFF);
    expect(staff.status).toBe(404);
    expect(staff.body.error).toMatchObject(NOT_FOUND);
    const bearer = await request(app!.getHttpServer()).get(pricePath(STORE_A_X, P1, q)).set("Authorization", `Bearer ${DASHBOARD_TOKEN}`);
    expect(bearer.status).toBe(401);
    await refused(pricePath(S_DELETED, P1, q), 404, "not_found");
    await refused(pricePath(ABSENT, P1, q), 404, "not_found");
    await refused(pricePath(STORE_A_X, ABSENT, q), 404, "not_found");
    await refused(pricePath("not-a-uuid", P1, q), 400, "validation_error");
    await refused(pricePath(STORE_A_X, "nope", q), 400, "validation_error");
    await refused(pricePath(STORE_A_X, P1, "?sell_unit=case"), 400, "validation_error");
    await refused(pricePath(STORE_A_X, P1, "?at=2026-03-15T00:00:00"), 400, "validation_error");
    await refused(pricePath(STORE_A_X, P1, "?as_of_revision=0"), 400, "validation_error");
    await refused(pricePath(STORE_A_X, P1, "?store_id=x"), 400, "validation_error");
  });

  it("isolates tenants: no Book is no_price_book, and neither tenant reads the other's Stores, products or prices", async () => {
    if (skip()) return;
    const none = await ok<{ asOfRevision: number | null; result: Result }>(pricePath(STORE_B_X, PRODUCT_B_ACTIVE), "PriceInquiry", SES_OWNER_B);
    expect(none).toMatchObject({ asOfRevision: null, result: { status: "unpriced", reason: "no_price_book" } });
    const noneExplained = await ok<{ layers: unknown[]; next: unknown }>(explainPath(STORE_B_X, PRODUCT_B_ACTIVE), "PriceExplanation", SES_OWNER_B);
    expect(noneExplained.layers).toEqual([
      { scope: "store", outcome: "none" },
      { scope: "zone", outcome: "none", priceZoneId: null, zoneMembership: "default" },
      { scope: "book", outcome: "none" },
    ]);
    await refused(pricePath(STORE_B_X, PRODUCT_B_ACTIVE, "?as_of_revision=1"), 422, "pricing_revision_unknown", SES_OWNER_B);

    // Tenant B publishes its own Book price; each tenant still sees only its own.
    await asSeeder(async (c) => {
      await seedBook(c, TENANT_B, B_BOOK, [[B_ZONE, "DEFAULT", true]], "KWD");
      await seedRevision(c, TENANT_B, 1, B_CS);
      await seedEvent(c, TENANT_B, B_BOOK, B_CS, {
        id: B_EVENT, scope: "book", product: PRODUCT_B_ACTIVE, price: "7.7770", rev: 1, from: "2026-01-01T00:00:00Z",
      }, "KWD");
    });
    expect(
      (await ok<{ result: Result }>(pricePath(STORE_B_X, PRODUCT_B_ACTIVE, at("2026-03-15T00:00:00Z")), "PriceInquiry", SES_OWNER_B)).result,
    ).toMatchObject({ status: "priced", price: "7.7770", currencyCode: "KWD", provenance: { priceBookId: B_BOOK, pricingRevision: 1 } });
    for (const path of [pricePath(STORE_A_X, P1), explainPath(STORE_A_X, P1), pricePath(STORE_B_X, P1)]) {
      await refused(path, 404, "not_found", SES_OWNER_B);
    }
    await refused(pricePath(STORE_B_X, PRODUCT_B_ACTIVE), 404, "not_found");
    await refused(pricePath(STORE_A_X, PRODUCT_B_ACTIVE), 404, "not_found");
    // A's head is unchanged by B's publish.
    expect((await ok<{ asOfRevision: number }>(pricePath(STORE_A_X, P1), "PriceInquiry")).asOfRevision).toBe(3);
  });
});
