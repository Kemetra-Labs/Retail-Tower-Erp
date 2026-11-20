/**
 * RT-1484 (RT-282 PR-09b) — Price Change Set authoring over HTTP against real Postgres
 * (Testcontainers, every migration including 0121 and 0123, the NOBYPASSRLS `app_test` pool
 * holding only the production pricing grants of `pricing.grants.ts` and
 * `price-change-set-content.grants.ts`) and the real module graph (`SessionOnlyAdminGuard`,
 * `TenantContextGuard`, `RolesGuard`, the shared `IdempotencyInterceptor` over a fake Redis, the
 * real `PRICING_AUTHORING_CONFIG` factory reading `PRICING_AUTHORING_TENANT_ALLOWLIST`). Only
 * cookie authentication is faked.
 *
 * What this proves (`pricing/price-change-sets.yaml` 1.0.0-draft: list, create, get, update,
 * cancel):
 *   - roles: owner / tenant_admin only, reads included; store_manager and store_staff are the
 *     non-disclosing 404; a bearer is 401; a cookie write without `Origin` is 403; a write without
 *     an `Idempotency-Key` is 400;
 *   - the authoring gate: a tenant off the allowlist gets `409 pricing_authority_legacy` on every
 *     write, writing nothing, while its reads stay open;
 *   - create: a draft at version 1 with its sealed item list (0123), one audit row, an idempotent
 *     replay and a key-reuse refusal; `price_book_missing` without a retail Book; 400 for a bad
 *     item, writing nothing;
 *   - update: `version_conflict`, a header-only edit keeps the item list, an items edit writes a
 *     new one, a validated set returns to draft at version + 1 with its preview discarded, a
 *     rollback set's items are refused; one audit row per transition;
 *   - cancel: from draft, validated and pending_approval, keeping the version and the validation
 *     binding; a second cancel and an edit after it are `change_set_invalid_state`;
 *   - list: newest first, filtered, keyset pages, a foreign cursor is 400;
 *   - RLS isolation of two tenants: tenant B never lists, reads, edits or cancels tenant A's sets;
 *   - every body validates against the contract schemas (AJV).
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
import { PRICING_AUTHORING_CONFIG, type PricingAuthoringConfig } from "../../src/pricing/change-sets/price-authoring.config";
import { PriceChangeSetsModule } from "../../src/pricing/change-sets/price-change-sets.module";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { bootScopedApp, SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  DASHBOARD_TOKEN,
  SES_MANAGER,
  SES_STAFF,
  seedConsoleSalesFixture,
} from "../console-sales/__support__/console-sales-fixture";

type Session = string;

const CS = "/api/v1/pricing/change-sets";
const csPath = (id: string): string => `${CS}/${id}`;
const cancelPath = (id: string): string => `${CS}/${id}/cancel`;
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT = "price-change-sets";
const HASH = `sha256:${"b".repeat(64)}`;

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const SES_OWNER_B = b("1484a2");
const ACTOR = a("1484e2");
const ZONE_X = a("14845a");
const PRODUCT_X = a("14845b");
const STORE_X = a("14845c");

const SET_PRICE = {
  op: "set_price",
  scope: { kind: "zone", zoneId: ZONE_X },
  products: { kind: "items", productIds: [PRODUCT_X] },
  price: "125.5000",
  effectiveFrom: "2031-01-01T00:00",
};
const MOVE = { op: "move_store_zone", storeId: STORE_X, zoneId: ZONE_X, effectiveFrom: "2031-01-01T00:00:00Z" };

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
  title: string;
  reason: string | null;
  state: string;
  version: number;
  previewHash: string | null;
  validatedAtRevision: number | null;
  sensitive: boolean | null;
  created: { userId: string; at: string };
  cancelled: { userId: string; at: string } | null;
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

/** A retail Price Book with its default Zone (one transaction: the 0121 deferred check). */
async function seedBook(tenantId: string, bookId: string, zoneId: string): Promise<void> {
  const c = await env!.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, pricing_context, is_default,
                                created_by_user_id, correlation_id)
       VALUES ($1, $2, 'RETAIL', 'Retail', 'EGP', 'inclusive', 'retail', true, $3, $1)`,
      [bookId, tenantId, ACTOR],
    );
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'DEFAULT', 'Default', true, $4, $1)`,
      [zoneId, tenantId, bookId, ACTOR],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Sets in states this slice cannot reach yet (validate, submit and publish are later slices),
 * seeded by the superuser with triggers off: a `validated` and a `pending_approval` set, each
 * with its item list and validation at version 2, and a published set with a draft rollback set.
 */
