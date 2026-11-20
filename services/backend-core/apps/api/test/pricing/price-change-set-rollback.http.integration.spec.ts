/**
 * RT-1484 PR-6 (RT-282 PR-10c) — Price Change Set rollback over HTTP against real Postgres
 * (Testcontainers, every migration including 0121 and 0123, the NOBYPASSRLS `app_test` pool holding
 * only the production pricing grants) and the real module graph (`SessionOnlyAdminGuard`,
 * `TenantContextGuard`, `RolesGuard`, `PricingAuthoringGuard`, the shared `IdempotencyInterceptor`
 * over a fake Redis). Only cookie authentication is faked. Revision 1 (the tenant's legacy import,
 * no events) is seeded by the superuser; every later revision is written by the runtime under
 * 0121 / 0123's triggers and COMMIT-time checks (deferred, never forced with SET CONSTRAINTS).
 *
 * What this proves (`consoleRollbackPriceChangeSet`; spec 042 §3, §5, §7, §8, §10):
 *   - a rollback is a NEW `kind: rollback` set whose generated items restore the timeline the
 *     target revision superseded from `from` on; it runs validate → submit → approve (four eyes,
 *     always sensitive) → publish, which writes exactly ONE `rollback` revision naming the
 *     target's, ends the target's rows, re-creates the prior prices (or their remainders), records
 *     every line and fans out; the target becomes `rolled_back`; the resolver shows the prior price
 *     after `from`, the target's price before it, and the as-of-revision history unchanged;
 *   - an `end_price` target is undone by a `set_price`, a target that priced an empty interval by
 *     an `end_price`, a Zone move by a move restoring the prior Zone, a `store_local` key from a
 *     wall-clock instant no Store sees before `from`;
 *   - `409 rollback_blocked` (a later revision superseded the target's rows, or priced a key the
 *     target touched) with its blocking revisions, at create and at validate; at publish a blocked
 *     rollback is `stale_validation` (reason `rollback_blocked`); `409 change_set_invalid_state`
 *     for a target that is a draft, superseded, rolled back, the legacy import, or already has a
 *     live rollback; `422 change_set_empty` when nothing differs from `from` on;
 *   - a rollback is exempt from the lead time and the past-dated recheck (it publishes past-dated
 *     lines);
 *   - a rollback publish and a concurrent publish of the same key serialize under the publish lock;
 *   - the allowlist refusal, roles, two-tenant RLS including direct SQL under a mismatched GUC;
 *     idempotent replay; AJV on every body; one audit row per transition.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { runWithTenantContext } from "@data-pulse-2/db";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import type { GrantFragment } from "../../src/auth/grant-fragment";
import { GRANTS as CONTENT_GRANTS } from "../../src/auth/grants/price-change-set-content.grants";
import { GRANTS as PRICING_GRANTS } from "../../src/auth/grants/pricing.grants";
import { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { PRICING_AUTHORING_CONFIG } from "../../src/pricing/change-sets/price-authoring.config";
import { PriceChangeSetsModule } from "../../src/pricing/change-sets/price-change-sets.module";
import { PriceChangeSetsService } from "../../src/pricing/change-sets/price-change-sets.service";
import { loadResolutionData } from "../../src/pricing/inquiry/price-inquiry.repository";
import { resolvePrice } from "../../src/pricing/resolution/resolve";
import { StoresRepository } from "../../src/stores/stores.repository";
import { StoresService } from "../../src/stores/stores.service";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import { APP_ROLE_NAME, applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { bootScopedApp, SES_ADMIN_SPEC, SES_OWNER_ALL, SES_OWNER_SPEC } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SES_MANAGER, seedConsoleSalesFixture } from "../console-sales/__support__/console-sales-fixture";

type Session = string;

const CS = "/api/v1/pricing/change-sets";
const ORIGIN = "http://127.0.0.1";
const CONTRACT = "price-change-sets";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";
const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019202a2";
const SES_OWNER_B = b("16b5a2");
const ACTOR = a("16b5e2");
const BOOK = a("16b5b0");
const ZONE_DEFAULT = a("16b5d0");
const ZONE_NORTH = a("16b5d1");
const CS_LEGACY = a("16b5c1");
const B_BOOK = b("16b5b0");
const B_ZONE = b("16b5d0");
/** One product per case, so each case starts from its own timeline. */
const P = {
  basic: a("16b5f1"),
  empty: a("16b5f2"),
  ended: a("16b5f3"),
  blocked: a("16b5f4"),
  later: a("16b5f5"),
  local: a("16b5f6"),
  race: a("16b5f7"),
  past: a("16b5f8"),
  gate: a("16b5f9"),
  stale: a("16b5fa"),
  nothing: a("16b5fb"),
  superseded: a("16b5fc"),
};

