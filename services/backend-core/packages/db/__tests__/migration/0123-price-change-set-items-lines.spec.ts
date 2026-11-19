/**
 * RT-1151 (RT-282 PR-05): `0123_price_change_set_items_lines` migration test.
 *
 * Validates `packages/db/drizzle/0123_price_change_set_items_lines.sql` (+
 * `.down.sql`) on a real PostgreSQL 16, applied on top of every earlier
 * migration with tenants, stores, products and the 0121 pricing core present:
 *   - the six tables match the Drizzle schema; FORCE RLS and the exact policy
 *     set (SELECT + INSERT on all six, UPDATE on lines, no DELETE);
 *   - item lists: written only on a draft at that version; an empty list is a
 *     row; items only by the list's own transaction (sealed), exactly
 *     item_count of them at COMMIT; append-only for every role;
 *   - validations: written only on a draft at that version, from the set's
 *     current (latest) item list, never an empty one; lines and preview rows
 *     only by the validation's own transaction, exactly the counted number at
 *     COMMIT;
 *   - lines: the scope target, Zone move, price, rounding, time basis, class
 *     rules; replaced_ids within the tenant; the publish record (new_event_id,
 *     result_ids) set once, only by the publishing transaction, only on the
 *     approved validation's lines, never on a blocking line, and new_event_id
 *     only to the event for that very line (one refusal per column of the match);
 *   - the stored preview: a membership change only for a Zone move of that
 *     Store to that Zone;
 *   - change_sets: a set leaves draft only with its validation; the binding
 *     never changes outside draft; every return to draft is a new version;
 *   - the whole flow as a role holding exactly the production grants, under
 *     FORCE RLS; tenant isolation; two concurrent validates serialize;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while an item list or a validation exists.
 *
 * Guard refusals are asserted by their constraint name or message, not only by
 * the SQLSTATE, so each test proves which rule fired.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PoolClient } from "pg";

import * as schema from "../../src/schema";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, inRolledBackTx, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0123_price_change_set_items_lines.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0123_price_change_set_items_lines.down.sql");

const id = (n: string): string => `01230000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A1 = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B1 = id("0b011");
const PROD_A1 = id("0a031");
const PROD_A2 = id("0a032");
const PROD_A3 = id("0a033");
const PROD_B1 = id("0b031");
const ACTOR = id("0a0a1");
const APPROVER = id("0a0a2");
const BOOK_A = id("0a101");
const ZONE_A_DEFAULT = id("0a111");
const ZONE_A_NORTH = id("0a112");
const BOOK_B = id("0b101");
const ZONE_B_DEFAULT = id("0b111");
const CS_PUB = id("0a201");
const CS_DRAFT = id("0a202");
const CS_RACE = id("0a203");
const CS_B = id("0b201");
const EVENT_PUB = id("0a401");
const HASH = `sha256:${"a".repeat(64)}`;
const HASH_2 = `sha256:${"b".repeat(64)}`;
const CORR = id("0acc1");
const DOMAIN_ROLE = "rt1151_c2_domain";

const TABLES = [
  "price_change_set_item_lists",
  "price_change_set_items",
  "price_change_set_validations",
  "price_change_set_lines",
  "price_change_set_preview_lines",
  "price_change_set_preview_memberships",
] as const;
const FUNCTIONS = [
  "price_change_set_content_append_only()",
  "price_change_set_item_lists_before_insert()",
  "price_change_set_item_lists_complete()",
  "price_change_set_items_before_insert()",
  "price_change_set_validations_before_insert()",
  "price_change_set_validations_complete()",
  "price_change_set_validation_sealed(uuid, uuid, integer)",
  "price_change_set_lines_before_insert()",
  "price_change_set_lines_guard()",
  "price_change_set_preview_before_insert()",
  "change_sets_content_rules()",
];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

// -----------------------------------------------------------------------------
// SQL helpers
// -----------------------------------------------------------------------------

type Q = Pick<PoolClient, "query">;

async function createBook(q: Q, bookId: string, tenant: string, zoneId: string): Promise<void> {
  await q.query(
    `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'RETAIL', 'Retail', 'EGP', 'inclusive', $3, $4)`,
    [bookId, tenant, ACTOR, CORR],
  );
  await q.query(
    `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, 'DEFAULT', 'Default', true, $4, $5)`,
    [zoneId, tenant, bookId, ACTOR, CORR],
  );
}

async function createChangeSet(q: Q, csId: string, tenant: string, kind = "standard"): Promise<void> {
  await q.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'pricing', $3, 'November', $4, $5, $6)`,
    [csId, tenant, kind, kind === "emergency" ? "why" : null, ACTOR, CORR],
  );
}

interface Item {
  op?: string;
  item?: unknown;
}

async function insertList(q: Q, cs: string, version: number, count: number, tenant = TENANT_A): Promise<void> {
  await q.query(
    `INSERT INTO price_change_set_item_lists (tenant_id, change_set_id, change_set_version, item_count, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenant, cs, version, count, ACTOR, CORR],
  );
}

async function insertItem(q: Q, cs: string, version: number, position: number, it: Item = {}, tenant = TENANT_A): Promise<void> {
  const op = it.op ?? "set_price";
  await q.query(
    `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenant, cs, version, position, op, JSON.stringify(it.item ?? { op }), ACTOR, CORR],
  );
}

/** Writes an item list with its items, as one PATCH / create does. */
async function writeList(q: Q, cs: string, version: number, items: readonly Item[] = [{}], tenant = TENANT_A): Promise<void> {
  await insertList(q, cs, version, items.length, tenant);
  for (const [i, it] of items.entries()) await insertItem(q, cs, version, i + 1, it, tenant);
}

