/**
 * RT-1484 PR-5 (RT-282 PR-10b) — Price Change Set submit, approve, reject and publish over HTTP
 * against real Postgres (Testcontainers, every migration including 0121 and 0123, the NOBYPASSRLS
 * `app_test` pool holding only the production pricing grants) and the real module graph
 * (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`, `PricingAuthoringGuard`, the shared
 * `IdempotencyInterceptor` over a fake Redis). Only cookie authentication is faked. Revision 1 (the
 * tenant's legacy import) is seeded by the superuser with triggers off; every later revision is
 * written by the publish runtime under 0121 / 0123's triggers and COMMIT-time checks.
 *
 *   rev 1 (legacy_import)  book P1 100.0000 from 2030-01-01Z (absolute)
 *                          book P4  50.0000 from 2030-01-01T00:00 (store_local)
 *
 * Authors: OWNER (owner, `all`), ADMIN (tenant_admin), SPEC (owner, `specific`): three users.
 *
 * What this proves (`pricing/price-change-sets.yaml` submit, approve, reject, publish; spec 042
 * §3, §7, §8, §10; spec 041 data-model §2.3–§2.6):
 *   - the lifecycle validate → submit → approve → publish; publish writes exactly ONE immutable
 *     revision: the replaced events end, their uncovered parts are carried forward exactly on both
 *     time bases, the new events and the per-line record (`new_event_id`, `result_ids`) are
 *     written, the fan-out reaches every live Store for a Book line, a set whose rows are all
 *     ended becomes `superseded`, one audit row per transition, and the deferred COMMIT checks
 *     pass (a revision written without its publish is refused at COMMIT);
 *   - four eyes (`403 self_approval_forbidden`) on approve and on publish, the emergency path
 *     included (owner or tenant_admin starts it, a second approver is still required);
 *   - `409 version_conflict`, `change_set_invalid_state`, `preview_changed`, `stale_validation`
 *     (a later intersecting revision, a Store created since validation; the set returns to draft
 *     at version + 1 and that return commits), `422 blocking_findings` and
 *     `acknowledgement_required`; reject records `lastRejection`;
 *   - concurrent publishes serialize under the tenant publish lock: unrelated sets both publish at
 *     consecutive revisions, the second of two intersecting sets goes stale;
 *   - the Store lifecycle bootstrap row (data-model §2.6) at the head;
 *   - the allowlist refusal, roles, two-tenant RLS including direct SQL under a mismatched GUC;
 *   - a Zone move publishes its membership rows; idempotent replay; AJV on every body.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool, PoolClient } from "pg";
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
import { StoresRepository } from "../../src/stores/stores.repository";
import { StoresService } from "../../src/stores/stores.service";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import { APP_ROLE_NAME, applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { PRODUCT_A_ACTIVE, PRODUCT_A_RETIRED, STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { bootScopedApp, SES_ADMIN_SPEC, SES_OWNER_ALL, SES_OWNER_SPEC } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SES_MANAGER, seedConsoleSalesFixture } from "../console-sales/__support__/console-sales-fixture";

type Session = string;

const CS = "/api/v1/pricing/change-sets";
const ORIGIN = "http://127.0.0.1";
const CONTRACT = "price-change-sets";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
/** The users behind the shared sessions (read-store-scope.ts). */
const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";
const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019202a2";
const SES_OWNER_B = b("15b5a2");
const ACTOR = a("15b5e2");
const BOOK = a("15b5b0");
const ZONE_DEFAULT = a("15b5d0");
const ZONE_NORTH = a("15b5d1");
const P1 = PRODUCT_A_ACTIVE;
const P2 = PRODUCT_A_RETIRED;
const P3 = a("15b5f3");
const P4 = a("15b5f4");
const P5 = a("15b5f5");
const P6 = a("15b5f6");
const CS_LEGACY = a("15b5c1");
const E_BOOK_P1 = a("15b5e101");
const E_BOOK_P4_LOCAL = a("15b5e102");
const B_BOOK = b("15b5b0");
const B_ZONE = b("15b5d0");

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
  validatedAtRevision: number | null;
  publicationStatus: string | null;
  revisionNo: number | null;
  submitted: { userId: string } | null;
  approved: { userId: string } | null;
  published: { userId: string } | null;
  lastRejection: { userId: string; reason: string } | null;
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