const at = (instant: string) => ({ timeBasis: "absolute", effectiveFrom: instant });
const items = (productIds: string[]) => ({ kind: "items", productIds });
const bookPrice = (product: string, price: string, from: string, to?: string) => ({
  op: "set_price",
  scope: { kind: "book" },
  products: items([product]),
  price,
  ...at(from),
  ...(to === undefined ? {} : { effectiveTo: to }),
});

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

interface Header {
  id: string;
  kind: string;
  state: string;
  version: number;
  previewHash: string | null;
  revisionNo: number | null;
  sensitive: boolean | null;
  sensitivityReasons: string[];
  rollsBackChangeSetId: string | null;
  rolledBackByChangeSetId: string | null;
}
interface ChangeSet {
  header: Header;
  items: Record<string, unknown>[];
  summary: Record<string, unknown> | null;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;
const savedAllowlist = process.env["PRICING_AUTHORING_TENANT_ALLOWLIST"];

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
let schema: (name: string) => ValidateFunction;

/** Production grants only: the fragment's table privileges and UPDATE columns, nothing else. */
async function restrictToPricingGrants(admin: Pool): Promise<void> {
  const statements: string[] = [];
  for (const fragment of [PRICING_GRANTS, CONTENT_GRANTS] as readonly GrantFragment[]) {
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

/** Revision 1: the tenant's legacy import (Book and Zones, no event), seeded with triggers off. */
async function seedPricing(): Promise<void> {
  await env!.admin.query(`UPDATE stores SET timezone = 'UTC' WHERE id = $1`, [STORE_A_X]);
  await env!.admin.query(`UPDATE stores SET timezone = 'America/New_York' WHERE id = $1`, [STORE_A_Y]);
  for (const [name, id] of Object.entries(P)) {
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, $3, 'standard', $4, $4)`,
      [id, TENANT_A, `RT-1484 rollback ${name}`, ACTOR],
    );
  }
  const c = await env!.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'RETAIL', 'Retail', 'EGP', 'inclusive', $3, $1), ($4, $5, 'RETAIL', 'Retail', 'EGP', 'inclusive', $3, $4)`,
      [BOOK, TENANT_A, ACTOR, B_BOOK, TENANT_B],
    );
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'DEFAULT', 'Default', true, $4, $1), ($5, $2, $3, 'NORTH', 'North', false, $4, $5),
              ($6, $7, $8, 'DEFAULT', 'Default', true, $4, $6)`,
      [ZONE_DEFAULT, TENANT_A, BOOK, ACTOR, ZONE_NORTH, B_ZONE, TENANT_B, B_BOOK],
    );
    await c.query(
      `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, revision_no, created_by_user_id, correlation_id,
                                published_by_user_id, published_at)
       VALUES ($1, $2, 'pricing', 'legacy_import', 'legacy', 'published', 1, $3, $1, $3, now())`,
      [CS_LEGACY, TENANT_A, ACTOR],
    );
    await c.query(
      `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
       VALUES (gen_random_uuid(), $1, 1, $2, 'legacy_import', $3, $2)`,
      [TENANT_A, CS_LEGACY, ACTOR],
    );
    await c.query(
      `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)
       VALUES ($1, $2, 1, $4, $4), ($1, $3, 1, $4, $4)`,
      [TENANT_A, STORE_A_X, STORE_A_Y, ACTOR],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
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
      console.warn(`\n[RT-1484 rollback] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-rollback-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("16b5b2"),
    email: "rt1484-rollback-owner-b@example.test",
    membershipId: b("16b5c2"),
    roleId: b("16b5d2"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
  await seedPricing();
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
    { provide: APP_INTERCEPTOR, useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker) },
  ];
  process.env["PRICING_AUTHORING_TENANT_ALLOWLIST"] = `${TENANT_A},${TENANT_B}`;
  app = await bootScopedApp(env, PriceChangeSetsModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (savedAllowlist === undefined) delete process.env["PRICING_AUTHORING_TENANT_ALLOWLIST"];
  else process.env["PRICING_AUTHORING_TENANT_ALLOWLIST"] = savedAllowlist;
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-1484 rollback] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(name: string, body: unknown): void {
  const v = schema(name);
  if (!v(body)) throw new Error(`${name} contract violation: ${JSON.stringify(v.errors)} in ${JSON.stringify(body)}`);
}

