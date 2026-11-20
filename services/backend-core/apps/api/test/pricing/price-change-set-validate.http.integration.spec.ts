/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — Price Change Set validate and preview over HTTP against real
 * Postgres (Testcontainers, every migration including 0121 and 0123, the NOBYPASSRLS `app_test`
 * pool holding only the production pricing grants of `pricing.grants.ts` and
 * `price-change-set-content.grants.ts`) and the real module graph (`SessionOnlyAdminGuard`,
 * `TenantContextGuard`, `RolesGuard`, `PricingAuthoringGuard`, the shared `IdempotencyInterceptor`
 * over a fake Redis, the real `PRICING_AUTHORING_CONFIG` factory). Only cookie authentication is
 * faked. Published pricing (revisions 1 and 2) is seeded by the superuser with triggers off: the
 * publish runtime is a later slice.
 *
 *   rev 1 (legacy_import)  book P1 100.0000 from 2030-01-01Z
 *   rev 2 (standard)       store STORE_A_X P1 90.0000 from 2030-01-01Z
 *                          store STORE_A_X P3 40.0000 from 2030-01-01Z
 *                          store STORE_A_Y P4 95.0000 from 2032-01-01Z, published by an
 *                            `adjust_amount` line (a helper event)
 *                          membership STORE_A_Y → NORTH from 2031-06-01Z
 *
 * What this proves (`pricing/price-change-sets.yaml` validate and preview; RT-1484 comments 17881
 * and 17882):
 *   - every finding class, each line taking its most severe one: `replaces`, `conflicts_pending`
 *     (another validated set), `shadowed`, `invalidates_dependent`, `past_dated`, `invalid`, `new`;
 *     an unchanged line is dropped and counted; a Zone move stores its membership change;
 *   - the 0123 rows: one validation, its lines, preview rows and membership change, in the
 *     transaction that moves the set to `validated` at the same version;
 *   - `422 change_set_no_target_store` (naming the item's position) and `422 change_set_empty`
 *     store nothing; a stale version is `409 version_conflict`, a validated set `409
 *     change_set_invalid_state`, a draft's preview `409 change_set_not_validated`;
 *   - the preview: keyset pages, the class filter, a foreign cursor is 400; a stable
 *     `previewHash` across an edit and a re-validation;
 *   - idempotent replay; the allowlist refusal on validate (nothing written); roles; two-tenant RLS;
 *   - the PR-4a follow-ups: a cancel from `validated` keeps `previewHash` and `summary`; two
 *     parallel PATCHes give one 200 and one 409; a `legacy_import` set is never edited or
 *     cancelled (409); audit rows carry `reason_present` and `kind`, never the reason;
 *   - every body validates against the contract schemas (AJV).
 * `stale_validation` and `preview_changed` belong to submit and approve (later slices): validate
 * and preview cannot return them.
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
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../src/idempotency/in-progress-marker";
import { PRICING_AUTHORING_CONFIG, type PricingAuthoringConfig } from "../../src/pricing/change-sets/price-authoring.config";
import { PriceChangeSetsModule } from "../../src/pricing/change-sets/price-change-sets.module";
import { PriceStructureService } from "../../src/pricing/structure/price-structure.service";
import type { MembershipRepository } from "../../src/context";
import { seedConsoleMember } from "../_helpers/console-members";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";
import { APP_ROLE_NAME, applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import {
  CATEGORY_A,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  STORE_B_Y,
  TENANT_A,
  TENANT_B,
} from "../catalog/__support__/isolation-harness";
import { bootScopedApp, SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SES_MANAGER, seedConsoleSalesFixture } from "../console-sales/__support__/console-sales-fixture";

type Session = string;

const CS = "/api/v1/pricing/change-sets";
const csPath = (id: string): string => `${CS}/${id}`;
const validatePath = (id: string): string => `${CS}/${id}/validate`;
const previewPath = (id: string, query = ""): string => `${CS}/${id}/preview${query}`;
const ORIGIN = "http://127.0.0.1";
const CONTRACT = "price-change-sets";
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const b = (tag: string): string => `0b000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const SES_OWNER_B = b("14b4a2");
const ACTOR = a("14b4e2");
const BOOK = a("14b4b0");
const ZONE_DEFAULT = a("14b4d0");
const ZONE_NORTH = a("14b4d1");
const ZONE_SOUTH = a("14b4d2");
const P1 = PRODUCT_A_ACTIVE;
const P2 = PRODUCT_A_RETIRED;
const P3 = a("14b4f3");
const P4 = a("14b4f4");
const P5 = a("14b4f5");
const P6 = a("14b4f6");
const CS_LEGACY = a("14b4c1");
const CS_REV2 = a("14b4c2");
const CS_LEGACY_DRAFT = b("14b4c3");
const E = {
  bookP1: a("14b4e101"),
  storeXP1: a("14b4e102"),
  storeXP3: a("14b4e103"),
  helperYP4: a("14b4e104"),
  northP5a: a("14b4e105"),
  northP5b: a("14b4e106"),
  bookP6early: a("14b4e107"),
  bookP6late: a("14b4e108"),
};
const M_Y_NORTH = a("14b4a101");
const M_X_SOUTH = a("14b4a102");
const B_BOOK = b("14b4b0");
const B_ZONE = b("14b4d0");

const at = (instant: string) => ({ timeBasis: "absolute", effectiveFrom: instant });
const items = (productIds: string[]) => ({ kind: "items", productIds });

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
  sensitive: boolean | null;
  sensitivityReasons: string[];
}
interface ChangeSet {
  header: Header;
  items: Record<string, unknown>[];
  summary: Record<string, unknown> | null;
}
interface PreviewLine {
  storeId: string;
  productId: string;
  oldPrice: string | null;
  oldSourceScope: string | null;
  newPrice: string | null;
  newSourceScope: string | null;
  deltaPct: string | null;
  effectiveFrom: string;
  class: string;
  devices: number;
  messages: string[];
}
interface Preview {
  changeSetId: string;
  version: number;
  validatedAtRevision: number;
  previewHash: string;
  summary: Record<string, unknown>;
  membershipChanges: Record<string, unknown>[];
  lines: PreviewLine[];
  nextCursor: string | null;
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

async function seedEvent(
  c: PoolClient,
  e: { id: string; scope: string; zone?: string; store?: string; product: string; price: string; from: string; to?: string; rev: number; cs: string },
): Promise<void> {
  await c.query(
    `INSERT INTO price_events
       (id, tenant_id, price_book_id, scope, price_zone_id, store_id, product_id, price, currency_code, time_basis,
        effective_from, effective_to, state, published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EGP', 'absolute', $9, $10, 'active', $11, $12, 'change_set', $13, $1)`,
    [e.id, TENANT_A, BOOK, e.scope, e.zone ?? null, e.store ?? null, e.product, e.price, e.from, e.to ?? null, e.rev, e.cs, ACTOR],
  );
}

/** Revision 1 (legacy import) and 2 (a standard publish whose helper line published E.helperYP4). */
async function seedPublishedPricing(): Promise<void> {
  await env!.admin.query(`UPDATE stores SET timezone = 'UTC' WHERE id = $1`, [STORE_A_X]);
  await env!.admin.query(`UPDATE stores SET timezone = 'America/New_York' WHERE id = $1`, [STORE_A_Y]);
  await env!.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'RT-1484 P3', 'standard', $4, $4), ($2, $3, 'RT-1484 P4', 'standard', $4, $4),
            ($5, $3, 'RT-1484 P5', 'standard', $4, $4), ($6, $3, 'RT-1484 P6', 'standard', $4, $4)`,
    [P3, P4, TENANT_A, ACTOR, P5, P6],
  );
  const hash = `sha256:${"a".repeat(64)}`;
  await asSeeder(async (c) => {
    await c.query(
      `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'RETAIL', 'Retail', 'EGP', 'inclusive', $3, $1)`,
      [BOOK, TENANT_A, ACTOR],
    );
    for (const [zone, code, isDefault] of [[ZONE_DEFAULT, "DEFAULT", true], [ZONE_NORTH, "NORTH", false], [ZONE_SOUTH, "SOUTH", false]] as const) {
      await c.query(
        `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $1)`,
        [zone, TENANT_A, BOOK, code, isDefault, ACTOR],
      );
    }
    for (const [n, cs, kind] of [[1, CS_LEGACY, "legacy_import"], [2, CS_REV2, "standard"]] as const) {
      const legacy = kind === "legacy_import";
      await c.query(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, revision_no, created_by_user_id, correlation_id,
                                  published_by_user_id, published_at, validated_at_revision, preview_hash,
                                  target_store_set_hash, sensitive, approved_by_user_id, approved_at)
         VALUES ($1, $2, 'pricing', $3, 'seed', 'published', $4, $5, $1, $5, now(), $6, $7, $7, $8, $9, $10)`,
        [cs, TENANT_A, kind, n, ACTOR, legacy ? null : 1, legacy ? null : hash, legacy ? null : false, legacy ? null : ACTOR, legacy ? null : new Date()],
      );
      await c.query(
        `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $3)`,
        [TENANT_A, n, cs, legacy ? "legacy_import" : "publish", ACTOR],
      );
    }
    await seedEvent(c, { id: E.bookP1, scope: "book", product: P1, price: "100.0000", from: "2030-01-01T00:00:00Z", rev: 1, cs: CS_LEGACY });
    await seedEvent(c, { id: E.storeXP1, scope: "store", store: STORE_A_X, product: P1, price: "90.0000", from: "2030-01-01T00:00:00Z", rev: 2, cs: CS_REV2 });
    await seedEvent(c, { id: E.storeXP3, scope: "store", store: STORE_A_X, product: P3, price: "40.0000", from: "2030-01-01T00:00:00Z", rev: 2, cs: CS_REV2 });
    await seedEvent(c, { id: E.helperYP4, scope: "store", store: STORE_A_Y, product: P4, price: "95.0000", from: "2032-01-01T00:00:00Z", rev: 2, cs: CS_REV2 });
    // Two NORTH helper events of P5: at 2035 X is in the default Zone, at 2041 X is in SOUTH (M3).
    await seedEvent(c, { id: E.northP5a, scope: "zone", zone: ZONE_NORTH, product: P5, price: "30.0000", from: "2035-01-01T00:00:00Z", to: "2040-01-01T00:00:00Z", rev: 2, cs: CS_REV2 });
    await seedEvent(c, { id: E.northP5b, scope: "zone", zone: ZONE_NORTH, product: P5, price: "31.0000", from: "2041-01-01T00:00:00Z", rev: 2, cs: CS_REV2 });
    // P6's Book price changes at 02:00Z: midnight is 00:00Z at X (UTC) and 05:00Z at Y (New York).
    await seedEvent(c, { id: E.bookP6early, scope: "book", product: P6, price: "10.0000", from: "2030-01-01T00:00:00Z", to: "2031-03-01T02:00:00Z", rev: 2, cs: CS_REV2 });
    await seedEvent(c, { id: E.bookP6late, scope: "book", product: P6, price: "20.0000", from: "2031-03-01T02:00:00Z", rev: 2, cs: CS_REV2 });
    for (const [id, zone, store, from] of [[M_Y_NORTH, ZONE_NORTH, STORE_A_Y, "2031-06-01T00:00:00Z"], [M_X_SOUTH, ZONE_SOUTH, STORE_A_X, "2040-01-01T00:00:00Z"]] as const) {
      await c.query(
        `INSERT INTO price_zone_memberships (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, state,
                                             published_in_revision, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 2, $7, $1)`,
        [id, TENANT_A, BOOK, zone, store, from, ACTOR],
      );
    }
    // Revision 2's record: the helper line that became E.helperYP4 (invalidates_dependent).
    const helperItem = { op: "adjust_amount", scope: { kind: "stores", storeIds: [STORE_A_Y] }, products: items([P4]), amount: "5", ...at("2032-01-01T00:00:00Z") };
    await c.query(
      `INSERT INTO price_change_set_item_lists (tenant_id, change_set_id, change_set_version, item_count, created_by_user_id, correlation_id)
       VALUES ($1, $2, 1, 1, $3, $2)`,
      [TENANT_A, CS_REV2, ACTOR],
    );
    await c.query(
      `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
       VALUES ($1, $2, 1, 1, 'adjust_amount', $3::jsonb, $4, $2)`,
      [TENANT_A, CS_REV2, JSON.stringify(helperItem), ACTOR],
    );
    const summary = {
      lines: 1, stores: 1, devices: 0, products: 1, increases: 0, decreases: 0, unchanged: 0, maxIncreasePct: null, maxDecreasePct: null,
      earliestEffectiveAt: null, findings: { replaces: 0, shadowed: 0, invalidates_dependent: 0, conflicts_pending: 0, past_dated: 0, invalid: 0 }, blocking: false,
    };
    await c.query(
      `INSERT INTO price_change_set_validations
         (tenant_id, change_set_id, change_set_version, item_list_version, validated_at_revision, preview_hash, target_store_set_hash,
          sensitive, summary, target_stores, line_count, preview_line_count, membership_change_count, created_by_user_id, correlation_id)
       VALUES ($1, $2, 1, 1, 1, $3, $3, false, $4::jsonb, '[]'::jsonb, 3, 0, 0, $5, $2)`,
      [TENANT_A, CS_REV2, hash, JSON.stringify(summary), ACTOR],
    );
    await c.query(
      `INSERT INTO price_change_set_lines
         (tenant_id, change_set_id, change_set_version, line_no, item_list_version, item_position, op, scope, price_book_id,
          store_id, product_id, sell_unit, time_basis, effective_from, new_price, class, new_event_id, created_by_user_id, correlation_id)
       VALUES ($1, $2, 1, 1, 1, 1, 'adjust_amount', 'store', $3, $4, $5, 'each', 'absolute', '2032-01-01T00:00:00Z', 95, 'new', $6, $7, $2)`,
      [TENANT_A, CS_REV2, BOOK, STORE_A_Y, P4, E.helperYP4, ACTOR],
    );
    for (const [lineNo, eventId, price, from] of [[2, E.northP5a, 30, "2035-01-01T00:00:00Z"], [3, E.northP5b, 31, "2041-01-01T00:00:00Z"]] as const) {
      await c.query(
        `INSERT INTO price_change_set_lines
           (tenant_id, change_set_id, change_set_version, line_no, item_list_version, item_position, op, scope, price_book_id,
            price_zone_id, product_id, sell_unit, time_basis, effective_from, new_price, class, new_event_id, created_by_user_id, correlation_id)
         VALUES ($1, $2, 1, $3, 1, 1, 'adjust_percent', 'zone', $4, $5, $6, 'each', 'absolute', $7, $8, 'new', $9, $10, $2)`,
        [TENANT_A, CS_REV2, lineNo, BOOK, ZONE_NORTH, P5, from, price, eventId, ACTOR],
      );
    }
    // Tenant B's retail Book (its own validations exist for the direct-SQL RLS case, m4).
    await c.query(
      `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'RETAIL', 'Retail', 'EGP', 'inclusive', $3, $1)`,
      [B_BOOK, TENANT_B, ACTOR],
    );
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'DEFAULT', 'Default', true, $4, $1)`,
      [B_ZONE, TENANT_B, B_BOOK, ACTOR],
    );
    // A draft legacy_import set of tenant B (the RT-1485 path writes it; one per tenant, A has its own).
    await c.query(
      `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id)
       VALUES ($1, $2, 'pricing', 'legacy_import', 'legacy draft', $3, $1)`,
      [CS_LEGACY_DRAFT, TENANT_B, ACTOR],
    );
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
      console.warn(`\n[RT-1484 validate] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConsoleSalesFixture(env);
  await restrictToPricingGrants(env.admin);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt1484-validate-actor@example.test')`, [ACTOR]);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: b("14b4b2"),
    email: "rt1484-validate-owner-b@example.test",
    membershipId: b("14b4c2"),
    roleId: b("14b4d2"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
  await seedPublishedPricing();
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
    console.warn("[RT-1484 validate] skipping — Docker unavailable");
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
  return `rt1484-validate-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

function get(path: string, session: Session): request.Test {
  return request(app!.getHttpServer()).get(path).set("x-test-session", session);
}

function send(method: "post" | "patch", path: string, session: Session, body: unknown, idemKey = key()): request.Test {
  return request(app!.getHttpServer())[method](path).set("Origin", ORIGIN).set("Idempotency-Key", idemKey).set("x-test-session", session).send(body as object);
}

function status(res: request.Response, code: number): void {
  if (res.status !== code) throw new Error(`expected ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
}