interface Validation {
  cs: string;
  version: number;
  listVersion?: number;
  lines?: number;
  preview?: number;
  moves?: number;
  revision?: number;
  hash?: string;
  tenant?: string;
}

async function insertValidation(q: Q, v: Validation): Promise<void> {
  await q.query(
    `INSERT INTO price_change_set_validations
       (tenant_id, change_set_id, change_set_version, item_list_version, validated_at_revision, preview_hash,
        target_store_set_hash, sensitive, sensitivity_reasons, summary, target_stores, line_count, preview_line_count,
        membership_change_count, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $6, true, ARRAY['approval_mode_always'], $7, $8, $9, $10, $11, $12, $13)`,
    [
      v.tenant ?? TENANT_A,
      v.cs,
      v.version,
      v.listVersion ?? 1,
      v.revision ?? 0,
      v.hash ?? HASH,
      JSON.stringify({ lines: v.lines ?? 0, unchanged: 0, blocking: false }),
      JSON.stringify([{ storeId: STORE_A1, timezone: "Africa/Cairo" }]),
      v.lines ?? 0,
      v.preview ?? 0,
      v.moves ?? 0,
      ACTOR,
      CORR,
    ],
  );
}

interface Line {
  cs: string;
  version: number;
  lineNo: number;
  listVersion?: number;
  itemPosition?: number;
  tenant?: string;
  op?: string;
  scope?: "book" | "zone" | "store";
  book?: string;
  zone?: string | null;
  store?: string | null;
  product?: string | null;
  sellUnit?: string | null;
  timeBasis?: "store_local" | "absolute";
  from?: string | null;
  to?: string | null;
  fromLocal?: string | null;
  toLocal?: string | null;
  price?: string | null;
  roundedFrom?: string | null;
  cls?: string;
  replaced?: readonly string[];
  newEventId?: string | null;
  resultIds?: readonly string[];
}

async function insertLine(q: Q, l: Line): Promise<void> {
  const absolute = l.timeBasis === "absolute";
  await q.query(
    `INSERT INTO price_change_set_lines
       (tenant_id, change_set_id, change_set_version, line_no, item_list_version, item_position, op, scope, price_book_id,
        price_zone_id, store_id, product_id, sell_unit, time_basis, effective_from, effective_to, effective_from_local,
        effective_to_local, new_price, rounded_from, class, replaced_ids, new_event_id, result_ids, created_by_user_id,
        correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26)`,
    [
      l.tenant ?? TENANT_A,
      l.cs,
      l.version,
      l.lineNo,
      l.listVersion ?? 1,
      l.itemPosition ?? 1,
      l.op ?? "set_price",
      l.scope ?? "book",
      l.book ?? BOOK_A,
      l.zone ?? null,
      l.store ?? null,
      l.product === undefined ? PROD_A2 : l.product,
      l.sellUnit === undefined ? "each" : l.sellUnit,
      l.timeBasis ?? "store_local",
      absolute ? (l.from ?? "2026-12-01T00:00:00Z") : null,
      absolute ? (l.to ?? null) : null,
      absolute ? null : l.fromLocal === undefined ? "2026-12-01T00:00:00" : l.fromLocal,
      absolute ? null : (l.toLocal ?? null),
      l.price === undefined ? "10.0000" : l.price,
      l.roundedFrom ?? null,
      l.cls ?? "new",
      [...(l.replaced ?? [])],
      l.newEventId ?? null,
      [...(l.resultIds ?? [])],
      ACTOR,
      CORR,
    ],
  );
}

async function insertPreviewLine(q: Q, p: { cs: string; version: number; lineNo: number; store?: string; tenant?: string }): Promise<void> {
  await q.query(
    `INSERT INTO price_change_set_preview_lines
       (tenant_id, change_set_id, change_set_version, line_no, store_id, product_id, sell_unit, old_price, old_source_scope,
        new_price, new_source_scope, delta_pct, effective_from, class, devices)
     VALUES ($1, $2, $3, $4, $5, $6, 'each', '12.0000', 'book', '10.0000', 'book', '-16.67', '2026-11-30T22:00:00Z', 'new', 2)`,
    [p.tenant ?? TENANT_A, p.cs, p.version, p.lineNo, p.store ?? STORE_A1, PROD_A2],
  );
}

async function insertPreviewMove(
  q: Q,
  m: { cs: string; version: number; lineNo: number; store?: string; toZone?: string },
): Promise<void> {
  await q.query(
    `INSERT INTO price_change_set_preview_memberships
       (tenant_id, change_set_id, change_set_version, line_no, store_id, from_zone_id, to_zone_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, '2026-12-01T00:00:00Z')`,
    [TENANT_A, m.cs, m.version, m.lineNo, m.store ?? STORE_A2, m.toZone ?? ZONE_A_NORTH],
  );
}

/** A validation with its lines (line_no 1..n), as one `validate` writes it. */
async function validate(q: Q, v: Validation, lines: ReadonlyArray<Partial<Line>>): Promise<void> {
  await insertValidation(q, { ...v, lines: lines.length });
  for (const [i, l] of lines.entries()) {
    await insertLine(q, { cs: v.cs, version: v.version, lineNo: i + 1, listVersion: v.listVersion ?? 1, tenant: v.tenant ?? TENANT_A, ...l });
  }
}

/** validate's last step: the set leaves draft carrying its validation's binding. */
async function leaveDraft(q: Q, cs: string, revision = 0, hash = HASH): Promise<void> {
  await q.query(
    `UPDATE change_sets SET state = 'validated', validated_at_revision = $2, preview_hash = $3, target_store_set_hash = $3,
            sensitive = true, sensitivity_reasons = ARRAY['approval_mode_always'] WHERE id = $1`,
    [cs, revision, hash],
  );
}