const key = (): string => {
  seq += 1;
  return `rt1484-rollback-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

function send(path: string, session: Session, body: unknown, idemKey = key()): request.Test {
  return request(app!.getHttpServer()).post(path).set("Origin", ORIGIN).set("Idempotency-Key", idemKey).set("x-test-session", session).send(body as object);
}

function status(res: request.Response, code: number): void {
  if (res.status !== code) throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
}

function refused(res: request.Response, code: number, errorCode: string): void {
  status(res, code);
  expect((res.body as { error: { code: string } }).error.code).toBe(errorCode);
}

const op = (id: string, action: string): string => `${CS}/${id}/${action}`;

function ok(res: request.Response): ChangeSet {
  status(res, 200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid("PriceChangeSet", res.body);
  return res.body as ChangeSet;
}

async function approvedSet(created: ChangeSet, author: Session = SES_OWNER_ALL): Promise<ChangeSet> {
  const v = ok(await send(op(created.header.id, "validate"), author, { expectedVersion: created.header.version }));
  const s = ok(await send(op(v.header.id, "submit"), author, { expectedVersion: v.header.version }));
  return ok(
    await send(op(s.header.id, "approve"), SES_ADMIN_SPEC, {
      expectedVersion: s.header.version,
      previewHash: s.header.previewHash,
      acknowledgedFindings: ["replaces", "invalidates_dependent"],
    }),
  );
}

async function approved(body: Record<string, unknown>): Promise<ChangeSet> {
  const res = await send(CS, SES_OWNER_ALL, { kind: "standard", title: "RT-1484 rollback", ...body });
  status(res, 201);
  return approvedSet(res.body as ChangeSet);
}

function publish(set: ChangeSet, session: Session = SES_OWNER_ALL): request.Test {
  return send(op(set.header.id, "publish"), session, { expectedVersion: set.header.version });
}

/** Approve and publish `items`; the set and its revision number. */
async function published(body: Record<string, unknown>): Promise<{ revisionNo: number; set: ChangeSet }> {
  const set = await approved(body);
  const res = await publish(set);
  status(res, 200);
  return { revisionNo: (res.body as { revisionNo: number }).revisionNo, set };
}

/** POST rollback; the raw response. */
function rollback(target: string, body: Record<string, unknown> = { reason: "Undo" }, session: Session = SES_OWNER_ALL, idemKey?: string): request.Test {
  return send(op(target, "rollback"), session, body, idemKey);
}

function createdRollback(res: request.Response): ChangeSet {
  status(res, 201);
  expectValid("PriceChangeSet", res.body);
  return res.body as ChangeSet;
}

async function scalar(sql: string, params: unknown[]): Promise<string | null> {
  const r = await env!.admin.query<{ v: string | null }>(sql, params);
  return r.rows[0]?.v ?? null;
}

const head = async (): Promise<number> => Number(await scalar(`SELECT max(revision_no)::text AS v FROM pricing_revisions WHERE tenant_id = $1`, [TENANT_A]));
const stateOf = async (id: string): Promise<string | null> => scalar(`SELECT state AS v FROM change_sets WHERE id = $1`, [id]);

/** The resolver's price of `product` at `store` (UTC zone unless given) at `instant`, as known at `revision` (default head). */
async function priceAt(product: string, instant: string, revision?: number, store = STORE_A_X, timezone = "UTC"): Promise<string | null> {
  const rev = revision ?? (await head());
  return runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (client) => {
    const data = await loadResolutionData(client, { tenantId: TENANT_A, storeId: store, productId: product, sellUnit: "each", revision: rev });
    const r = resolvePrice(product, "each", { id: store, tenantId: TENANT_A, timezone }, new Date(instant), rev, data);
    if (r.status === "error") throw new Error(`resolution error ${r.reason}`);
    return r.status === "priced" ? r.price : null;
  });
}

describe("RT-1484 PR-6 price Change Set rollback over HTTP", () => {
  it("restores the prior price from `from` on as exactly one new rollback revision; four eyes; the target is rolled_back", async () => {
    if (skip()) return;
    await published({ items: [bookPrice(P.basic, "100", "2030-01-01T00:00:00Z")] });
    const target = await published({ items: [bookPrice(P.basic, "120", "2031-01-01T00:00:00Z", "2031-06-01T00:00:00Z")] });
    expect(await priceAt(P.basic, "2031-04-01T00:00:00Z")).toBe("120.0000");

    // Create: a new draft rollback set with generated items; idempotent replay; one live rollback.
    const k = key();
    const res = await rollback(target.set.header.id, { from: "2031-03-01T00:00:00Z", reason: "Wrong price" }, SES_OWNER_ALL, k);
    const rb = createdRollback(res);
    expect(rb.header).toMatchObject({ kind: "rollback", state: "draft", version: 1, rollsBackChangeSetId: target.set.header.id, revisionNo: null });
    expect(rb.items).toEqual([
      {
        op: "set_price",
        scope: { kind: "book" },
        products: items([P.basic]),
        sellUnit: "each",
        price: "100.0000",
        timeBasis: "absolute",
        effectiveFrom: "2031-03-01T00:00:00.000000Z",
      },
    ]);
    const replay = await rollback(target.set.header.id, { from: "2031-03-01T00:00:00Z", reason: "Wrong price" }, SES_OWNER_ALL, k);
    status(replay, 201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(res.body);
    refused(await rollback(target.set.header.id), 409, "change_set_invalid_state");
    // A rollback set's items are generated: they cannot be replaced.
    refused(await request(app!.getHttpServer()).patch(`${CS}/${rb.header.id}`).set("Origin", ORIGIN).set("Idempotency-Key", key()).set("x-test-session", SES_OWNER_ALL).send({ expectedVersion: 1, items: [] }), 409, "change_set_invalid_state");

    // Validate → sensitive (rollback); submit; four eyes; publish.
    const v = ok(await send(op(rb.header.id, "validate"), SES_OWNER_ALL, { expectedVersion: 1 }));
    expect(v.header).toMatchObject({ state: "validated", sensitive: true });
    expect(v.header.sensitivityReasons).toContain("rollback");
    const s = ok(await send(op(rb.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 1 }));
    expect(s.header.state).toBe("pending_approval");
    const approveBody = { expectedVersion: 1, previewHash: s.header.previewHash, acknowledgedFindings: ["replaces"] };
    refused(await send(op(rb.header.id, "approve"), SES_OWNER_ALL, approveBody), 403, "self_approval_forbidden");
    refused(await publish(s), 409, "change_set_invalid_state");
    const appr = ok(await send(op(rb.header.id, "approve"), SES_ADMIN_SPEC, approveBody));
    const before = await head();
    const pub = await publish(appr, SES_OWNER_SPEC);
    status(pub, 200);
    expectValid("PublishPriceChangeSetResponse", pub.body);
    const body = pub.body as { revisionNo: number; changeSet: ChangeSet };
    expect(body.revisionNo).toBe(before + 1);
    expect(body.changeSet.header).toMatchObject({ kind: "rollback", state: "published", revisionNo: before + 1 });

    // Exactly one new revision, of kind rollback, naming the target's.
    expect(await head()).toBe(before + 1);
    const rev = await env!.admin.query<{ kind: string; rolls_back: string }>(
      `SELECT kind, rolls_back_revision_no::text AS rolls_back FROM pricing_revisions WHERE tenant_id = $1 AND revision_no = $2`,
      [TENANT_A, before + 1],
    );
    expect(rev.rows).toEqual([{ kind: "rollback", rolls_back: String(target.revisionNo) }]);
    expect(await scalar(`SELECT string_agg(DISTINCT source, ',') AS v FROM price_events WHERE tenant_id = $1 AND published_in_revision = $2`, [TENANT_A, before + 1])).toBe("rollback");

    // The target is rolled_back and names its rollback; it is not superseded.
    const t = (await request(app!.getHttpServer()).get(`${CS}/${target.set.header.id}`).set("x-test-session", SES_OWNER_ALL)).body as ChangeSet;
    expectValid("PriceChangeSet", t);
    expect(t.header).toMatchObject({ state: "rolled_back", rolledBackByChangeSetId: rb.header.id });

    // Resolver: before the target, during it before `from` (history kept), after `from`, and far after.
    expect(await priceAt(P.basic, "2030-06-01T00:00:00Z")).toBe("100.0000");
    expect(await priceAt(P.basic, "2031-02-01T00:00:00Z")).toBe("120.0000");
    expect(await priceAt(P.basic, "2031-04-01T00:00:00Z")).toBe("100.0000");
    expect(await priceAt(P.basic, "2033-01-01T00:00:00Z")).toBe("100.0000");
    // As known at the target's revision, nothing changed (no history is rewritten).
    expect(await priceAt(P.basic, "2031-04-01T00:00:00Z", target.revisionNo)).toBe("120.0000");

    // The per-line record and the fan-out (a Book line: every live Store).
    const lines = await env!.admin.query<{ event: boolean; results: number }>(
      `SELECT new_event_id IS NOT NULL AS event, cardinality(result_ids) AS results FROM price_change_set_lines WHERE change_set_id = $1`,
      [rb.header.id],
    );
    expect(lines.rows).toEqual([{ event: true, results: 1 }]);
    const fan = await env!.admin.query<{ store: string }>(
      `SELECT store_id::text AS store FROM pricing_revision_stores WHERE tenant_id = $1 AND revision_no = $2`,
      [TENANT_A, before + 1],
    );
    const live = await env!.admin.query<{ id: string }>(`SELECT id::text FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT_A]);
    expect(fan.rows.map((r) => r.store).sort()).toEqual(live.rows.map((r) => r.id).sort());

    // One audit row per transition, no free text; the target's rolled_back row.
    const audit = await env!.admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, id`,
      [rb.header.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "pricing.change_set.created",
      "pricing.change_set.validated",
      "pricing.change_set.submitted",
      "pricing.change_set.approved",
      "pricing.change_set.published",
    ]);
    expect(audit.rows[0]!.metadata).toMatchObject({ kind: "rollback", rolls_back_change_set_id: target.set.header.id, rolls_back_revision_no: target.revisionNo });
    expect(audit.rows[4]!.metadata).toMatchObject({ kind: "rollback", revision_no: before + 1, rolls_back_revision_no: target.revisionNo });
    expect(JSON.stringify(audit.rows)).not.toContain("Wrong price");
    const rolled = await env!.admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.rolled_back'`,
      [target.set.header.id],
    );
    expect(rolled.rows).toHaveLength(1);
    expect(rolled.rows[0]!.metadata).toMatchObject({ rolled_back_by_change_set_id: rb.header.id, rolled_back_in_revision: before + 1 });

    // A rolled-back target is not rolled back again.
    refused(await rollback(target.set.header.id), 409, "change_set_invalid_state");
  });

  it("an end_price target is undone by a set_price; a target that priced an empty interval by an end_price", async () => {
    if (skip()) return;
    await published({ items: [bookPrice(P.ended, "30", "2050-01-01T00:00:00Z")] });
    const end = await published({ items: [{ op: "end_price", scope: { kind: "book" }, products: items([P.ended]), ...at("2052-01-01T00:00:00Z") }] });
    expect(await priceAt(P.ended, "2053-01-01T00:00:00Z")).toBeNull();
    const undoEnd = createdRollback(await rollback(end.set.header.id));
    expect(undoEnd.items).toEqual([
      { op: "set_price", scope: { kind: "book" }, products: items([P.ended]), sellUnit: "each", price: "30.0000", timeBasis: "absolute", effectiveFrom: "2052-01-01T00:00:00.000000Z" },
    ]);
    status(await publish(await approvedSet(undoEnd)), 200);
    expect(await priceAt(P.ended, "2053-01-01T00:00:00Z")).toBe("30.0000");
    expect(await priceAt(P.ended, "2051-01-01T00:00:00Z")).toBe("30.0000");

    await published({ items: [bookPrice(P.empty, "50", "2040-01-01T00:00:00Z", "2041-01-01T00:00:00Z")] });
    const priced = await published({ items: [bookPrice(P.empty, "60", "2042-01-01T00:00:00Z")] });
    const undoPrice = createdRollback(await rollback(priced.set.header.id));
    expect(undoPrice.items).toEqual([
      { op: "end_price", scope: { kind: "book" }, products: items([P.empty]), sellUnit: "each", timeBasis: "absolute", effectiveFrom: "2042-01-01T00:00:00.000000Z" },
    ]);
    status(await publish(await approvedSet(undoPrice)), 200);
    expect(await priceAt(P.empty, "2043-01-01T00:00:00Z")).toBeNull();
    expect(await priceAt(P.empty, "2040-06-01T00:00:00Z")).toBe("50.0000");
    expect(await stateOf(priced.set.header.id)).toBe("rolled_back");
  });

  it("a Zone move is undone by a move restoring the prior Zone (the default Zone fallback), fanned out to the Store", async () => {
    if (skip()) return;
    const stores = new StoresService(env!.app, new StoresRepository(), new MembershipRepository(env!.app));
    const ctx = { tenantId: TENANT_A, userId: USER_OWNER_ALL, storeId: null, isPlatformAdmin: false, source: "session" } as ResolvedContext;
    const s = await stores.create(ctx, { code: "RT1484RBZ", name: "RT-1484 rollback zone" });
    try {
      const move = await published({ items: [{ op: "move_store_zone", storeId: s.id, zoneId: ZONE_NORTH, effectiveFrom: "2044-01-01T00:00:00Z" }] });
      const rb = createdRollback(await rollback(move.set.header.id));
      expect(rb.items).toEqual([{ op: "move_store_zone", storeId: s.id, zoneId: ZONE_DEFAULT, effectiveFrom: "2044-01-01T00:00:00.000000Z" }]);
      const res = await publish(await approvedSet(rb));
      status(res, 200);
      const revisionNo = (res.body as { revisionNo: number }).revisionNo;
      const m = await env!.admin.query<{ zone: string; f: string }>(
        `SELECT price_zone_id::text AS zone, to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS f
           FROM price_zone_memberships WHERE tenant_id = $1 AND store_id = $2 AND state = 'active'`,
        [TENANT_A, s.id],
      );
      expect(m.rows).toEqual([{ zone: ZONE_DEFAULT, f: "2044-01-01" }]);
      const fan = await env!.admin.query<{ store: string }>(`SELECT store_id::text AS store FROM pricing_revision_stores WHERE tenant_id = $1 AND revision_no = $2`, [TENANT_A, revisionNo]);
      expect(fan.rows.map((r) => r.store)).toContain(s.id);
      expect(await stateOf(move.set.header.id)).toBe("rolled_back");

      // A move out of a non-default Zone is undone by a move back into it (the carried head stays).
      await published({ items: [{ op: "move_store_zone", storeId: s.id, zoneId: ZONE_NORTH, effectiveFrom: "2046-01-01T00:00:00Z" }] });
      const out = await published({ items: [{ op: "move_store_zone", storeId: s.id, zoneId: ZONE_DEFAULT, effectiveFrom: "2047-01-01T00:00:00Z" }] });
      const back = createdRollback(await rollback(out.set.header.id));
      expect(back.items).toEqual([{ op: "move_store_zone", storeId: s.id, zoneId: ZONE_NORTH, effectiveFrom: "2047-01-01T00:00:00.000000Z" }]);
      status(await publish(await approvedSet(back)), 200);
      const after = await env!.admin.query<{ zone: string; f: string; t: string | null }>(
        `SELECT price_zone_id::text AS zone, to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS f,
                to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS t
           FROM price_zone_memberships WHERE tenant_id = $1 AND store_id = $2 AND state = 'active' ORDER BY effective_from`,
        [TENANT_A, s.id],
      );
      expect(after.rows).toEqual([
        { zone: ZONE_DEFAULT, f: "2044-01-01", t: "2046-01-01" },
        { zone: ZONE_NORTH, f: "2046-01-01", t: "2047-01-01" },
        { zone: ZONE_NORTH, f: "2047-01-01", t: null },
      ]);
    } finally {
      await env!.admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [s.id]);
    }
  });

  it("a store_local key restores from a wall-clock instant no Store sees before `from`", async () => {
    if (skip()) return;
    const local = (price: string, from: string) => ({ op: "set_price", scope: { kind: "book" }, products: items([P.local]), price, timeBasis: "store_local", effectiveFrom: from });
    await published({ items: [local("50", "2070-01-01T00:00")] });
    const target = await published({ items: [local("55", "2071-01-01T00:00")] });
    const rb = createdRollback(await rollback(target.set.header.id, { from: "2071-06-01T00:00:00.5Z", reason: "Undo" }));
    expect(rb.items).toHaveLength(1);
    const item = rb.items[0] as { op: string; timeBasis: string; price: string; effectiveFrom: string };
    expect(item).toMatchObject({ op: "set_price", timeBasis: "store_local", price: "50.0000" });
    // The latest wall clock of the tenant's live Stores at `from`, rounded up to the second.
    const latest = await scalar(
      `SELECT to_char(max(date_trunc('second', ('2071-06-01T00:00:00.5Z'::timestamptz AT TIME ZONE timezone)) + interval '1 second'), 'YYYY-MM-DD"T"HH24:MI:SS') AS v
         FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [TENANT_A],
    );
    expect(item.effectiveFrom).toBe(latest);
    expect(item.effectiveFrom >= "2071-06-01T00:00:01").toBe(true);
    status(await publish(await approvedSet(rb)), 200);
    expect(await priceAt(P.local, "2072-01-01T00:00:00Z")).toBe("50.0000");
    expect(await priceAt(P.local, "2071-03-01T00:00:00Z")).toBe("55.0000");
  });

  it("rollback_blocked: a later revision superseded the target's rows or priced a key it touched; newest first works", async () => {
    if (skip()) return;
    const first = await published({ items: [bookPrice(P.blocked, "70", "2060-01-01T00:00:00Z")] });
    // `second` supersedes every row of `first`: `first` is `superseded`, and its rollback is blocked.
    const second = await published({ items: [bookPrice(P.blocked, "71", "2061-01-01T00:00:00Z")] });
    const sets = await scalar(`SELECT count(*)::text AS v FROM change_sets WHERE tenant_id = $1`, [TENANT_A]);
    expect(await stateOf(first.set.header.id)).toBe("superseded");
    const blocked = await rollback(first.set.header.id);
    refused(blocked, 409, "rollback_blocked");
    expect((blocked.body as { blockingRevisionNos: number[] }).blockingRevisionNos).toEqual([second.revisionNo]);
    const conflict = ajv.compile({ $ref: `${CONTRACT}#/components/responses/RollbackConflict/content/application~1json/schema` });
    expect(conflict(blocked.body)).toBe(true);
    expectValid("RollbackBlocked", blocked.body);
    expect(await scalar(`SELECT count(*)::text AS v FROM change_sets WHERE tenant_id = $1`, [TENANT_A])).toBe(sets);
    // Newest first: the later set rolls back.
    createdRollback(await rollback(second.set.header.id));

    // A later revision that prices an interval the target ended (no row of the target superseded).
    await published({ items: [bookPrice(P.later, "80", "2060-01-01T00:00:00Z")] });
    const end = await published({ items: [{ op: "end_price", scope: { kind: "book" }, products: items([P.later]), ...at("2062-01-01T00:00:00Z") }] });
    const after = await published({ items: [bookPrice(P.later, "81", "2063-01-01T00:00:00Z")] });
    const res = await rollback(end.set.header.id);
    refused(res, 409, "rollback_blocked");
    expect((res.body as { blockingRevisionNos: number[] }).blockingRevisionNos).toEqual([after.revisionNo]);
  });

  it("rollback_blocked at validate; a blocked or superseded target at publish is stale_validation (reason rollback_blocked)", async () => {
    if (skip()) return;
    await published({ items: [bookPrice(P.stale, "90", "2064-01-01T00:00:00Z")] });
    const target = await published({ items: [bookPrice(P.stale, "91", "2065-01-01T00:00:00Z")] });
    const rb = createdRollback(await rollback(target.set.header.id));
    const later = await published({ items: [bookPrice(P.stale, "92", "2066-01-01T00:00:00Z")] });
    const res = await send(op(rb.header.id, "validate"), SES_OWNER_ALL, { expectedVersion: 1 });
    refused(res, 409, "rollback_blocked");
    expect((res.body as { blockingRevisionNos: number[] }).blockingRevisionNos).toEqual([later.revisionNo]);
    expect(await stateOf(rb.header.id)).toBe("draft");

    // Approved, then its target leaves `published` (outside the API): publish is stale, nothing written.
    const target2 = await published({ items: [bookPrice(P.superseded, "93", "2067-01-01T00:00:00Z")] });
    const rb2 = await approvedSet(createdRollback(await rollback(target2.set.header.id)));
    await env!.admin.query(`UPDATE change_sets SET state = 'superseded' WHERE id = $1`, [target2.set.header.id]);
    const h = await head();
    refused(await publish(rb2), 409, "stale_validation");
    expect(await head()).toBe(h);
    expect(await scalar(`SELECT state || ':' || version AS v FROM change_sets WHERE id = $1`, [rb2.header.id])).toBe("draft:2");
    const stale = await env!.admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.stale'`,
      [rb2.header.id],
    );
    expect(stale.rows).toHaveLength(1);
    expect(stale.rows[0]!.metadata).toMatchObject({ reason: "rollback_blocked" });
    // A superseded target is not rollbackable.
    refused(await rollback(target2.set.header.id), 409, "change_set_invalid_state");
  });

  it("refuses a draft target, the legacy import, an absent or foreign id; nothing to restore is 422 change_set_empty", async () => {
    if (skip()) return;
    const draft = await send(CS, SES_OWNER_ALL, { kind: "standard", title: "draft" });
    refused(await rollback((draft.body as ChangeSet).header.id), 409, "change_set_invalid_state");
    refused(await rollback(CS_LEGACY), 409, "change_set_invalid_state");
    refused(await rollback(a("16b5ffff")), 404, "not_found");
    refused(await rollback("not-a-uuid"), 400, "validation_error");
    refused(await rollback(CS_LEGACY, {}), 400, "validation_error");
    refused(await rollback(CS_LEGACY, { reason: "x", from: "2030-01-01" }), 400, "validation_error");
    // The target changed only before `from`: nothing to restore.
    const target = await published({ items: [bookPrice(P.nothing, "10", "2068-01-01T00:00:00Z", "2068-02-01T00:00:00Z")] });
    refused(await rollback(target.set.header.id, { from: "2069-01-01T00:00:00Z", reason: "late" }), 422, "change_set_empty");
  });

  it("a rollback publishes past-dated lines: exempt from the lead time and the past-dated recheck", async () => {
    if (skip()) return;
    const service = app!.get(PriceChangeSetsService);
    const real = service.clock;
    try {
      service.clock = () => Date.parse("2029-01-01T00:00:00Z");
      await published({ items: [bookPrice(P.past, "15", "2030-01-01T00:00:00Z")] });
      const target = await published({ items: [bookPrice(P.past, "16", "2031-01-01T00:00:00Z")] });
      // Later, `from` defaults to now: the restored line starts in the past.
      service.clock = () => Date.parse("2032-01-01T00:00:00Z");
      const rb = createdRollback(await rollback(target.set.header.id));
      expect((rb.items[0] as { effectiveFrom: string }).effectiveFrom).toBe("2032-01-01T00:00:00.000000Z");
      service.clock = () => Date.parse("2032-02-01T00:00:00Z");
      const ready = await approvedSet(rb);
      expect(ready.summary).toMatchObject({ blocking: false, findings: expect.objectContaining({ past_dated: 1 }) });
      service.clock = () => Date.parse("2032-03-01T00:00:00Z");
      status(await publish(ready), 200);
      expect(await priceAt(P.past, "2032-06-01T00:00:00Z")).toBe("15.0000");
      expect(await priceAt(P.past, "2031-06-01T00:00:00Z")).toBe("16.0000");
    } finally {
      service.clock = real;
    }
  });

  it("a rollback publish and a publish of the same key serialize: one wins, the other is stale", async () => {
    if (skip()) return;
    await published({ items: [bookPrice(P.race, "20", "2080-01-01T00:00:00Z")] });
    const target = await published({ items: [bookPrice(P.race, "21", "2081-01-01T00:00:00Z")] });
    const rb = await approvedSet(createdRollback(await rollback(target.set.header.id)));
    const other = await approved({ items: [bookPrice(P.race, "22", "2082-01-01T00:00:00Z")] });
    const start = await head();
    const race = await Promise.all([publish(rb), publish(other)]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((race.find((r) => r.status === 409)!.body as { error: { code: string } }).error.code).toBe("stale_validation");
    expect(await head()).toBe(start + 1);
  });

  it("the authoring gate, roles and two-tenant RLS (HTTP and direct SQL under a mismatched GUC)", async () => {
    if (skip()) return;
    const target = await published({ items: [bookPrice(P.gate, "40", "2090-01-01T00:00:00Z")] });
    refused(await rollback(target.set.header.id, { reason: "x" }, SES_MANAGER), 404, "not_found");
    refused(await rollback(target.set.header.id, { reason: "x" }, SES_OWNER_B), 404, "not_found");
    const config = app!.get<{ tenantIds: Set<string> }>(PRICING_AUTHORING_CONFIG, { strict: false });
    config.tenantIds.delete(TENANT_A);
    try {
      refused(await rollback(target.set.header.id), 409, "pricing_authority_legacy");
    } finally {
      config.tenantIds.add(TENANT_A);
    }
    const rb = createdRollback(await rollback(target.set.header.id));
    // Direct SQL as the NOBYPASSRLS app role under tenant B's GUC: A's sets are invisible, and a
    // rollback set for A is refused.
    const c = await env!.app.connect();
    let failure: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.is_platform_admin', 'false', true)`, [TENANT_B]);
      const seen = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM change_sets WHERE id = ANY($1::uuid[])`, [[rb.header.id, target.set.header.id]]);
      expect(seen.rows[0]!.n).toBe(0);
      const upd = await c.query(`UPDATE change_sets SET state = 'rolled_back' WHERE id = $1`, [target.set.header.id]);
      expect(upd.rowCount).toBe(0);
      await c.query("SAVEPOINT w");
      await expect(
        c.query(
          `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, rolls_back_change_set_id, created_by_user_id, correlation_id)
           VALUES (gen_random_uuid(), $1, 'pricing', 'rollback', 'x', 'x', $2, $3, gen_random_uuid())`,
          [TENANT_A, target.set.header.id, ACTOR],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT w");
    } finally {
      try {
        await c.query("ROLLBACK");
      } catch (err) {
        failure = err as Error;
      }
      c.release(failure);
    }
    // Under its own tenant the rollback still publishes.
    status(await publish(await approvedSet(rb)), 200);
    expect(await stateOf(target.set.header.id)).toBe("rolled_back");
  });
});