function refused(res: request.Response, code: number, errorCode: string): void {
  status(res, code);
  expect((res.body as { error: { code: string } }).error.code).toBe(errorCode);
}

async function createSet(session: Session, body: Record<string, unknown>): Promise<ChangeSet> {
  const res = await send("post", CS, session, { kind: "standard", title: "RT-1484 validate", ...body });
  status(res, 201);
  return res.body as ChangeSet;
}

async function validate(session: Session, set: ChangeSet, idemKey?: string): Promise<request.Response> {
  return send("post", validatePath(set.header.id), session, { expectedVersion: set.header.version }, idemKey);
}

async function validated(session: Session, set: ChangeSet): Promise<ChangeSet> {
  const res = await validate(session, set);
  status(res, 200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid("PriceChangeSet", res.body);
  return res.body as ChangeSet;
}

async function count(table: string, changeSetId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE change_set_id = $1`, [changeSetId]);
  return Number(r.rows[0]!.n);
}

async function allPreview(session: Session, id: string, query = ""): Promise<Preview & { pages: number }> {
  const lines: PreviewLine[] = [];
  let cursor: string | null = null;
  let first: Preview | null = null;
  let pages = 0;
  do {
    const sep = query === "" ? "?" : `${query}&`;
    const res: request.Response = await get(previewPath(id, `${sep}page_size=2${cursor ? `&cursor=${cursor}` : ""}`), session);
    status(res, 200);
    expectValid("PriceChangeSetPreview", res.body);
    const page = res.body as Preview;
    first ??= page;
    lines.push(...page.lines);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null);
  return { ...first!, lines, nextCursor: null, pages };
}

describe("RT-1484 price Change Set validate and preview over HTTP", () => {
  let pending: ChangeSet;
  let main: ChangeSet;

  it("a validated set's line becomes another set's conflicts_pending; alone it is shadowed", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      items: [{ op: "set_price", scope: { kind: "zone", zoneId: ZONE_DEFAULT }, products: items([P3]), price: "52", ...at("2031-02-01T00:00:00Z") }],
    });
    pending = await validated(SES_OWNER_ALL, draft);
    expect(pending.header).toMatchObject({ state: "validated", version: 1, validatedAtRevision: 2, sensitive: true });
    expect(pending.summary).toMatchObject({ lines: 1, findings: { shadowed: 1 }, blocking: false });
    const preview = await allPreview(SES_OWNER_ALL, pending.header.id);
    expect(preview.lines.map((l) => [l.storeId, l.oldPrice, l.newPrice, l.newSourceScope, l.class])).toEqual([
      [STORE_A_X, "40.0000", "40.0000", "store", "shadowed"],
      [STORE_A_Y, null, "52.0000", "zone", "shadowed"],
    ]);
  });

  it("classifies every line by its most severe class, drops the unchanged one and stores the 0123 rows", async () => {
    if (skip()) return;
    main = await createSet(SES_OWNER_ALL, {
      items: [
        // 1 replaces the Book P1 event (shadowed at X by its override, invalidates nothing).
        { op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "120", ...at("2031-01-01T00:00:00Z") },
        // 2 conflicts_pending with the validated set above (and shadowed at X).
        { op: "set_price", scope: { kind: "zone", zoneId: ZONE_DEFAULT.toUpperCase() }, products: items([P3]), price: "50", ...at("2031-01-01T00:00:00Z") },
        // 3 invalidates_dependent: the base of Y's later helper event changes.
        { op: "set_price", scope: { kind: "book" }, products: items([P4]), price: "70", ...at("2031-01-01T00:00:00Z") },
        // 4 past_dated (also replaces X's P3 override).
        { op: "set_price", scope: { kind: "stores", storeIds: [STORE_A_X] }, products: items([P3]), price: "45", ...at("2020-01-01T00:00:00Z") },
        // 5 invalid: a retired product.
        { op: "set_price", scope: { kind: "book" }, products: items([P2]), price: "10", ...at("2031-01-01T00:00:00Z") },
        // 6 new, store_local in New York's DST gap, ending before the helper event.
        { op: "set_price", scope: { kind: "stores", storeIds: [STORE_A_Y] }, products: items([P4]), price: "66", timeBasis: "store_local", effectiveFrom: "2031-03-09T02:30", effectiveTo: "2031-12-01T00:00" },
        // 7 unchanged: the Book already holds 100 over this interval.
        { op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "100.00", ...at("2030-06-01T00:00:00Z"), effectiveTo: "2030-12-01T00:00:00Z" },
        // 8 a Zone move of X into NORTH.
        { op: "move_store_zone", storeId: STORE_A_X, zoneId: ZONE_NORTH, effectiveFrom: "2033-01-01T00:00:00Z" },
      ],
    });
    const k = key();
    const res = await validate(SES_ADMIN_SPEC, main, k);
    status(res, 200);
    expectValid("PriceChangeSet", res.body);
    const body = res.body as ChangeSet;
    expect(body.header).toMatchObject({ id: main.header.id, state: "validated", version: 1, validatedAtRevision: 2, sensitive: true });
    expect(body.header.previewHash).toMatch(HASH_RE);
    expect(body.header.sensitivityReasons).toEqual(["approval_mode_always", "zone_move", "past_dated"]);
    expect(body.summary).toMatchObject({
      lines: 7,
      stores: 2,
      products: 4,
      unchanged: 1,
      blocking: true,
      findings: { replaces: 2, conflicts_pending: 1, invalidates_dependent: 1, past_dated: 1, invalid: 1, shadowed: 0 },
    });

    const lines = await env!.admin.query<{ line_no: number; item_position: number; class: string; messages: string[]; replaced_ids: string[] }>(
      `SELECT line_no, item_position, class, messages, replaced_ids::text[] AS replaced_ids FROM price_change_set_lines
        WHERE change_set_id = $1 ORDER BY line_no`,
      [main.header.id],
    );
    expect(lines.rows.map((l) => [l.line_no, l.item_position, l.class])).toEqual([
      [1, 1, "replaces"],
      [2, 2, "conflicts_pending"],
      [3, 3, "invalidates_dependent"],
      [4, 4, "past_dated"],
      [5, 5, "invalid"],
      [6, 6, "new"],
      // The move supersedes X's later SOUTH membership.
      [7, 8, "replaces"],
    ]);
    expect(lines.rows[0]!.replaced_ids).toEqual([E.bookP1]);
    expect(lines.rows[4]!.messages).toEqual(["product_not_live"]);
    expect(await count("price_change_set_validations", main.header.id)).toBe(1);
    expect(await count("price_change_set_preview_memberships", main.header.id)).toBe(1);

    // Replay: the stored response, nothing written twice.
    const replay = await validate(SES_ADMIN_SPEC, main, k);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(res.body);
    expect(await count("price_change_set_validations", main.header.id)).toBe(1);
    main = body;

    const audit = await env!.admin.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'pricing.change_set.validated' AND target_id = $1`,
      [main.header.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({
      kind: "standard",
      version: 1,
      reason_present: false,
      validated_at_revision: 2,
      preview_hash: main.header.previewHash,
      line_count: 7,
      blocking: true,
    });
  });

  it("serves the preview in pages, filtered by class, with per-Store instants and old and new prices", async () => {
    if (skip()) return;
    const id = main.header.id;
    const all = await allPreview(SES_OWNER_ALL, id);
    expect(all).toMatchObject({ changeSetId: id, version: 1, validatedAtRevision: 2, previewHash: main.header.previewHash });
    expect(all.summary).toEqual(main.summary);
    const keys = all.lines.map((l) => `${l.storeId}|${l.productId}`);
    expect([...keys].sort()).toEqual(keys);
    expect(all.pages).toBeGreaterThan(1);
    expect(all.membershipChanges).toEqual([
      { storeId: STORE_A_X, fromZoneId: null, toZoneId: ZONE_NORTH, effectiveFrom: "2033-01-01T00:00:00Z", effectiveTo: null, supersededMembershipIds: [M_X_SOUTH] },
    ]);
    const row = (store: string, product: string, cls: string) => all.lines.find((l) => l.storeId === store && l.productId === product && l.class === cls)!;
    expect(row(STORE_A_Y, P1, "replaces")).toMatchObject({ oldPrice: "100.0000", oldSourceScope: "book", newPrice: "120.0000", deltaPct: "20.00" });
    expect(row(STORE_A_X, P1, "replaces")).toMatchObject({ oldPrice: "90.0000", newPrice: "90.0000", newSourceScope: "store", devices: 1 });
    expect(row(STORE_A_X, P1, "replaces").messages).toContain("shadowed");
    expect(row(STORE_A_Y, P4, "invalidates_dependent").messages).toContain("invalidates_dependent");
    expect(row(STORE_A_Y, P4, "new")).toMatchObject({ effectiveFrom: "2031-03-09T03:00:00-04:00", newPrice: "66.0000" });
    expect(row(STORE_A_X, P3, "past_dated")).toMatchObject({ effectiveFrom: "2020-01-01T00:00:00Z", oldPrice: null });

    const replaces = await allPreview(SES_OWNER_ALL, id, "?class=replaces");
    expect(new Set(replaces.lines.map((l) => l.class))).toEqual(new Set(["replaces"]));
    expect(replaces.lines).toHaveLength(2);

    const first = await get(previewPath(id, "?page_size=1"), SES_OWNER_ALL);
    const cursor = (first.body as Preview).nextCursor!;
    refused(await get(previewPath(id, `?page_size=1&class=new&cursor=${cursor}`), SES_OWNER_ALL), 400, "validation_error");
    refused(await get(previewPath(pending.header.id, `?page_size=1&cursor=${cursor}`), SES_OWNER_ALL), 400, "validation_error");
    refused(await get(previewPath(id, "?class=nope"), SES_OWNER_ALL), 400, "validation_error");
  });

  it("refuses a stale version, a validated set and a draft's preview; a validated set's edit drops its preview", async () => {
    if (skip()) return;
    refused(await send("post", validatePath(main.header.id), SES_OWNER_ALL, { expectedVersion: 9 }), 409, "version_conflict");
    refused(await validate(SES_OWNER_ALL, main), 409, "change_set_invalid_state");
    const draft = await createSet(SES_OWNER_ALL, {
      items: [{ op: "set_price", scope: { kind: "stores", storeIds: [STORE_A_Y] }, products: items([P1]), price: "77", ...at("2034-01-01T00:00:00Z") }],
    });
    refused(await get(previewPath(draft.header.id), SES_OWNER_ALL), 409, "change_set_not_validated");
  });

  it("the previewHash is stable across an edit and a re-validation of the same items", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      reason: "Shelf audit",
      items: [{ op: "set_price", scope: { kind: "stores", storeIds: [STORE_A_Y] }, products: items([P1]), price: "78", ...at("2034-01-01T00:00:00Z") }],
    });
    const once = await validated(SES_OWNER_ALL, draft);
    const edited = await send("patch", csPath(draft.header.id), SES_OWNER_ALL, { expectedVersion: 1, title: "Renamed" });
    status(edited, 200);
    expect((edited.body as ChangeSet).header).toMatchObject({ state: "draft", version: 2, previewHash: null });
    const twice = await validated(SES_OWNER_ALL, edited.body as ChangeSet);
    expect(twice.header.version).toBe(2);
    expect(twice.header.previewHash).toBe(once.header.previewHash);
    expect(await count("price_change_set_validations", draft.header.id)).toBe(2);

    // RT-1484 comment 17881, follow-up 6: a cancel from validated keeps previewHash and summary.
    const cancelled = await send("post", `${CS}/${draft.header.id}/cancel`, SES_OWNER_ALL, { expectedVersion: 2 });
    status(cancelled, 200);
    expectValid("PriceChangeSet", cancelled.body);
    expect((cancelled.body as ChangeSet).header).toMatchObject({ state: "cancelled", version: 2, previewHash: once.header.previewHash });
    expect((cancelled.body as ChangeSet).summary).toEqual(twice.summary);
    const preview = await get(previewPath(draft.header.id), SES_OWNER_ALL);
    status(preview, 200);
    const audit = await env!.admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY id`,
      [draft.header.id],
    );
    for (const row of audit.rows) {
      expect(row.metadata).toMatchObject({ kind: "standard", reason_present: true });
      expect(JSON.stringify(row.metadata)).not.toContain("Shelf audit");
    }
  });

  it("422 change_set_no_target_store names the item and stores nothing; 422 change_set_empty too", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      items: [
        { op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "1", ...at("2034-01-01T00:00:00Z") },
        // NORTH holds Y only from 2031-06-01: this line ends before it.
        { op: "set_price", scope: { kind: "zone", zoneId: ZONE_NORTH }, products: items([P1]), price: "1", ...at("2031-01-01T00:00:00Z"), effectiveTo: "2031-05-01T00:00:00Z" },
      ],
    });
    const res = await validate(SES_OWNER_ALL, draft);
    refused(res, 422, "change_set_no_target_store");
    expect((res.body as { error: { message: string } }).error.message).toMatch(/^Item 2 /);
    const empty = await createSet(SES_OWNER_ALL, {});
    refused(await validate(SES_OWNER_ALL, empty), 422, "change_set_empty");
    for (const id of [draft.header.id, empty.header.id]) {
      expect(await count("price_change_set_validations", id)).toBe(0);
      expect(await count("price_change_set_lines", id)).toBe(0);
      expect(((await get(csPath(id), SES_OWNER_ALL)).body as ChangeSet).header).toMatchObject({ state: "draft", version: 1 });
    }
  });

  it("roles, two-tenant RLS and the authoring gate on validate (nothing written); reads stay open", async () => {
    if (skip()) return;
    const id = main.header.id;
    refused(await send("post", validatePath(id), SES_MANAGER, { expectedVersion: 1 }), 404, "not_found");
    refused(await get(previewPath(id), SES_MANAGER), 404, "not_found");
    refused(await send("post", validatePath(id), SES_OWNER_B, { expectedVersion: 1 }), 404, "not_found");
    refused(await get(previewPath(id), SES_OWNER_B), 404, "not_found");

    const draft = await createSet(SES_OWNER_ALL, {
      items: [{ op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "130", ...at("2034-01-01T00:00:00Z") }],
    });
    const config = app!.get<PricingAuthoringConfig>(PRICING_AUTHORING_CONFIG, { strict: false }) as unknown as { tenantIds: Set<string> };
    config.tenantIds.delete(TENANT_A);
    try {
      refused(await validate(SES_OWNER_ALL, draft), 409, "pricing_authority_legacy");
      expect(await count("price_change_set_validations", draft.header.id)).toBe(0);
      status(await get(previewPath(id), SES_OWNER_ALL), 200);
    } finally {
      config.tenantIds.add(TENANT_A);
    }
    const ok = await validated(SES_OWNER_ALL, draft);
    expect(ok.header.state).toBe("validated");
  });

  it("two parallel edits of one version: one 200, one 409 (comment 17881, follow-up 6)", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {});
    const [x, y] = await Promise.all([
      send("patch", csPath(draft.header.id), SES_OWNER_ALL, { expectedVersion: 1, title: "X" }),
      send("patch", csPath(draft.header.id), SES_ADMIN_SPEC, { expectedVersion: 1, title: "Y" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe("version_conflict");
  });

  // Review round 1, M1: a set that contradicts itself. The contract keeps a set with blocking
  // lines `validated` (validate "moves the set to validated, even when some lines are blocking");
  // its blocking lines refuse submit (summary.blocking).
  it("M1: overlapping lines of one set (a price and a category helper on one key) are both invalid", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      items: [
        { op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "140", ...at("2034-01-01T00:00:00Z") },
        { op: "adjust_percent", scope: { kind: "book" }, products: { kind: "category", categoryId: CATEGORY_A }, percent: "5", ...at("2034-06-01T00:00:00Z") },
      ],
    });
    const body = await validated(SES_OWNER_ALL, draft);
    expect(body.summary).toMatchObject({ blocking: true, findings: { invalid: 2 } });
    const lines = await env!.admin.query<{ class: string; messages: string[] }>(
      `SELECT class, messages FROM price_change_set_lines WHERE change_set_id = $1 ORDER BY line_no`,
      [draft.header.id],
    );
    expect(lines.rows.map((l) => [l.class, l.messages.includes("overlaps_line_in_set")])).toEqual([
      ["invalid", true],
      ["invalid", true],
    ]);
  });

  it("M1: two overlapping moves of one Store are both invalid", async () => {
    if (skip()) return;
    const move = (from: string) => ({ op: "move_store_zone", storeId: STORE_A_Y, zoneId: ZONE_SOUTH, effectiveFrom: from });
    const body = await validated(SES_OWNER_ALL, await createSet(SES_OWNER_ALL, { items: [move("2036-01-01T00:00:00Z"), move("2037-01-01T00:00:00Z")] }));
    expect(body.summary).toMatchObject({ lines: 2, blocking: true, findings: { invalid: 2 } });
  });

  // Review round 1, M3: a NORTH helper does not flag a Store in SOUTH or in the default Zone.
  it("M3: invalidates_dependent reaches only the Stores a Zone helper serves", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      items: [{ op: "set_price", scope: { kind: "book" }, products: items([P5]), price: "25", ...at("2031-01-01T00:00:00Z") }],
    });
    const body = await validated(SES_OWNER_ALL, draft);
    expect(body.summary).toMatchObject({ findings: { invalidates_dependent: 1 } });
    const preview = await allPreview(SES_OWNER_ALL, draft.header.id);
    const row = (store: string) => preview.lines.find((l) => l.storeId === store)!;
    // Y is in NORTH from 2031-06: both helpers inherit the new Book price.
    expect(row(STORE_A_Y).messages).toContain("invalidates_dependent");
    // X is in the default Zone at 2035 and in SOUTH at 2041: neither helper serves it.
    expect(row(STORE_A_X).messages).not.toContain("invalidates_dependent");
  });

  // Review round 1, m4: RLS at the SQL level, as the NOBYPASSRLS application role.
  it("m4: under tenant A's GUC the app role reads none of tenant B's 0123 rows and cannot write them", async () => {
    if (skip()) return;
    const bSet = await createSet(SES_OWNER_B, {
      items: [{ op: "set_price", scope: { kind: "stores", storeIds: [STORE_B_X] }, products: items([PRODUCT_B_ACTIVE]), price: "9", ...at("2034-01-01T00:00:00Z") }],
    });
    const bValidated = await validated(SES_OWNER_B, bSet);
    expect(bValidated.header.state).toBe("validated");
    const tables = ["price_change_set_validations", "price_change_set_lines", "price_change_set_preview_lines"];
    for (const table of tables) expect(await count(table, bSet.header.id)).toBe(1);
    const c = await env!.app.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.current_tenant', $1, true), set_config('app.is_platform_admin', 'false', true)`, [TENANT_A]);
      for (const table of tables) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE change_set_id = $1`, [bSet.header.id]);
        expect({ table, n: r.rows[0].n }).toEqual({ table, n: 0 });
      }
      const upd = await c.query(`UPDATE price_change_set_lines SET result_ids = result_ids WHERE change_set_id = $1`, [bSet.header.id]);
      expect(upd.rowCount).toBe(0);
      // Round 3, minor 4: a write of tenant B's row under A's GUC is refused by RLS (42501).
      const sqlstate = async (sql: string, params: unknown[]): Promise<{ code: string; message: string }> => {
        await c.query("SAVEPOINT w");
        try {
          await c.query(sql, params);
          return { code: "none", message: "" };
        } catch (err) {
          return { code: (err as { code: string }).code, message: (err as Error).message };
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT w");
        }
      };
      const header = await sqlstate(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id)
         VALUES (gen_random_uuid(), $1, 'pricing', 'standard', 'cross-tenant', $2, gen_random_uuid())`,
        [TENANT_B, ACTOR],
      );
      expect(header.code).toBe("42501");
      expect(header.message).toMatch(/violates row-level security policy/);
      // The 0123 tables refuse too. Their BEFORE INSERT triggers run before the RLS WITH CHECK and,
      // reading through RLS, cannot see B's set or validation, so the trigger's own refusal (23514)
      // comes first; either way nothing of tenant B is written under tenant A.
      const validationRow = await sqlstate(
        `INSERT INTO price_change_set_validations (tenant_id, change_set_id, change_set_version, item_list_version,
            validated_at_revision, preview_hash, target_store_set_hash, sensitive, summary, target_stores, line_count, preview_line_count,
            membership_change_count, created_by_user_id, correlation_id)
          VALUES ($1, $2, 9, 1, 0, $3, $3, true, '{}'::jsonb, '[]'::jsonb, 0, 0, 0, $4, $2)`,
        [TENANT_B, bSet.header.id, `sha256:${"c".repeat(64)}`, ACTOR],
      );
      const listRow = await sqlstate(
        `INSERT INTO price_change_set_item_lists (tenant_id, change_set_id, change_set_version, item_count, created_by_user_id, correlation_id)
         VALUES ($1, $2, 9, 0, $3, $2)`,
        [TENANT_B, bSet.header.id, ACTOR],
      );
      for (const refusal of [validationRow, listRow]) expect(["42501", "23514"]).toContain(refusal.code);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect(await count("price_change_set_item_lists", bSet.header.id)).toBe(1);
  });

  // Review round 1, m5: the audit row names the set's one target Store (spec 042 §10).
  it("m5: audit store_id is the one target Store of a single-Store set, null for a Book set", async () => {
    if (skip()) return;
    const one = await createSet(SES_OWNER_ALL, {
      items: [{ op: "set_price", scope: { kind: "stores", storeIds: [STORE_A_Y] }, products: items([P3]), price: "33", ...at("2034-01-01T00:00:00Z") }],
    });
    await validated(SES_OWNER_ALL, one);
    const rows = await env!.admin.query<{ action: string; store_id: string | null }>(
      `SELECT action, store_id::text AS store_id FROM audit_events WHERE target_id = $1 ORDER BY id`,
      [one.header.id],
    );
    expect(rows.rows).toEqual([
      { action: "pricing.change_set.created", store_id: STORE_A_Y },
      { action: "pricing.change_set.validated", store_id: STORE_A_Y },
    ]);
    const book = await env!.admin.query<{ store_id: string | null }>(
      `SELECT store_id::text AS store_id FROM audit_events WHERE target_id = $1`,
      [main.header.id],
    );
    expect(book.rows.every((r) => r.store_id === null)).toBe(true);
  });

  // Review round 3, MAJOR-1: an end or reset is the instant it takes effect.
  it("round 3: end then a later or same-instant price is valid; two ends at one instant overlap", async () => {
    if (skip()) return;
    const end = (from: string) => ({ op: "end_price", scope: { kind: "book" }, products: items([P1]), ...at(from) });
    const price = (from: string) => ({ op: "set_price", scope: { kind: "book" }, products: items([P1]), price: "150", ...at(from) });
    const classes = async (body: Record<string, unknown>): Promise<{ class: string; messages: string[] }[]> => {
      const set = await validated(SES_OWNER_ALL, await createSet(SES_OWNER_ALL, body));
      const r = await env!.admin.query<{ class: string; messages: string[] }>(
        `SELECT class, messages FROM price_change_set_lines WHERE change_set_id = $1 ORDER BY line_no`,
        [set.header.id],
      );
      return r.rows;
    };
    for (const pair of [[end("2035-01-01T00:00:00Z"), price("2035-02-01T00:00:00Z")], [end("2035-01-01T00:00:00Z"), price("2035-01-01T00:00:00Z")]]) {
      const rows = await classes({ items: pair });
      expect(rows.map((r) => r.messages.includes("overlaps_line_in_set") || r.class === "invalid")).toEqual([false, false]);
    }
    const twice = await classes({ items: [end("2035-01-01T00:00:00Z"), end("2035-01-01T00:00:00Z")] });
    expect(twice.map((r) => [r.class, r.messages.includes("overlaps_line_in_set")])).toEqual([["invalid", true], ["invalid", true]]);
  });

  // Review round 3, MAJOR-2: one line, one published price.
  it("round 3: a helper whose base differs between its Stores is invalid (helper_base_varies_by_store)", async () => {
    if (skip()) return;
    const draft = await createSet(SES_OWNER_ALL, {
      items: [
        {
          op: "adjust_percent", scope: { kind: "zone", zoneId: ZONE_DEFAULT }, products: items([P6]), percent: "10",
          timeBasis: "store_local", effectiveFrom: "2031-03-01T00:00", effectiveTo: "2031-05-01T00:00",
        },
      ],
    });
    const body = await validated(SES_OWNER_ALL, draft);
    expect(body.summary).toMatchObject({ lines: 1, stores: 2, blocking: true, findings: { invalid: 1 } });
    const preview = await allPreview(SES_OWNER_ALL, draft.header.id);
    expect(preview.lines.map((l) => [l.storeId, l.oldPrice, l.class])).toEqual([
      [STORE_A_X, "10.0000", "invalid"],
      [STORE_A_Y, "20.0000", "invalid"],
    ]);
    for (const l of preview.lines) expect(l.messages).toContain("helper_base_varies_by_store");
  });

  // Review round 3, minor 1: a retired Zone (retired through the structure service) is a 422.
  it("round 3: a line on a retired Zone is 422 change_set_no_target_store naming zone_not_live", async () => {
    if (skip()) return;
    const structure = new PriceStructureService(env!.app, {} as MembershipRepository);
    const writer = { tenantId: TENANT_A, context: { tenantId: TENANT_A } as never, actorUserId: ACTOR, requestId: null };
    const east = await structure.createZone(writer, BOOK, { code: "EAST", name: "East" } as never);
    await structure.retireZone(writer, { bookId: BOOK, zoneId: east.id }, { reason: "Closed" });
    const draft = await createSet(SES_OWNER_ALL, {
      items: [
        { op: "set_price", scope: { kind: "book" }, products: items([P3]), price: "1", ...at("2036-01-01T00:00:00Z") },
        { op: "set_price", scope: { kind: "zone", zoneId: east.id }, products: items([P3]), price: "1", ...at("2036-01-01T00:00:00Z") },
      ],
    });
    const res = await validate(SES_OWNER_ALL, draft);
    refused(res, 422, "change_set_no_target_store");
    expect((res.body as { error: { message: string } }).error.message).toBe("Item 2 names a retired Zone (zone_not_live), so it reaches no live Store.");
    expect(await count("price_change_set_validations", draft.header.id)).toBe(0);
  });

  // Review round 3, minor 3: mixed time bases inside one set.
  it("round 3: two lines of one key on different time bases are invalid with mixed_time_basis and overlaps_line_in_set", async () => {
    if (skip()) return;
    const set = await validated(
      SES_OWNER_ALL,
      await createSet(SES_OWNER_ALL, {
        items: [
          { op: "set_price", scope: { kind: "book" }, products: items([P3]), price: "61", ...at("2036-01-01T00:00:00Z") },
          { op: "set_price", scope: { kind: "book" }, products: items([P3]), price: "62", timeBasis: "store_local", effectiveFrom: "2036-06-01T00:00" },
        ],
      }),
    );
    const r = await env!.admin.query<{ class: string; messages: string[] }>(
      `SELECT class, messages FROM price_change_set_lines WHERE change_set_id = $1 ORDER BY line_no`,
      [set.header.id],
    );
    expect(r.rows).toEqual([
      { class: "invalid", messages: ["mixed_time_basis", "overlaps_line_in_set"] },
      { class: "invalid", messages: ["mixed_time_basis", "overlaps_line_in_set"] },
    ]);
  });

  // Review round 3, minor 5: one audit rule, from the items: a Book set is null even with one Store.
  it("round 3: a Book set in a one-Store tenant audits store_id null", async () => {
    if (skip()) return;
    await env!.admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [STORE_B_Y]);
    const set = await createSet(SES_OWNER_B, {
      items: [{ op: "set_price", scope: { kind: "book" }, products: items([PRODUCT_B_ACTIVE]), price: "8", ...at("2034-01-01T00:00:00Z") }],
    });
    const body = await validated(SES_OWNER_B, set);
    expect(body.summary).toMatchObject({ stores: 1 });
    const rows = await env!.admin.query<{ action: string; store_id: string | null }>(
      `SELECT action, store_id::text AS store_id FROM audit_events WHERE target_id = $1 ORDER BY id`,
      [set.header.id],
    );
    expect(rows.rows).toEqual([
      { action: "pricing.change_set.created", store_id: null },
      { action: "pricing.change_set.validated", store_id: null },
    ]);
  });

  it("a legacy_import set is never edited or cancelled here (409, comment 17881 follow-up 3)", async () => {
    if (skip()) return;
    refused(await send("patch", csPath(CS_LEGACY_DRAFT), SES_OWNER_B, { expectedVersion: 1, title: "No" }), 409, "change_set_invalid_state");
    refused(await send("post", `${CS}/${CS_LEGACY_DRAFT}/cancel`, SES_OWNER_B, { expectedVersion: 1 }), 409, "change_set_invalid_state");
    refused(await send("post", validatePath(CS_LEGACY_DRAFT), SES_OWNER_B, { expectedVersion: 1 }), 409, "change_set_invalid_state");
  });
});