interface EventSpec {
  product?: string;
  price?: string;
  fromLocal?: string;
  tenant?: string;
  book?: string;
}

async function insertEvent(q: Q, eventId: string, revisionNo: number, cs: string, e: EventSpec = {}): Promise<void> {
  await q.query(
    `INSERT INTO price_events
       (id, tenant_id, price_book_id, scope, product_id, price, currency_code, time_basis, effective_from_local,
        published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, 'book', $4, $5, 'EGP', 'store_local', $6, $7, $8, 'change_set', $9, $10)`,
    [
      eventId,
      e.tenant ?? TENANT_A,
      e.book ?? BOOK_A,
      e.product ?? PROD_A2,
      e.price ?? "10.0000",
      e.fromLocal ?? "2026-12-01T00:00:00",
      revisionNo,
      cs,
      ACTOR,
      CORR,
    ],
  );
}

/** Publishes a validated set at `revisionNo` in this transaction: the revision, one book event, the set published. */
async function publish(q: Q, cs: string, revisionNo: number, eventId: string, e: EventSpec = {}): Promise<void> {
  await q.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 'publish', $4, $5)`,
    [e.tenant ?? TENANT_A, revisionNo, cs, ACTOR, CORR],
  );
  await insertEvent(q, eventId, revisionNo, cs, e);
  await q.query(
    `UPDATE change_sets SET state = 'published', submitted_by_user_id = $3, submitted_at = now(),
            approved_by_user_id = $4, approved_at = now(), published_by_user_id = $3, published_at = now(), revision_no = $2
      WHERE id = $1`,
    [cs, revisionNo, ACTOR, APPROVER],
  );
}

/** Runs `fn` under a savepoint so the transaction survives an expected error; returns "code: message" or null. */
async function sp(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  try {
    await fn();
    await c.query("RELEASE SAVEPOINT expect_error");
    return null;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT expect_error");
    const e = err as { code?: string; message?: string; constraint?: string };
    return `${e.code ?? "unknown"}: ${e.message ?? ""} ${e.constraint ?? ""}`;
  }
}

/** Forces the deferred count checks now, under a savepoint. */
const checkCounts = (c: Q): Promise<string | null> => sp(c, () => c.query("SET CONSTRAINTS ALL IMMEDIATE"));

async function exists(name: string): Promise<boolean> {
  const r = await guard().admin.query<{ x: string | null }>(`SELECT to_regclass($1)::text AS x`, [name]);
  return r.rows[0]!.x !== null;
}

/** Runs `fn` in its own transaction and COMMITs it; returns the error code or null. */
async function committed(fn: (client: PoolClient) => Promise<unknown>): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    const e = err as { code?: string; message?: string };
    if (e.code === "42703" || e.code === "42P01" || e.code === "42883") throw err;
    return e.code ?? "unknown";
  } finally {
    client.release();
  }
}

/** Removes every content row as the superuser, with the triggers off (test cleanup only). */
async function clearContent(): Promise<void> {
  const failed = await committed(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    for (const t of [...TABLES].reverse()) await c.query(`DELETE FROM ${t}`);
  });
  if (failed !== null) throw new Error(`cleanup failed: ${failed}`);
}

/** Runs `fn` in a rolled-back transaction as the production-grant domain role, under tenant A. */
async function asDomain<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${DOMAIN_ROLE}`);
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * The committed baseline: Books and Zones for A and B. CS_PUB: list v1,
 * validated at v1 (line 1 priced and recorded at publish, line 2 an end left
 * unrecorded, one preview row), published at revision 1 with EVENT_PUB.
 * CS_DRAFT and CS_RACE: empty drafts. CS_B: tenant B's draft with a list and a
 * one-line validation.
 */