async function seedLaterStates(): Promise<{ validated: string; pending: string; rollback: string }> {
  const ids = { validated: a("14840d1"), pending: a("14840d2"), published: a("14840d3"), rollback: a("14840d4") };
  const c = await env!.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    for (const [id, state] of [[ids.validated, "validated"], [ids.pending, "pending_approval"]] as const) {
      const submitted = state === "pending_approval";
      await c.query(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, version, validated_at_revision, preview_hash,
                                  target_store_set_hash, sensitive, sensitivity_reasons, created_by_user_id, correlation_id,
                                  submitted_by_user_id, submitted_at)
         VALUES ($1, $2, 'pricing', 'standard', $3, $3, 2, 0, $4, $4, true, '{approval_mode_always}', $5, $1, $6, $7)`,
        [id, TENANT_A, state, HASH, ACTOR, submitted ? ACTOR : null, submitted ? new Date() : null],
      );
      await c.query(
        `INSERT INTO price_change_set_item_lists (tenant_id, change_set_id, change_set_version, item_count, created_by_user_id, correlation_id)
         VALUES ($1, $2, 2, 1, $3, $2)`,
        [TENANT_A, id, ACTOR],
      );
      await c.query(
        `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
         VALUES ($1, $2, 2, 1, 'set_price', $3::jsonb, $4, $2)`,
        [TENANT_A, id, JSON.stringify(SET_PRICE), ACTOR],
      );
      const summary = {
        lines: 1, stores: 1, devices: 0, products: 1, increases: 1, decreases: 0, unchanged: 0,
        maxIncreasePct: "5.00", maxDecreasePct: null, earliestEffectiveAt: "2031-01-01T00:00:00+02:00",
        findings: { replaces: 0, shadowed: 0, invalidates_dependent: 0, conflicts_pending: 0, past_dated: 0, invalid: 0 },
        blocking: false,
      };
      await c.query(
        `INSERT INTO price_change_set_validations
           (tenant_id, change_set_id, change_set_version, item_list_version, validated_at_revision, preview_hash,
            target_store_set_hash, sensitive, sensitivity_reasons, summary, target_stores, line_count, preview_line_count,
            membership_change_count, created_by_user_id, correlation_id)
         VALUES ($1, $2, 2, 2, 0, $3, $3, true, '{approval_mode_always}', $4::jsonb, '[]'::jsonb, 1, 1, 0, $5, $2)`,
        [TENANT_A, id, HASH, JSON.stringify(summary), ACTOR],
      );
    }
    await c.query(
      `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, revision_no, created_by_user_id, correlation_id,
                                published_by_user_id, published_at, validated_at_revision, preview_hash,
                                target_store_set_hash, sensitive, approved_by_user_id, approved_at)
       VALUES ($1, $2, 'pricing', 'standard', 'published', 'published', 1, $3, $1, $3, now(), 0, $4, $4, false, $3, now())`,
      [ids.published, TENANT_A, ACTOR, HASH],
    );
    await c.query(
      `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, rolls_back_change_set_id, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'pricing', 'rollback', 'rollback', 'undo', $3, $4, $1)`,
      [ids.rollback, TENANT_A, ids.published, ACTOR],
    );
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  return { validated: ids.validated, pending: ids.pending, rollback: ids.rollback };
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
      console.warn(`\n[RT-1484 price change sets] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-cs-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("1484b2"),
    email: "rt1484-cs-owner-b@example.test",
    membershipId: b("1484c2"),
    roleId: b("1484d2"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
  await seedBook(TENANT_A, a("14846a"), a("14846b"));
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
  // The real factory reads the allowlist at boot: both tenants, one entry upper-cased.
  process.env["PRICING_AUTHORING_TENANT_ALLOWLIST"] = ` ${TENANT_A}, ${TENANT_B.toUpperCase()} `;
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
    console.warn("[RT-1484 price change sets] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function expectValid(name: string, body: unknown): void {
  const v = schema(name);
  if (!v(body)) throw new Error(`${name} contract violation: ${JSON.stringify(v.errors)} in ${JSON.stringify(body)}`);
}

function get(path: string, session: Session | null): request.Test {
  const req = request(app!.getHttpServer()).get(path);
  return session === null ? req : req.set("x-test-session", session);
}

function send(method: "post" | "patch", path: string, session: Session | null, body: unknown, idemKey: string | null = key()): request.Test {
  let req = request(app!.getHttpServer())[method](path).set("Origin", ORIGIN).send(body as object);
  if (idemKey !== null) req = req.set("Idempotency-Key", idemKey);
  return session === null ? req : req.set("x-test-session", session);
}
const post = (path: string, session: Session | null, body: unknown, idemKey?: string | null): request.Test =>
  send("post", path, session, body, idemKey);
const patch = (path: string, session: Session | null, body: unknown, idemKey?: string | null): request.Test =>
  send("patch", path, session, body, idemKey);

function key(): string {
  seq += 1;
  return `rt1484-cs-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
}

function expectStatus(res: request.Response, status: number): void {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
}

function refused(res: request.Response, status: number, code: string): void {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

async function created(session: Session, body: unknown): Promise<ChangeSet> {
  const res = await post(CS, session, body);
  expectStatus(res, 201);
  expectValid("PriceChangeSet", res.body);
  return res.body as ChangeSet;
}

async function audits(action: string, targetId: string): Promise<{ actor_user_id: string; metadata: Record<string, unknown> }[]> {
  const r = await env!.admin.query(
    `SELECT actor_user_id::text, metadata FROM audit_events WHERE action = $1 AND target_id = $2::uuid ORDER BY id`,
    [action, targetId],
  );
  return r.rows as { actor_user_id: string; metadata: Record<string, unknown> }[];
}

async function countSets(tenantId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM change_sets WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0]!.n);
}

async function itemLists(id: string): Promise<{ v: number; n: number }[]> {
  const r = await env!.admin.query<{ v: number; n: number }>(
    `SELECT change_set_version AS v, item_count AS n FROM price_change_set_item_lists WHERE change_set_id = $1 ORDER BY 1`,
    [id],
  );
  return r.rows;
}

function authoringConfig(): { tenantIds: Set<string> } {
  return app!.get<PricingAuthoringConfig>(PRICING_AUTHORING_CONFIG, { strict: false }) as unknown as { tenantIds: Set<string> };
}

describe("RT-1484 price change sets over HTTP", () => {
  let draft: ChangeSet;
  let later: { validated: string; pending: string; rollback: string };

  it("refuses a disallowed role, a bearer, a missing Origin and a missing key, writing nothing", async () => {
    if (skip()) return;
    const body = { kind: "standard", title: "Winter" };
    for (const s of [SES_MANAGER, SES_STAFF]) {
      const write = await post(CS, s, body);
      expect(write.status).toBe(404);
      expect(write.body.error).toMatchObject(NOT_FOUND);
      expect((await get(CS, s)).body.error).toMatchObject(NOT_FOUND);
    }
    const bearer = await request(app!.getHttpServer())
      .post(CS)
      .set("Origin", ORIGIN)
      .set("Authorization", `Bearer ${DASHBOARD_TOKEN}`)
      .set("Idempotency-Key", key())
      .send(body);
    expect(bearer.status).toBe(401);
    const noOrigin = await request(app!.getHttpServer())
      .post(CS)
      .set("Cookie", "dp2_session=rt1484-not-a-session")
      .set("Idempotency-Key", key())
      .send(body);
    refused(noOrigin, 403, "origin_rejected");
    expect((await post(CS, SES_OWNER_ALL, body, null)).status).toBe(400);
    refused(await post(CS, SES_OWNER_ALL, { ...body, items: [{ ...SET_PRICE, price: 1.5 }] }), 400, "validation_error");
    refused(await post(CS, SES_OWNER_ALL, { ...body, items: [{ ...SET_PRICE, effectiveTo: "2030-12-31T00:00" }] }), 400, "validation_error");
    refused(await post(CS, SES_OWNER_ALL, { kind: "emergency", title: "E" }), 400, "validation_error");
    refused(await get(csPath("not-a-uuid"), SES_OWNER_ALL), 400, "validation_error");
    expect(await countSets(TENANT_A)).toBe(0);
  });

  it("creates a draft with its item list and one audit row, and replays it on the same key", async () => {
    if (skip()) return;
    const body = { kind: "standard", title: "Winter prices", items: [SET_PRICE, MOVE] };
    const k = key();
    const res = await post(CS, SES_OWNER_ALL, body, k);
    expectStatus(res, 201);
    expectValid("PriceChangeSet", res.body);
    draft = res.body as ChangeSet;
    expect(draft.header).toMatchObject({
      kind: "standard",
      title: "Winter prices",
      reason: null,
      state: "draft",
      version: 1,
      previewHash: null,
      validatedAtRevision: null,
      sensitive: null,
      created: { userId: expect.any(String) },
    });
    expect(draft.items).toEqual([SET_PRICE, MOVE]);
    expect(draft.summary).toBeNull();
    expect(res.headers["idempotent-replayed"]).toBeUndefined();

    const replay = await post(CS, SES_OWNER_ALL, body, k);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(res.body);
    refused(await post(CS, SES_OWNER_ALL, { ...body, title: "Other" }, k), 409, "idempotency_key_conflict");

    expect(await countSets(TENANT_A)).toBe(1);
    expect(await itemLists(draft.header.id)).toEqual([{ v: 1, n: 2 }]);
    const rows = await audits("pricing.change_set.created", draft.header.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ change_set_id: draft.header.id, kind: "standard", version: 1, reason_present: false, item_count: 2 });
    expect(rows[0]!.actor_user_id).toBe(draft.header.created.userId);
  });

  it("a tenant_admin authors too; an emergency set needs its reason; an empty set has an empty list", async () => {
    if (skip()) return;
    const e = await created(SES_ADMIN_SPEC, { kind: "emergency", title: "Recall", reason: "Wrong shelf price" });
    expect(e.header).toMatchObject({ kind: "emergency", reason: "Wrong shelf price", state: "draft", version: 1 });
    expect(e.items).toEqual([]);
    expect(await itemLists(e.header.id)).toEqual([{ v: 1, n: 0 }]);
  });

  it("gets a set; edits are versioned (409 version_conflict), header-only keeps the items, items replace them", async () => {
    if (skip()) return;
    const id = draft.header.id;
    const read = await get(csPath(id), SES_OWNER_ALL);
    expectStatus(read, 200);
    expectValid("PriceChangeSet", read.body);
    expect(read.body).toEqual(draft);

    refused(await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 2, title: "Late" }), 409, "version_conflict");
    refused(await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 1 }), 400, "validation_error");

    const k = key();
    const renamed = await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 1, title: "Winter 2031", reason: "Season" }, k);
    expectStatus(renamed, 200);
    expectValid("PriceChangeSet", renamed.body);
    expect((renamed.body as ChangeSet).header).toMatchObject({ title: "Winter 2031", reason: "Season", version: 2, state: "draft" });
    expect((renamed.body as ChangeSet).items).toEqual([SET_PRICE, MOVE]);
    const replay = await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 1, title: "Winter 2031", reason: "Season" }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    const replaced = await patch(csPath(id), SES_ADMIN_SPEC, { expectedVersion: 2, items: [SET_PRICE] });
    expectStatus(replaced, 200);
    expectValid("PriceChangeSet", replaced.body);
    expect((replaced.body as ChangeSet).header.version).toBe(3);
    expect((replaced.body as ChangeSet).items).toEqual([SET_PRICE]);
    expect(await itemLists(id)).toEqual([{ v: 1, n: 2 }, { v: 3, n: 1 }]);

    const emptied = await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 3, items: [] });
    expect((emptied.body as ChangeSet).items).toEqual([]);
    draft = emptied.body as ChangeSet;

    const rows = await audits("pricing.change_set.updated", id);
    expect(rows.map((r) => r.metadata)).toEqual([
      expect.objectContaining({ version: 2, previous_version: 1, previous_state: "draft", items_replaced: false, title_changed: true, reason_changed: true }),
      expect.objectContaining({ version: 3, previous_version: 2, items_replaced: true, item_count: 1 }),
      expect.objectContaining({ version: 4, previous_version: 3, items_replaced: true, item_count: 0 }),
    ]);
  });

  it("an edit returns a validated set to draft at version + 1 and discards its preview; a rollback set keeps its items", async () => {
    if (skip()) return;
    later = await seedLaterStates();
    const before = await get(csPath(later.validated), SES_OWNER_ALL);
    expectStatus(before, 200);
    expectValid("PriceChangeSet", before.body);
    expect((before.body as ChangeSet).header).toMatchObject({ state: "validated", version: 2, previewHash: HASH, sensitive: true });
    expect((before.body as ChangeSet).summary).toMatchObject({ lines: 1, blocking: false });

    const edited = await patch(csPath(later.validated), SES_OWNER_ALL, { expectedVersion: 2, title: "Re-scoped" });
    expectStatus(edited, 200);
    expectValid("PriceChangeSet", edited.body);
    const body = edited.body as ChangeSet;
    expect(body.header).toMatchObject({ state: "draft", version: 3, previewHash: null, validatedAtRevision: null, sensitive: null });
    expect(body.summary).toBeNull();
    expect(body.items).toEqual([SET_PRICE]);
    expect((await audits("pricing.change_set.updated", later.validated))[0]!.metadata).toMatchObject({ previous_state: "validated", version: 3 });

    refused(await patch(csPath(later.rollback), SES_OWNER_ALL, { expectedVersion: 1, items: [] }), 409, "change_set_invalid_state");
    const retitled = await patch(csPath(later.rollback), SES_OWNER_ALL, { expectedVersion: 1, title: "Undo winter" });
    expectStatus(retitled, 200);
    expectValid("PriceChangeSet", retitled.body);
    expect((retitled.body as ChangeSet).header).toMatchObject({ kind: "rollback", title: "Undo winter", version: 2 });
    refused(await patch(csPath(later.pending), SES_OWNER_ALL, { expectedVersion: 2, title: "No" }), 409, "change_set_invalid_state");
  });

  it("cancels from draft and pending_approval, keeping the version and the validation binding", async () => {
    if (skip()) return;
    const id = draft.header.id;
    refused(await post(cancelPath(id), SES_OWNER_ALL, { expectedVersion: 3 }), 409, "version_conflict");
    const k = key();
    const res = await post(cancelPath(id), SES_OWNER_ALL, { expectedVersion: 4 }, k);
    expectStatus(res, 200);
    expectValid("PriceChangeSet", res.body);
    expect((res.body as ChangeSet).header).toMatchObject({ state: "cancelled", version: 4, cancelled: { userId: draft.header.created.userId } });
    const replay = await post(cancelPath(id), SES_OWNER_ALL, { expectedVersion: 4 }, k);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    refused(await post(cancelPath(id), SES_OWNER_ALL, { expectedVersion: 4 }), 409, "change_set_invalid_state");
    refused(await patch(csPath(id), SES_OWNER_ALL, { expectedVersion: 4, title: "Back" }), 409, "change_set_invalid_state");

    const pending = await post(cancelPath(later.pending), SES_ADMIN_SPEC, { expectedVersion: 2 });
    expectStatus(pending, 200);
    expectValid("PriceChangeSet", pending.body);
    expect((pending.body as ChangeSet).header).toMatchObject({ state: "cancelled", version: 2, previewHash: HASH, sensitive: true });
    expect((pending.body as ChangeSet).summary).toMatchObject({ lines: 1 });

    expect((await audits("pricing.change_set.cancelled", id)).map((r) => r.metadata)).toEqual([
      { change_set_id: id, kind: "standard", version: 4, previous_state: "draft", preview_hash: null, reason_present: true },
    ]);
    expect((await audits("pricing.change_set.cancelled", later.pending))[0]!.metadata).toMatchObject({
      previous_state: "pending_approval",
      preview_hash: HASH,
    });
  });

  it("lists newest first, filtered and keyset paged; a foreign cursor is 400", async () => {
    if (skip()) return;
    const all = await get(CS, SES_OWNER_ALL);
    expectStatus(all, 200);
    expectValid("PriceChangeSetPage", all.body);
    const items = (all.body as { items: Header[] }).items;
    expect(items.length).toBe(6);
    const keys = items.map((h) => `${h.created.at}|${h.id}`);
    expect([...keys].sort().reverse()).toEqual(keys);

    const cancelled = await get(`${CS}?state=cancelled`, SES_OWNER_ALL);
    expect((cancelled.body as { items: Header[] }).items.map((h) => h.state)).toEqual(["cancelled", "cancelled"]);
    const rollbacks = await get(`${CS}?kind=rollback`, SES_OWNER_ALL);
    expect((rollbacks.body as { items: Header[] }).items.map((h) => h.id)).toEqual([later.rollback]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await get(`${CS}?page_size=4${cursor ? `&cursor=${cursor}` : ""}`, SES_OWNER_ALL);
      expectStatus(page, 200);
      expectValid("PriceChangeSetPage", page.body);
      seen.push(...(page.body as { items: Header[] }).items.map((h) => h.id));
      cursor = (page.body as { nextCursor: string | null }).nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(items.map((h) => h.id));

    const first = await get(`${CS}?page_size=1`, SES_OWNER_ALL);
    const next = (first.body as { nextCursor: string }).nextCursor;
    refused(await get(`${CS}?page_size=1&state=draft&cursor=${next}`, SES_OWNER_ALL), 400, "validation_error");
    refused(await get(`${CS}?cursor=bm90LW91cnM`, SES_OWNER_ALL), 400, "validation_error");
  });

  it("isolates tenants: B never lists, reads, edits or cancels A's sets; B needs its own Book", async () => {
    if (skip()) return;
    const list = await get(CS, SES_OWNER_B);
    expectStatus(list, 200);
    expect(list.body).toEqual({ items: [], nextCursor: null });
    refused(await get(csPath(later.validated), SES_OWNER_B), 404, "not_found");
    refused(await patch(csPath(later.validated), SES_OWNER_B, { expectedVersion: 3, title: "Mine" }), 404, "not_found");
    refused(await post(cancelPath(later.validated), SES_OWNER_B, { expectedVersion: 3 }), 404, "not_found");
    refused(await post(CS, SES_OWNER_B, { kind: "standard", title: "B" }), 409, "price_book_missing");
    expect(await countSets(TENANT_B)).toBe(0);
    await seedBook(TENANT_B, b("14846a"), b("14846b"));
    const own = await created(SES_OWNER_B, { kind: "standard", title: "B prices", items: [SET_PRICE] });
    expect((await get(CS, SES_OWNER_ALL)).body.items.map((h: Header) => h.id)).not.toContain(own.header.id);
    refused(await get(csPath(own.header.id), SES_OWNER_ALL), 404, "not_found");
    const a1 = await get(csPath(later.validated), SES_OWNER_ALL);
    expect((a1.body as ChangeSet).header.title).toBe("Re-scoped");
  });

  it("the authoring gate: off the allowlist every write is 409 pricing_authority_legacy, reads stay open", async () => {
    if (skip()) return;
    const config = authoringConfig();
    expect(config.tenantIds.has(TENANT_B)).toBe(true);
    const own = (await get(CS, SES_OWNER_B)).body.items[0] as Header;
    config.tenantIds.delete(TENANT_B);
    try {
      const before = await countSets(TENANT_B);
      refused(await post(CS, SES_OWNER_B, { kind: "standard", title: "Blocked" }), 409, "pricing_authority_legacy");
      refused(await patch(csPath(own.id), SES_OWNER_B, { expectedVersion: own.version, title: "Blocked" }), 409, "pricing_authority_legacy");
      refused(await post(cancelPath(own.id), SES_OWNER_B, { expectedVersion: own.version }), 409, "pricing_authority_legacy");
      expect(await countSets(TENANT_B)).toBe(before);
      const read = await get(csPath(own.id), SES_OWNER_B);
      expectStatus(read, 200);
      expect((read.body as ChangeSet).header).toMatchObject({ title: "B prices", version: own.version, state: "draft" });
      expectStatus(await get(CS, SES_OWNER_B), 200);
      expect(await audits("pricing.change_set.updated", own.id)).toEqual([]);
      // Tenant A is unaffected.
      expect((await post(CS, SES_OWNER_ALL, { kind: "standard", title: "A still authors" })).status).toBe(201);
    } finally {
      config.tenantIds.add(TENANT_B);
    }
  });
});