/** Revision 1: the tenant's legacy import (Book, Zones and two Book events), seeded with triggers off. */
async function seedPricing(): Promise<void> {
  await env!.admin.query(`UPDATE stores SET timezone = 'UTC' WHERE id = $1`, [STORE_A_X]);
  await env!.admin.query(`UPDATE stores SET timezone = 'America/New_York' WHERE id = $1`, [STORE_A_Y]);
  for (const [id, name] of [[P3, "P3"], [P4, "P4"], [P5, "P5"], [P6, "P6"]] as const) {
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, $3, 'standard', $4, $4)`,
      [id, TENANT_A, `RT-1484 publish ${name}`, ACTOR],
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
      `INSERT INTO price_events (id, tenant_id, price_book_id, scope, product_id, price, currency_code, time_basis, effective_from,
                                 effective_from_local, state, published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'book', $4, 100, 'EGP', 'absolute', '2030-01-01T00:00:00Z', NULL, 'active', 1, $5, 'legacy_import', $6, $1),
              ($7, $2, $3, 'book', $8, 50, 'EGP', 'store_local', NULL, '2030-01-01T00:00:00', 'active', 1, $5, 'legacy_import', $6, $7)`,
      [E_BOOK_P1, TENANT_A, BOOK, P1, CS_LEGACY, ACTOR, E_BOOK_P4_LOCAL, P4],
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
      console.warn(`\n[RT-1484 publish] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-publish-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("15b5b2"),
    email: "rt1484-publish-owner-b@example.test",
    membershipId: b("15b5c2"),
    roleId: b("15b5d2"),
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
    console.warn("[RT-1484 publish] skipping — Docker unavailable");
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
  return `rt1484-publish-${String(seq).padStart(8, "0")}-${Date.now()}`;
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

async function ok(res: request.Response): Promise<ChangeSet> {
  status(res, 200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid("PriceChangeSet", res.body);
  return res.body as ChangeSet;
}

async function created(body: Record<string, unknown>, session: Session = SES_OWNER_ALL): Promise<ChangeSet> {
  const res = await send(CS, session, { kind: "standard", title: "RT-1484 publish", ...body });
  status(res, 201);
  return res.body as ChangeSet;
}

async function validated(body: Record<string, unknown>, session: Session = SES_OWNER_ALL): Promise<ChangeSet> {
  const set = await created(body, session);
  return ok(await send(op(set.header.id, "validate"), session, { expectedVersion: set.header.version }));
}

async function submitted(body: Record<string, unknown>, session: Session = SES_OWNER_ALL): Promise<ChangeSet> {
  const set = await validated(body, session);
  return ok(await send(op(set.header.id, "submit"), session, { expectedVersion: set.header.version }));
}

const ALL_ACKS = ["replaces", "invalidates_dependent"];

async function approved(body: Record<string, unknown>): Promise<ChangeSet> {
  const set = await submitted(body);
  return ok(
    await send(op(set.header.id, "approve"), SES_ADMIN_SPEC, {
      expectedVersion: set.header.version,
      previewHash: set.header.previewHash,
      acknowledgedFindings: ALL_ACKS,
    }),
  );
}

function publish(set: ChangeSet, session: Session = SES_OWNER_ALL, idemKey?: string): request.Test {
  return send(op(set.header.id, "publish"), session, { expectedVersion: set.header.version }, idemKey);
}

async function scalar(sql: string, params: unknown[]): Promise<string | null> {
  const r = await env!.admin.query<{ v: string | null }>(sql, params);
  return r.rows[0]?.v ?? null;
}

const head = async (): Promise<number> => Number(await scalar(`SELECT max(revision_no)::text AS v FROM pricing_revisions WHERE tenant_id = $1`, [TENANT_A]));

describe("RT-1484 PR-5 price Change Set submit, approve, reject and publish over HTTP", () => {
  it("validate → submit → approve → publish writes exactly one immutable revision with its record and fan-out", async () => {
    if (skip()) return;
    const before = await head();
    expect(before).toBe(1);
    const set = await validated({
      items: [
        bookPrice(P1, "120", "2031-01-01T00:00:00.000001Z", "2031-06-01T00:00:00Z"),
        { op: "set_price", scope: { kind: "book" }, products: items([P4]), price: "55", timeBasis: "store_local", effectiveFrom: "2032-01-01T00:00", effectiveTo: "2032-02-01T00:00" },
      ],
    });
    expect(set.header.state).toBe("validated");

    // Submit: sensitive (approval mode `always`) → pending_approval; a stale version is 409 first.
    refused(await send(op(set.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 9 }), 409, "version_conflict");
    const pending = await ok(await send(op(set.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 1 }));
    expect(pending.header).toMatchObject({ state: "pending_approval", version: 1, submitted: { userId: USER_OWNER_ALL }, approved: null });

    // Approve: four eyes, the bound preview, the acknowledgements.
    const approveBody = { expectedVersion: 1, previewHash: pending.header.previewHash, acknowledgedFindings: ["replaces"] };
    refused(await send(op(set.header.id, "approve"), SES_OWNER_ALL, approveBody), 403, "self_approval_forbidden");
    refused(await send(op(set.header.id, "approve"), SES_ADMIN_SPEC, { ...approveBody, previewHash: `sha256:${"b".repeat(64)}` }), 409, "preview_changed");
    const noAck = await send(op(set.header.id, "approve"), SES_ADMIN_SPEC, { ...approveBody, acknowledgedFindings: [] });
    refused(noAck, 422, "acknowledgement_required");
    expect((noAck.body as { error: { message: string } }).error.message).toContain("replaces");
    refused(await publish(pending), 409, "change_set_invalid_state");
    const approvedSet = await ok(await send(op(set.header.id, "approve"), SES_ADMIN_SPEC, approveBody));
    expect(approvedSet.header).toMatchObject({ state: "approved", approved: { userId: USER_ADMIN_SPEC } });

    // Publish.
    refused(await publish({ ...approvedSet, header: { ...approvedSet.header, version: 2 } }), 409, "version_conflict");
    const k = key();
    const res = await publish(approvedSet, SES_OWNER_ALL, k);
    status(res, 200);
    expectValid("PublishPriceChangeSetResponse", res.body);
    const body = res.body as { revisionNo: number; changeSet: ChangeSet };
    expect(body.revisionNo).toBe(before + 1);
    expect(body.changeSet.header).toMatchObject({
      state: "published",
      revisionNo: before + 1,
      publicationStatus: "scheduled",
      published: { userId: USER_OWNER_ALL },
    });
    const replay = await publish(approvedSet, SES_OWNER_ALL, k);
    status(replay, 200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(res.body);
    refused(await publish(approvedSet), 409, "change_set_invalid_state");

    // Exactly one revision, of kind publish, with the conservative G4 bound (the earliest line start).
    expect(await head()).toBe(before + 1);
    const rev = await env!.admin.query<{ kind: string; earliest: string }>(
      `SELECT kind, to_char(earliest_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS earliest
         FROM pricing_revisions WHERE tenant_id = $1 AND change_set_id = $2`,
      [TENANT_A, set.header.id],
    );
    expect(rev.rows).toEqual([{ kind: "publish", earliest: "2031-01-01T00:00:00.000001" }]);

    // The replaced events end; their uncovered parts are carried forward exactly (both time bases).
    const events = await env!.admin.query<{ id: string; product: string; price: string; state: string; ended: string | null; carried: boolean; supersedes: string | null; f: string | null; t: string | null; fl: string | null; tl: string | null }>(
      `SELECT id::text, product_id::text AS product, price::text, state, ended_in_revision::text AS ended, carried_forward AS carried,
              supersedes_event_id::text AS supersedes,
              to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS f,
              to_char(effective_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS t,
              to_char(effective_from_local, 'YYYY-MM-DD"T"HH24:MI') AS fl, to_char(effective_to_local, 'YYYY-MM-DD"T"HH24:MI') AS tl
         FROM price_events WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
        ORDER BY product_id, coalesce(effective_from, effective_from_local AT TIME ZONE 'UTC'), carried_forward`,
      [TENANT_A, [P1, P4]],
    );
    const shape = events.rows.map((e) => [e.product === P1 ? "P1" : "P4", e.price, e.state, e.carried, e.f ?? e.fl, e.t ?? e.tl]);
    expect(shape).toEqual(
      expect.arrayContaining([
        ["P1", "100.0000", "superseded", false, "2030-01-01T00:00:00.000000", null],
        ["P1", "100.0000", "active", true, "2030-01-01T00:00:00.000000", "2031-01-01T00:00:00.000001"],
        ["P1", "120.0000", "active", false, "2031-01-01T00:00:00.000001", "2031-06-01T00:00:00.000000"],
        ["P1", "100.0000", "active", true, "2031-06-01T00:00:00.000000", null],
        ["P4", "50.0000", "superseded", false, "2030-01-01T00:00", null],
        ["P4", "50.0000", "active", true, "2030-01-01T00:00", "2032-01-01T00:00"],
        ["P4", "55.0000", "active", false, "2032-01-01T00:00", "2032-02-01T00:00"],
        ["P4", "50.0000", "active", true, "2032-02-01T00:00", null],
      ]),
    );
    expect(events.rows).toHaveLength(8);
    expect(events.rows.filter((e) => e.ended !== null).map((e) => e.ended)).toEqual([String(before + 1), String(before + 1)]);
    expect(events.rows.filter((e) => e.carried).every((e) => e.supersedes === E_BOOK_P1 || e.supersedes === E_BOOK_P4_LOCAL)).toBe(true);

    // The per-line record: each line's event and its two carried-forward rows.
    const lines = await env!.admin.query<{ line_no: number; has_event: boolean; results: number }>(
      `SELECT line_no, new_event_id IS NOT NULL AS has_event, cardinality(result_ids) AS results FROM price_change_set_lines
        WHERE change_set_id = $1 ORDER BY line_no`,
      [set.header.id],
    );
    expect(lines.rows).toEqual([
      { line_no: 1, has_event: true, results: 2 },
      { line_no: 2, has_event: true, results: 2 },
    ]);

    // A Book line fans out to every live Store of the tenant.
    const fan = await env!.admin.query<{ store: string }>(
      `SELECT store_id::text AS store FROM pricing_revision_stores WHERE tenant_id = $1 AND revision_no = $2`,
      [TENANT_A, before + 1],
    );
    const live = await env!.admin.query<{ id: string }>(`SELECT id::text FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT_A]);
    expect(fan.rows.map((r) => r.store).sort()).toEqual(live.rows.map((r) => r.id).sort());

    // The legacy import's every event is now ended: it is superseded.
    expect(await scalar(`SELECT state AS v FROM change_sets WHERE id = $1`, [CS_LEGACY])).toBe("superseded");

    // One audit row per transition, with no free text.
    const audit = await env!.admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY occurred_at, id`,
      [set.header.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "pricing.change_set.created",
      "pricing.change_set.validated",
      "pricing.change_set.submitted",
      "pricing.change_set.approved",
      "pricing.change_set.published",
    ]);
    expect(audit.rows[4]!.metadata).toMatchObject({ revision_no: before + 1, kind: "standard", emergency: false, approved_by_user_id: USER_ADMIN_SPEC });
    expect(await scalar(`SELECT count(*)::text AS v FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.superseded'`, [CS_LEGACY])).toBe("1");

    // The revision is immutable: even the superuser cannot edit or delete it.
    await expect(env!.admin.query(`UPDATE pricing_revisions SET kind = 'publish' WHERE tenant_id = $1 AND revision_no = $2`, [TENANT_A, before + 1])).rejects.toThrow(/append-only/);
    await expect(env!.admin.query(`UPDATE price_events SET price = 1 WHERE tenant_id = $1 AND published_in_revision = $2`, [TENANT_A, before + 1])).rejects.toThrow(/never edited/);
  });

  it("the deferred COMMIT checks refuse a revision written without its publish", async () => {
    if (skip()) return;
    const set = await approved({ items: [bookPrice(P5, "11", "2036-01-01T00:00:00Z")] });
    const c = await env!.app.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.is_platform_admin', 'false', true)`, [TENANT_A]);
      await c.query(
        `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
         VALUES (gen_random_uuid(), $1, (SELECT max(revision_no) + 1 FROM pricing_revisions WHERE tenant_id = $1), $2, 'publish', $3, $2)`,
        [TENANT_A, set.header.id, ACTOR],
      );
      await expect(c.query("COMMIT")).rejects.toThrow(/is not published at it/);
    } finally {
      c.release();
    }
    // The set still publishes through the runtime, whose writes pass the same checks at COMMIT.
    status(await publish(set), 200);
  });

  it("concurrent publishes serialize: unrelated sets take consecutive revisions, an intersecting one goes stale", async () => {
    if (skip()) return;
    const [x, y] = [await approved({ items: [bookPrice(P5, "12", "2037-01-01T00:00:00Z")] }), await approved({ items: [bookPrice(P6, "13", "2037-01-01T00:00:00Z")] })];
    const start = await head();
    const both = await Promise.all([publish(x), publish(y)]);
    for (const r of both) status(r, 200);
    expect(both.map((r) => (r.body as { revisionNo: number }).revisionNo).sort()).toEqual([start + 1, start + 2]);

    // Two sets on one product: the first publish wins, the other returns to draft at version + 1.
    const [p, q] = [await approved({ items: [bookPrice(P3, "20", "2038-01-01T00:00:00Z", "2038-06-01T00:00:00Z")] }), await approved({ items: [bookPrice(P3, "21", "2039-01-01T00:00:00Z")] })];
    const race = await Promise.all([publish(p), publish(q)]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const lost = race.find((r) => r.status === 409)!;
    expect((lost.body as { error: { code: string } }).error.code).toBe("stale_validation");
    const loser = race[0]!.status === 409 ? p : q;
    const reread = (await request(app!.getHttpServer()).get(`${CS}/${loser.header.id}`).set("x-test-session", SES_OWNER_ALL)).body as ChangeSet;
    expect(reread.header).toMatchObject({ state: "draft", version: 2, previewHash: null, submitted: null, approved: null });
    expect(await head()).toBe(start + 3);
    expect(await scalar(`SELECT count(*)::text AS v FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.stale'`, [loser.header.id])).toBe("1");
    // Re-validated, it publishes on top of the winner.
    const again = await ok(await send(op(loser.header.id, "validate"), SES_OWNER_ALL, { expectedVersion: 2 }));
    expect(again.header.validatedAtRevision).toBe(start + 3);
  });

  it("emergency: an owner or tenant_admin starts it; without an independent second approver it never publishes", async () => {
    if (skip()) return;
    const set = await validated({ kind: "emergency", reason: "Recall", items: [bookPrice(P6, "9", "2040-01-01T00:00:00Z")] }, SES_ADMIN_SPEC);
    const pending = await ok(await send(op(set.header.id, "submit"), SES_ADMIN_SPEC, { expectedVersion: 1 }));
    expect(pending.header.state).toBe("pending_approval");
    refused(await send(op(set.header.id, "approve"), SES_ADMIN_SPEC, { expectedVersion: 1, previewHash: pending.header.previewHash, acknowledgedFindings: ALL_ACKS }), 403, "self_approval_forbidden");
    refused(await publish(pending, SES_ADMIN_SPEC), 409, "change_set_invalid_state");
    // An approval by its own author (written outside the API) is refused at publish too, writing nothing.
    await env!.admin.query(
      `UPDATE change_sets SET state = 'approved', approved_by_user_id = created_by_user_id, approved_at = now() WHERE id = $1`,
      [set.header.id],
    );
    const before = await head();
    refused(await publish(pending, SES_OWNER_ALL), 403, "self_approval_forbidden");
    expect(await head()).toBe(before);
    expect(await scalar(`SELECT state AS v FROM change_sets WHERE id = $1`, [set.header.id])).toBe("approved");
    // With an independent approver it publishes as an emergency revision, audited as one.
    const second = await validated({ kind: "emergency", reason: "Recall 2", items: [bookPrice(P6, "8", "2041-01-01T00:00:00Z")] });
    const sub = await ok(await send(op(second.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 1 }));
    const appr = await ok(await send(op(second.header.id, "approve"), SES_ADMIN_SPEC, { expectedVersion: 1, previewHash: sub.header.previewHash, acknowledgedFindings: ALL_ACKS }));
    const res = await publish(appr, SES_OWNER_SPEC);
    status(res, 200);
    const revisionNo = (res.body as { revisionNo: number }).revisionNo;
    expect(await scalar(`SELECT kind AS v FROM pricing_revisions WHERE tenant_id = $1 AND revision_no = $2`, [TENANT_A, revisionNo])).toBe("emergency");
    expect(await scalar(`SELECT source AS v FROM price_events WHERE tenant_id = $1 AND published_in_revision = $2 AND NOT carried_forward`, [TENANT_A, revisionNo])).toBe("emergency");
    const meta = await env!.admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.published'`,
      [second.header.id],
    );
    expect(meta.rows[0]!.metadata).toMatchObject({ emergency: true, kind: "emergency", reason_present: true });
    expect(JSON.stringify(meta.rows[0]!.metadata)).not.toContain("Recall");
  });

  it("reject returns a pending set to draft at version + 1 with lastRejection; blocking findings refuse submit", async () => {
    if (skip()) return;
    const pending = await submitted({ items: [bookPrice(P3, "30", "2042-01-01T00:00:00Z")] });
    refused(await send(op(pending.header.id, "reject"), SES_ADMIN_SPEC, { expectedVersion: 1 }), 400, "validation_error");
    const rejected = await ok(await send(op(pending.header.id, "reject"), SES_ADMIN_SPEC, { expectedVersion: 1, reason: "Too deep" }));
    expect(rejected.header).toMatchObject({
      state: "draft",
      version: 2,
      previewHash: null,
      validatedAtRevision: null,
      submitted: null,
      lastRejection: { userId: USER_ADMIN_SPEC, reason: "Too deep" },
    });
    expect(rejected.summary).toBeNull();
    refused(await send(op(pending.header.id, "reject"), SES_ADMIN_SPEC, { expectedVersion: 2, reason: "Again" }), 409, "change_set_invalid_state");
    refused(await send(op(pending.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 2 }), 409, "change_set_invalid_state");
    const audit = await scalar(`SELECT metadata::text AS v FROM audit_events WHERE target_id = $1 AND action = 'pricing.change_set.rejected'`, [pending.header.id]);
    expect(audit).not.toContain("Too deep");

    const blocking = await validated({ items: [bookPrice(P2, "10", "2042-01-01T00:00:00Z")] });
    expect(blocking.summary).toMatchObject({ blocking: true });
    refused(await send(op(blocking.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 1 }), 422, "blocking_findings");
  });

  it("a Store created after validation stales the set (Q-B8) and gets its bootstrap row at the head", async () => {
    if (skip()) return;
    const set = await validated({ items: [bookPrice(P5, "14", "2043-01-01T00:00:00Z")] });
    const stores = new StoresService(env!.app, new StoresRepository(), new MembershipRepository(env!.app));
    const ctx = { tenantId: TENANT_A, userId: USER_OWNER_ALL, storeId: null, isPlatformAdmin: false, source: "session" } as ResolvedContext;
    const store = await stores.create(ctx, { code: "RT1484PUB", name: "RT-1484 new store" });
    try {
      const h = await head();
      expect(await scalar(`SELECT revision_no::text AS v FROM pricing_revision_stores WHERE tenant_id = $1 AND store_id = $2`, [TENANT_A, store.id])).toBe(String(h));
      refused(await send(op(set.header.id, "submit"), SES_OWNER_ALL, { expectedVersion: 1 }), 409, "stale_validation");
      expect(await scalar(`SELECT state || ':' || version AS v FROM change_sets WHERE id = $1`, [set.header.id])).toBe("draft:2");
      // Re-validated, the set reaches the new Store.
      const again = await ok(await send(op(set.header.id, "validate"), SES_OWNER_ALL, { expectedVersion: 2 }));
      expect((again.summary as { stores: number }).stores).toBe((set.summary as { stores: number }).stores + 1);
    } finally {
      await env!.admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [store.id]);
    }
  });

  it("a Zone move publishes the Store's new membership and fans out to it", async () => {
    if (skip()) return;
    const set = await approved({ items: [{ op: "move_store_zone", storeId: STORE_A_Y, zoneId: ZONE_NORTH, effectiveFrom: "2044-01-01T00:00:00Z" }] });
    const res = await publish(set);
    status(res, 200);
    const revisionNo = (res.body as { revisionNo: number }).revisionNo;
    const m = await env!.admin.query<{ zone: string; store: string }>(
      `SELECT price_zone_id::text AS zone, store_id::text AS store FROM price_zone_memberships WHERE tenant_id = $1 AND published_in_revision = $2`,
      [TENANT_A, revisionNo],
    );
    expect(m.rows).toEqual([{ zone: ZONE_NORTH, store: STORE_A_Y }]);
    const fan = await env!.admin.query<{ store: string }>(`SELECT store_id::text AS store FROM pricing_revision_stores WHERE tenant_id = $1 AND revision_no = $2`, [TENANT_A, revisionNo]);
    expect(fan.rows.map((r) => r.store)).toEqual([STORE_A_Y]);
    expect(await scalar(`SELECT cardinality(result_ids)::text AS v FROM price_change_set_lines WHERE change_set_id = $1`, [set.header.id])).toBe("1");
  });

  it("the authoring gate, roles and two-tenant RLS (HTTP and direct SQL under a mismatched GUC)", async () => {
    if (skip()) return;
    const set = await approved({ items: [bookPrice(P3, "40", "2045-01-01T00:00:00Z")] });
    const id = set.header.id;
    const bodies: Record<string, Record<string, unknown>> = {
      submit: { expectedVersion: 1 },
      approve: { expectedVersion: 1, previewHash: set.header.previewHash, acknowledgedFindings: ALL_ACKS },
      reject: { expectedVersion: 1, reason: "x" },
      publish: { expectedVersion: 1 },
    };
    for (const [action, body] of Object.entries(bodies)) {
      refused(await send(op(id, action), SES_MANAGER, body), 404, "not_found");
      refused(await send(op(id, action), SES_OWNER_B, body), 404, "not_found");
    }
    const config = app!.get<{ tenantIds: Set<string> }>(PRICING_AUTHORING_CONFIG, { strict: false });
    config.tenantIds.delete(TENANT_A);
    const before = await head();
    try {
      for (const action of ["submit", "approve", "reject", "publish"]) {
        refused(await send(op(id, action), SES_OWNER_ALL, { expectedVersion: 1 }), 409, "pricing_authority_legacy");
      }
      expect(await head()).toBe(before);
    } finally {
      config.tenantIds.add(TENANT_A);
    }
    // Direct SQL as the NOBYPASSRLS app role under tenant B's GUC: A's revision rows are invisible,
    // and writing them is refused by tenant context.
    const c = await env!.app.connect();
    let failure: Error | undefined;
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.is_platform_admin', 'false', true)`, [TENANT_B]);
      for (const table of ["pricing_revisions", "pricing_revision_stores", "price_events", "price_zone_memberships"]) {
        const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [TENANT_A]);
        expect({ table, n: r.rows[0]!.n }).toEqual({ table, n: 0 });
      }
      const upd = await c.query(`UPDATE price_events SET state = 'superseded', ended_in_revision = 99 WHERE tenant_id = $1`, [TENANT_A]);
      expect(upd.rowCount).toBe(0);
      await c.query("SAVEPOINT w");
      await expect(
        c.query(
          `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, $3, $4, $4)`,
          [TENANT_A, STORE_A_X, before, ACTOR],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
      await c.query("ROLLBACK TO SAVEPOINT w");
    } finally {
      try {
        await c.query("ROLLBACK");
      } catch (err) {
        failure = err as Error;
      }
      c.release(failure);
    }
    status(await publish(set), 200);
  });
});