async function seedBaseline(): Promise<void> {
  const failed = await committed(async (c) => {
    await createBook(c, BOOK_A, TENANT_A, ZONE_A_DEFAULT);
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'NORTH', 'North', $4, $5)`,
      [ZONE_A_NORTH, TENANT_A, BOOK_A, ACTOR, CORR],
    );
    await createBook(c, BOOK_B, TENANT_B, ZONE_B_DEFAULT);
    await createChangeSet(c, CS_PUB, TENANT_A);
    await writeList(c, CS_PUB, 1, [{}, { op: "end_price" }]);
    await insertValidation(c, { cs: CS_PUB, version: 1, lines: 2, preview: 1 });
    await insertLine(c, { cs: CS_PUB, version: 1, lineNo: 1, product: PROD_A1 });
    await insertLine(c, { cs: CS_PUB, version: 1, lineNo: 2, itemPosition: 2, op: "end_price", product: PROD_A1, price: null });
    await insertPreviewLine(c, { cs: CS_PUB, version: 1, lineNo: 1 });
    await leaveDraft(c, CS_PUB);
    await publish(c, CS_PUB, 1, EVENT_PUB, { product: PROD_A1 });
    await c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1 AND line_no = 1`, [CS_PUB, EVENT_PUB]);
    await createChangeSet(c, CS_DRAFT, TENANT_A);
    await createChangeSet(c, CS_RACE, TENANT_A);
    await createChangeSet(c, CS_B, TENANT_B);
    await writeList(c, CS_B, 1, [{}], TENANT_B);
    await validate(c, { cs: CS_B, version: 1, tenant: TENANT_B }, [{ book: BOOK_B, product: PROD_B1 }]);
  });
  if (failed !== null) throw new Error(`baseline seed failed: ${failed}`);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
    return;
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'pcs-a', 'PCS A', 'EGP'), ($2, 'pcs-b', 'PCS B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'A1', 'std', $4, $4), ($2, $5, 'B1', 'std', $4, $4), ($6, $3, 'A2', 'std', $4, $4), ($7, $3, 'A3', 'std', $4, $4)`,
    [PROD_A1, PROD_B1, TENANT_A, ACTOR, TENANT_B, PROD_A2, PROD_A3],
  );
  await a.query(upSql);
  // GRANT ON ALL TABLES again: the app role must see the new tables too.
  await a.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test`);
  // A role holding exactly the production grants of the publish path (0121 pricing + 0123 content).
  // Roles are cluster-wide: create it once; its grants below are per database.
  await a.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DOMAIN_ROLE}') THEN
       CREATE ROLE ${DOMAIN_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await a.query(`GRANT USAGE ON SCHEMA public TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT SELECT ON tenants, stores, tenant_products TO ${DOMAIN_ROLE}`);
  await a.query(
    `GRANT SELECT, INSERT ON change_sets, price_books, price_zones, pricing_revisions, pricing_revision_stores,
       price_zone_memberships, price_events TO ${DOMAIN_ROLE}`,
  );
  await a.query(
    `GRANT UPDATE (title, reason, state, version, validated_at_revision, preview_hash, target_store_set_hash, sensitive,
       sensitivity_reasons, revision_no, submitted_by_user_id, submitted_at, approved_by_user_id, approved_at,
       published_by_user_id, published_at, cancelled_by_user_id, cancelled_at, rejected_by_user_id, rejected_at,
       rejection_reason) ON change_sets TO ${DOMAIN_ROLE}`,
  );
  await a.query(`GRANT UPDATE (name) ON price_books TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT UPDATE (name, retired_at, retired_by_user_id, retire_reason) ON price_zones TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT UPDATE (state, ended_in_revision) ON price_zone_memberships, price_events TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT SELECT, INSERT ON ${TABLES.join(", ")} TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT UPDATE (new_event_id, result_ids) ON price_change_set_lines TO ${DOMAIN_ROLE}`);
  await seedBaseline();
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — shape", () => {
  it("creates the six tables and the Drizzle schema declares exactly their columns", async () => {
    if (skip()) return;
    const e = guard();
    const drizzle = Object.values(schema).filter((t) => {
      try {
        return (TABLES as readonly string[]).includes(getTableName(t as Parameters<typeof getTableName>[0]));
      } catch {
        return false;
      }
    }) as Parameters<typeof getTableColumns>[0][];
    expect(drizzle.map((t) => getTableName(t)).sort()).toEqual([...TABLES].sort());
    for (const t of drizzle) {
      const name = getTableName(t);
      const declared = Object.values(getTableColumns(t) as Record<string, { name: string; notNull: boolean }>)
        .map((c) => `${c.name}:${c.notNull ? "NO" : "YES"}`)
        .sort();
      const actual = await e.admin.query<{ c: string }>(
        `SELECT column_name || ':' || is_nullable AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
        [name],
      );
      expect([name, actual.rows.map((r) => r.c).sort()]).toEqual([name, declared]);
    }
  });

  it("enables and FORCEs RLS: SELECT + INSERT on all six, UPDATE on lines only, no DELETE", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of TABLES) {
      const rls = await e.admin.query<{ rel: boolean; force: boolean }>(
        `SELECT relrowsecurity AS rel, relforcerowsecurity AS force FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect([table, rls.rows[0]]).toEqual([table, { rel: true, force: true }]);
      const policies = await e.admin.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY cmd`,
        [table],
      );
      const expected = table === "price_change_set_lines" ? ["INSERT", "SELECT", "UPDATE"] : ["INSERT", "SELECT"];
      expect([table, policies.rows.map((r) => r.cmd)]).toEqual([table, expected]);
    }
  });
});

// -----------------------------------------------------------------------------
// Item lists and items
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — item lists", () => {
  it("writes a list only on a draft at that version; an empty list is a row", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertList(c, CS_DRAFT, 2, 1))).toMatch(/^23514: .*not a draft at version 2/);
      expect(await sp(c, () => insertList(c, CS_PUB, 2, 1))).toMatch(/^23514: .*is published/);
      expect(await sp(c, () => writeList(c, CS_DRAFT, 1, []))).toBeNull();
      expect(await checkCounts(c)).toBeNull();
    });
  });

  it("holds exactly item_count items at COMMIT, each at a position within it", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertList(c, CS_DRAFT, 1, 2);
      await insertItem(c, CS_DRAFT, 1, 1);
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 3))).toMatch(/^23514: .*position 3 is beyond the list's 2/);
      expect(await checkCounts(c)).toMatch(/^23514: .*has 1 item\(s\), its list says 2/);
    });
  });

  it("refuses an item the list's own transaction did not write (a list is sealed)", async () => {
    if (skip()) return;
    // CS_PUB's list v1 was committed by the baseline transaction.
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertItem(c, CS_PUB, 1, 3))).toMatch(/^23514: .*is sealed/);
    });
  });

  it("refuses a duplicate position, a missing or mismatched op, a non-object item, an unknown op and over 500 items", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertList(c, CS_DRAFT, 1, 6);
      await insertItem(c, CS_DRAFT, 1, 1);
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 1))).toMatch(/^23505: /);
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 2, { item: { price: "1" } }))).toMatch(/price_change_set_items_item_shape/);
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 3, { op: "set_price", item: { op: "end_price" } }))).toMatch(
        /price_change_set_items_item_shape/,
      );
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 4, { item: ["set_price"] }))).toMatch(/price_change_set_items_item_shape/);
      expect(await sp(c, () => insertItem(c, CS_DRAFT, 1, 5, { op: "discount" }))).toMatch(/price_change_set_items_op/);
    });
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertList(c, CS_DRAFT, 1, 501))).toMatch(/price_change_set_item_lists_item_count/);
    });
  });

  it("never updates, deletes or truncates a list or an item, for every role", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      for (const t of ["price_change_set_item_lists", "price_change_set_items"]) {
        expect(await sp(c, () => c.query(`UPDATE ${t} SET change_set_version = change_set_version WHERE change_set_id = $1`, [CS_PUB]))).toMatch(
          /^42501: .*append-only: UPDATE/,
        );
        expect(await sp(c, () => c.query(`DELETE FROM ${t} WHERE change_set_id = $1`, [CS_PUB]))).toMatch(/^42501: .*append-only: DELETE/);
        expect(await sp(c, () => c.query(`TRUNCATE ${t} CASCADE`))).toMatch(/^42501: /);
      }
    });
  });
});

// -----------------------------------------------------------------------------
// Validations
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — validations", () => {
  it("validates only on a draft at that version, from the current (latest) item list", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      expect(await sp(c, () => insertValidation(c, { cs: CS_DRAFT, version: 2 }))).toMatch(/not a draft at version 2/);
      // A header-only edit: version 2 keeps the version-1 list.
      await c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => insertValidation(c, { cs: CS_DRAFT, version: 2, listVersion: 2 }))).toMatch(/current item list is version 1, not 2/);
      expect(await sp(c, () => insertValidation(c, { cs: CS_DRAFT, version: 2, listVersion: 1 }))).toBeNull();
    });
  });

  it("an empty item replacement leaves nothing to validate, unlike a header-only edit", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [CS_DRAFT]);
      await writeList(c, CS_DRAFT, 2, []);
      expect(await sp(c, () => insertValidation(c, { cs: CS_DRAFT, version: 2, listVersion: 1 }))).toMatch(/current item list is version 2, not 1/);
      expect(await sp(c, () => insertValidation(c, { cs: CS_DRAFT, version: 2, listVersion: 2 }))).toMatch(/item list is empty/);
    });
  });

  it("holds exactly its counted lines and preview rows at COMMIT", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1, lines: 2, preview: 1 });
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 });
      expect(await checkCounts(c)).toMatch(/^23514: .*has 1\/0\/0 .* says 2\/1\/0/);
    });
  });

  it("refuses lines and preview rows the validation's own transaction did not write (sealed)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertLine(c, { cs: CS_PUB, version: 1, lineNo: 3, product: PROD_A1 }))).toMatch(/^23514: .*is sealed/);
      expect(await sp(c, () => insertPreviewLine(c, { cs: CS_PUB, version: 1, lineNo: 2 }))).toMatch(/^23514: .*is sealed/);
    });
  });

  it("never updates or deletes a validation or a preview row, for every role", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      for (const t of ["price_change_set_validations", "price_change_set_preview_lines"]) {
        expect(await sp(c, () => c.query(`UPDATE ${t} SET change_set_version = change_set_version WHERE change_set_id = $1`, [CS_PUB]))).toMatch(
          /^42501: .*append-only: UPDATE/,
        );
        expect(await sp(c, () => c.query(`DELETE FROM ${t} WHERE change_set_id = $1`, [CS_PUB]))).toMatch(/^42501: .*append-only: DELETE/);
      }
    });
  });
});

// -----------------------------------------------------------------------------
// Lines and the stored preview
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — lines and preview rows", () => {
  it("enforces the scope target, Zone move, price, rounding, time basis and class rules", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1 });
      let n = 0;
      const line = (l: Partial<Line>): Promise<string | null> => sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: ++n, ...l }));
      const move = { op: "move_store_zone", scope: "store" as const, store: STORE_A2, zone: ZONE_A_NORTH, sellUnit: null, price: null };
      // Accepted shapes.
      expect(await line({})).toBeNull();
      expect(await line({ scope: "zone", zone: ZONE_A_NORTH, op: "adjust_percent", price: "9.9000", roundedFrom: "9.89999999" })).toBeNull();
      expect(await line({ scope: "store", store: STORE_A1, op: "reset_store_override", price: null })).toBeNull();
      expect(await line({ ...move, product: null, timeBasis: "absolute" })).toBeNull();
      expect(await line({ timeBasis: "absolute", to: "2026-12-31T00:00:00Z", cls: "past_dated" })).toBeNull();
      // A helper result <= 0 is recorded as an invalid line with no price (spec 042 §5), never as a priced one.
      expect(await line({ op: "adjust_amount", price: null, cls: "invalid" })).toBeNull();
      // Refused shapes, each by its own constraint.
      expect(await line({ op: "adjust_amount", price: null, cls: "new" })).toMatch(/price_change_set_lines_price/);
      expect(await line({ zone: ZONE_A_NORTH })).toMatch(/price_change_set_lines_scope_target/);
      expect(await line({ scope: "zone" })).toMatch(/price_change_set_lines_scope_target/);
      expect(await line({ scope: "store", store: STORE_A1, zone: ZONE_A_NORTH })).toMatch(/price_change_set_lines_scope_target/);
      expect(await line({ op: "reset_store_override", price: null })).toMatch(/price_change_set_lines_reset_scope/);
      expect(await line({ ...move, timeBasis: "absolute" })).toMatch(/price_change_set_lines_move/);
      expect(await line({ ...move, product: null })).toMatch(/price_change_set_lines_move/);
      expect(await line({ sellUnit: null })).toMatch(/price_change_set_lines_move/);
      expect(await line({ sellUnit: "case" })).toMatch(/price_change_set_lines_move/);
      expect(await line({ price: null })).toMatch(/price_change_set_lines_price/);
      expect(await line({ price: "-1.0000" })).toMatch(/price_change_set_lines_price/);
      expect(await line({ op: "end_price" })).toMatch(/price_change_set_lines_price/);
      expect(await line({ roundedFrom: "9.99999999" })).toMatch(/price_change_set_lines_rounded_from/);
      expect(await line({ fromLocal: null })).toMatch(/price_change_set_lines_bounds/);
      expect(await line({ toLocal: "2026-11-01T00:00:00" })).toMatch(/price_change_set_lines_bounds/);
      expect(await line({ cls: "unchanged" })).toMatch(/price_change_set_lines_class/);
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 50_001 }))).toMatch(/price_change_set_lines_line_no/);
      // The composite FKs pin every reference to the set's tenant, Book, validation and item list.
      expect(await line({ scope: "zone", zone: ZONE_B_DEFAULT })).toMatch(/price_change_set_lines_zone_fk/);
      expect(await line({ product: PROD_B1 })).toMatch(/price_change_set_lines_product_fk/);
      expect(await line({ scope: "store", store: STORE_B1, op: "reset_store_override", price: null })).toMatch(/price_change_set_lines_store_fk/);
      expect(await line({ itemPosition: 9 })).toMatch(/price_change_set_lines_item_fk/);
      expect(await line({ listVersion: 2 })).toMatch(/price_change_set_lines_(validation|item)_fk/);
    });
  });

  it("replaces only events or memberships of its tenant, and carries no publish record yet", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1 });
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1, product: PROD_A1, replaced: [EVENT_PUB] }))).toBeNull();
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2, replaced: [id("0afff")] }))).toMatch(
        /replaced_ids names an id that is no price event or membership/,
      );
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2, newEventId: EVENT_PUB }))).toMatch(/set at publish, not at validation/);
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2, resultIds: [EVENT_PUB] }))).toMatch(/set at publish, not at validation/);
    });
  });

  it("stores a membership change only for a Zone move of that Store to that Zone", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1, [{ op: "move_store_zone" }]);
      await insertValidation(c, { cs: CS_DRAFT, version: 1 });
      const move = { op: "move_store_zone", scope: "store" as const, store: STORE_A2, zone: ZONE_A_NORTH, product: null, sellUnit: null, price: null };
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1, ...move, timeBasis: "absolute" });
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2 });
      expect(await sp(c, () => insertPreviewMove(c, { cs: CS_DRAFT, version: 1, lineNo: 2 }))).toMatch(/is not a Zone move of that Store/);
      expect(await sp(c, () => insertPreviewMove(c, { cs: CS_DRAFT, version: 1, lineNo: 1, store: STORE_A1 }))).toMatch(/is not a Zone move/);
      expect(await sp(c, () => insertPreviewMove(c, { cs: CS_DRAFT, version: 1, lineNo: 1, toZone: ZONE_A_DEFAULT }))).toMatch(/is not a Zone move/);
      expect(await sp(c, () => insertPreviewMove(c, { cs: CS_DRAFT, version: 1, lineNo: 1 }))).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// change_sets: leaving draft, the binding, the version
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — change_sets content rules", () => {
  it("a set leaves draft only with the validation at its version, carrying its binding", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => leaveDraft(c, CS_DRAFT))).toMatch(/leaves draft only with the validation at version 1/);
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1 });
      expect(await sp(c, () => leaveDraft(c, CS_DRAFT, 0, HASH_2))).toMatch(/leaves draft only with the validation/);
      expect(await sp(c, () => leaveDraft(c, CS_DRAFT, 1, HASH))).toMatch(/leaves draft only with the validation/);
      expect(await sp(c, () => leaveDraft(c, CS_DRAFT))).toBeNull();
    });
  });

  it("outside draft the binding never changes; the revision only advances", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1, revision: 1 });
      await leaveDraft(c, CS_DRAFT, 1);
      const update = (set: string): Promise<string | null> => sp(c, () => c.query(`UPDATE change_sets SET ${set} WHERE id = $1`, [CS_DRAFT]));
      expect(await update(`preview_hash = '${HASH_2}'`)).toMatch(/outside draft its validation binding never changes/);
      expect(await update(`target_store_set_hash = '${HASH_2}'`)).toMatch(/binding never changes/);
      expect(await update(`sensitive = false`)).toMatch(/binding never changes/);
      expect(await update(`sensitivity_reasons = '{}'`)).toMatch(/binding never changes/);
      expect(await update(`validated_at_revision = 0`)).toMatch(/binding never changes/);
      // A non-intersecting later head advances the revision (spec 042 §3).
      expect(await update(`validated_at_revision = 7`)).toBeNull();
    });
  });

  it("a return to draft is a new version; draft to cancelled and legacy_import need no validation", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await writeList(c, CS_DRAFT, 1);
      await insertValidation(c, { cs: CS_DRAFT, version: 1 });
      await leaveDraft(c, CS_DRAFT);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'draft' WHERE id = $1`, [CS_DRAFT]))).toMatch(
        /return to draft from validated increments the version/,
      );
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'draft', version = 2 WHERE id = $1`, [CS_DRAFT]))).toBeNull();
      // Re-validated at version 2 from the same list; the version-1 validation is kept.
      expect(await sp(c, () => validate(c, { cs: CS_DRAFT, version: 2 }, [{}]))).toBeNull();
      const kept = await c.query(`SELECT change_set_version FROM price_change_set_validations WHERE change_set_id = $1 ORDER BY 1`, [CS_DRAFT]);
      expect(kept.rows).toEqual([{ change_set_version: 1 }, { change_set_version: 2 }]);
      expect(
        await sp(c, () =>
          c.query(`UPDATE change_sets SET state = 'cancelled', cancelled_by_user_id = $2, cancelled_at = now() WHERE id = $1`, [CS_RACE, ACTOR]),
        ),
      ).toBeNull();
      const legacy = id("0a204");
      await createChangeSet(c, legacy, TENANT_A, "legacy_import");
      await c.query(
        `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
         VALUES (gen_random_uuid(), $1, 2, $2, 'legacy_import', $3, $4)`,
        [TENANT_A, legacy, ACTOR, CORR],
      );
      expect(
        await sp(c, () =>
          c.query(`UPDATE change_sets SET state = 'published', published_by_user_id = $2, published_at = now(), revision_no = 2 WHERE id = $1`, [
            legacy,
            ACTOR,
          ]),
        ),
      ).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// The publish record (spec 042 §10, Q-B5)
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — the publish record", () => {
  const EVENT = id("0a402");
  // Each line differs from EVENT (book, PROD_A2, each, 10.0000, store_local from 2026-12-01, open) in exactly one respect.
  const LINES: ReadonlyArray<[string, Partial<Line>]> = [
    ["match", {}],
    ["duplicate", {}],
    ["price", { price: "11.0000" }],
    ["from", { fromLocal: "2026-12-02T00:00:00" }],
    ["to", { toLocal: "2026-12-31T00:00:00" }],
    ["basis", { timeBasis: "absolute" }],
    ["zone", { scope: "zone", zone: ZONE_A_NORTH }],
    ["store", { scope: "store", store: STORE_A1 }],
    ["product", { product: PROD_A3 }],
    ["invalid", { cls: "invalid" }],
    ["past", { cls: "past_dated" }],
    ["end", { op: "end_price", price: null, itemPosition: 2 }],
  ];
  const lineNo = (name: string): number => LINES.findIndex(([n]) => n === name) + 1;

  function setRecord(c: Q, name: string, rec: { event?: string; results?: readonly string[] }, version = 2): Promise<string | null> {
    return sp(c, () =>
      c.query(
        `UPDATE price_change_set_lines SET new_event_id = $4, result_ids = $5
          WHERE change_set_id = $1 AND change_set_version = $2 AND line_no = $3`,
        [CS_DRAFT, version, lineNo(name), rec.event ?? null, [...(rec.results ?? [])]],
      ),
    );
  }

  /** CS_DRAFT: validated at v1 (one line), back to draft, re-validated at v2 (LINES), approved; not yet published. */
  async function prepare(c: Q): Promise<void> {
    await writeList(c, CS_DRAFT, 1, [{}, { op: "end_price" }]);
    await validate(c, { cs: CS_DRAFT, version: 1, hash: HASH_2 }, [{}]);
    await leaveDraft(c, CS_DRAFT, 0, HASH_2);
    await c.query(
      `UPDATE change_sets SET state = 'draft', version = 2, preview_hash = NULL, validated_at_revision = NULL,
              target_store_set_hash = NULL, sensitive = NULL, sensitivity_reasons = '{}' WHERE id = $1`,
      [CS_DRAFT],
    );
    await validate(
      c,
      { cs: CS_DRAFT, version: 2, revision: 1 },
      LINES.map(([, l]) => l),
    );
    await leaveDraft(c, CS_DRAFT, 1);
  }

  it("is set only by the publishing transaction", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await prepare(c);
      expect(await setRecord(c, "match", { event: EVENT_PUB })).toMatch(/was not published by this transaction/);
    });
    // CS_PUB was published by the baseline's transaction: its unrecorded end line stays unrecorded.
    await inRolledBackTx(guard().admin, async (c) => {
      expect(
        await sp(c, () => c.query(`UPDATE price_change_set_lines SET result_ids = $2 WHERE change_set_id = $1 AND line_no = 2`, [CS_PUB, [EVENT_PUB]])),
      ).toMatch(/was not published by this transaction/);
    });
  });

  it("links new_event_id only to the event for that very line: one refusal per column of the match", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await prepare(c);
      await publish(c, CS_DRAFT, 2, EVENT);
      const notTheEvent = /is not the event this set published for this line/;
      for (const name of ["price", "from", "to", "basis", "zone", "store", "product"]) {
        expect([name, await setRecord(c, name, { event: EVENT })]).toEqual([name, expect.stringMatching(notTheEvent)]);
      }
      // Another set's event (another revision too).
      expect(await setRecord(c, "match", { event: EVENT_PUB })).toMatch(notTheEvent);
      // Blocking lines are never published.
      expect(await setRecord(c, "invalid", { event: EVENT })).toMatch(/a invalid line of a standard set is never published/);
      expect(await setRecord(c, "past", { event: EVENT })).toMatch(/a past_dated line of a standard set is never published/);
      // The earlier validation's line is not the approved one.
      expect(await setRecord(c, "match", { event: EVENT }, 1)).toMatch(/only the lines of the approved validation \(version 2\)/);
      // The matching line takes it, once; no second line takes the same event.
      expect(await setRecord(c, "match", { event: EVENT })).toBeNull();
      expect(await setRecord(c, "match", { event: EVENT })).toMatch(/only its publish record .* is set, once/);
      expect(await setRecord(c, "duplicate", { event: EVENT })).toMatch(/^23505: /);
    });
  });

  it("records result_ids only to rows this set's publish wrote, and nothing else on a line ever changes", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await prepare(c);
      await publish(c, CS_DRAFT, 2, EVENT);
      const remainder = id("0a403");
      await insertEvent(c, remainder, 2, CS_DRAFT, { product: PROD_A3 });
      expect(await setRecord(c, "end", { results: [EVENT_PUB] })).toMatch(/result_ids names an id this set's publish did not write/);
      expect(await setRecord(c, "end", { results: [id("0afff")] })).toMatch(/result_ids names an id/);
      expect(await setRecord(c, "end", { results: [remainder] })).toBeNull();
      expect(await setRecord(c, "end", { results: [remainder] })).toMatch(/only its publish record .* is set, once/);
      expect(
        await sp(c, () =>
          c.query(
            `UPDATE price_change_set_lines SET new_event_id = $2, new_price = '10.5000'
              WHERE change_set_id = $1 AND change_set_version = 2 AND line_no = 1`,
            [CS_DRAFT, EVENT],
          ),
        ),
      ).toMatch(/a line is immutable/);
      expect(await sp(c, () => c.query(`DELETE FROM price_change_set_lines WHERE change_set_id = $1`, [CS_DRAFT]))).toMatch(/^42501: /);
      expect(await sp(c, () => c.query(`TRUNCATE price_change_set_lines CASCADE`))).toMatch(/^42501: /);
    });
  });

  it("an emergency set publishes its past_dated line", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const cs = id("0a205");
      await createChangeSet(c, cs, TENANT_A, "emergency");
      await writeList(c, cs, 1);
      await validate(c, { cs, version: 1, revision: 1 }, [{ cls: "past_dated" }]);
      await leaveDraft(c, cs, 1);
      await publish(c, cs, 2, EVENT);
      expect(await sp(c, () => c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1`, [cs, EVENT]))).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// Production grants, tenant isolation, concurrency
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — production grants, isolation, concurrency", () => {
  it("runs a whole edit, validate and publish as a role holding exactly the production grants, under FORCE RLS", async () => {
    if (skip()) return;
    const failed = await asDomain((c) =>
      errorCode(async () => {
        const event = id("0a406");
        await writeList(c, CS_DRAFT, 1);
        await insertValidation(c, { cs: CS_DRAFT, version: 1, revision: 1, lines: 1, preview: 1 });
        await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 });
        await insertPreviewLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 });
        await leaveDraft(c, CS_DRAFT, 1);
        await publish(c, CS_DRAFT, 2, event);
        await c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1`, [CS_DRAFT, event]);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      }),
    );
    expect(failed).toBeNull();
    // The column grants hold: no wider UPDATE on a line.
    expect(await asDomain((c) => errorCode(() => c.query(`UPDATE price_change_set_lines SET class = class WHERE change_set_id = $1`, [CS_PUB])))).toBe(
      "42501",
    );
  });

  it("shows each tenant only its own content and nothing without a tenant", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of ["price_change_set_item_lists", "price_change_set_items", "price_change_set_validations", "price_change_set_lines"]) {
      const a = await asApp(e, TENANT_A, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, a.rows.map((r) => r.t)]).toEqual([table, [TENANT_A]]);
      const b = await asApp(e, TENANT_B, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, b.rows.map((r) => r.t)]).toEqual([table, [TENANT_B]]);
      const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${table}`));
      expect([table, none.rowCount]).toEqual([table, 0]);
    }
  });

  it("refuses a cross-tenant write and never deletes or updates another tenant's line", async () => {
    if (skip()) return;
    const e = guard();
    // The insert trigger reads the set under tenant B's RLS, finds none and refuses first (non-disclosing).
    expect(await asApp(e, TENANT_B, (c) => errorCode(() => insertList(c, CS_DRAFT, 1, 0)))).toBe("23514");
    const deleted = await asApp(e, TENANT_A, (c) => c.query(`DELETE FROM price_change_set_lines`));
    expect(deleted.rowCount).toBe(0);
    const updated = await asApp(e, TENANT_B, (c) =>
      c.query(`UPDATE price_change_set_lines SET result_ids = $2 WHERE change_set_id = $1`, [CS_PUB, [EVENT_PUB]]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("two concurrent validates of one draft serialize: the second is refused, no deadlock", async () => {
    if (skip()) return;
    expect(await committed((c) => writeList(c, CS_RACE, 1))).toBeNull();
    const a = await guard().admin.connect();
    const b = await guard().admin.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await insertValidation(a, { cs: CS_RACE, version: 1 });
      // b blocks on the set's row lock until a commits, then sees it validated.
      const second = errorCode(() => insertValidation(b, { cs: CS_RACE, version: 1 }));
      await leaveDraft(a, CS_RACE);
      await a.query("COMMIT");
      expect(await second).toBe("23514");
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

// -----------------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — down migration", () => {
  const OWNER_TABLES = [...TABLES, "tenants", "change_sets"];

  async function runFileWithEmptyGuc(path: string, role: string): Promise<string | null> {
    const client = await guard().admin.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);
      return await errorCode(() => client.query(readFileSync(path, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("RESET app.current_tenant").catch(() => undefined);
      client.release();
    }
  }

  it("REFUSES while an item list or a validation exists, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    const owner = { role: "rt1151_c2_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      // An empty item list alone (no item, no validation) still blocks it.
      await clearContent();
      expect(await committed((c) => insertList(c, CS_DRAFT, 1, 0))).toBeNull();
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
  });

  it("drops the tables, functions and change_sets trigger once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await clearContent();
    const owner = { role: "rt1151_c2_down_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, false]);
    const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname = ANY($1)`, [FUNCTIONS.map((f) => f.replace(/\(.*\)$/, ""))]);
    expect(fns.rowCount).toBe(0);
    const trigger = `SELECT 1 FROM pg_trigger WHERE tgname = 'change_sets_content_rules'`;
    expect((await e.admin.query(trigger)).rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    expect((await e.admin.query(trigger)).rowCount).toBe(1);
    // The 0121 core survived the round trip.
    const sets = await e.admin.query(`SELECT 1 FROM change_sets WHERE id = ANY($1)`, [[CS_PUB, CS_DRAFT, CS_RACE, CS_B]]);
    expect(sets.rowCount).toBe(4);
  });
});
