/**
 * RT-1151 (RT-282 PR-05): `0123_price_change_set_items_lines` migration test.
 *
 * Validates `packages/db/drizzle/0123_price_change_set_items_lines.sql` (+
 * `.down.sql`) on a real PostgreSQL 16, applied on top of every earlier
 * migration with tenants, stores, products and the 0121 pricing core present:
 *   - both tables match the Drizzle schema; FORCE RLS and the exact policy set
 *     (SELECT + INSERT on both, UPDATE on lines, no DELETE);
 *   - items: written only while the set is a draft at exactly that version,
 *     never below a later version, `item.op` = `op`; never updated or deleted;
 *   - lines: written only while the set is a draft at that version, from the
 *     set's latest items (also after a version bump with no item rewrite);
 *     the scope target, Zone-move, price, time-basis and class rules; no
 *     `new_event_id` at validation; an `invalid` helper line may carry no price;
 *   - the header records the item list and the latest validation
 *     (change_sets.items_version / lines_version), so an empty replacement and a
 *     validation with no line are told apart; every return to draft increments the version;
 *   - publish: `new_event_id` is set once, only by the transaction that
 *     published the set, only to an event that set published; nothing else
 *     on a line ever changes; lines are never deleted;
 *   - tenant isolation under FORCE RLS as the app role;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while an item or a line exists.
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
const CS_B = id("0b201");
const EVENT_PUB = id("0a401");
const HASH = `sha256:${"a".repeat(64)}`;
const CORR = id("0acc1");

const TABLES = ["price_change_set_items", "price_change_set_lines"] as const;
const FUNCTIONS = [
  "price_change_set_items_before_insert()",
  "price_change_set_content_append_only()",
  "price_change_set_lines_before_insert()",
  "price_change_set_lines_guard()",
  "change_sets_content_versions()",
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

async function createChangeSet(q: Q, csId: string, tenant: string): Promise<void> {
  await q.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'pricing', 'standard', 'November', $3, $4)`,
    [csId, tenant, ACTOR, CORR],
  );
}

/** The header records the item list (items_version) or a validation (lines_version) at `version`, as the runtime does first. */
async function record(q: Q, cs: string, column: "items_version" | "lines_version", version: number): Promise<void> {
  await q.query(`UPDATE change_sets SET ${column} = $2 WHERE id = $1 AND ${column} IS DISTINCT FROM $2`, [cs, version]);
}

async function insertItem(
  q: Q,
  i: { cs: string; version: number; position: number; op?: string; item?: Record<string, unknown>; tenant?: string },
): Promise<void> {
  const op = i.op ?? "set_price";
  await record(q, i.cs, "items_version", i.version);
  await q.query(
    `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [i.tenant ?? TENANT_A, i.cs, i.version, i.position, op, JSON.stringify(i.item ?? { op }), ACTOR, CORR],
  );
}

interface Line {
  cs: string;
  version: number;
  lineNo: number;
  itemVersion?: number;
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
  newEventId?: string | null;
}

async function insertLine(q: Q, l: Line): Promise<void> {
  const absolute = l.timeBasis === "absolute";
  await record(q, l.cs, "lines_version", l.version);
  await q.query(
    `INSERT INTO price_change_set_lines
       (tenant_id, change_set_id, change_set_version, line_no, item_version, item_position, op, scope, price_book_id,
        price_zone_id, store_id, product_id, sell_unit, time_basis, effective_from, effective_to, effective_from_local,
        effective_to_local, new_price, rounded_from, class, new_event_id, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
    [
      l.tenant ?? TENANT_A,
      l.cs,
      l.version,
      l.lineNo,
      l.itemVersion ?? l.version,
      l.itemPosition ?? 1,
      l.op ?? "set_price",
      l.scope ?? "book",
      l.book ?? BOOK_A,
      l.zone ?? null,
      l.store ?? null,
      l.product === undefined ? PROD_A1 : l.product,
      l.sellUnit === undefined ? "each" : l.sellUnit,
      l.timeBasis ?? "store_local",
      absolute ? (l.from ?? "2026-12-01T00:00:00Z") : null,
      absolute ? (l.to ?? null) : null,
      absolute ? null : l.fromLocal === undefined ? "2026-12-01T00:00:00" : l.fromLocal,
      absolute ? null : (l.toLocal ?? null),
      l.price === undefined ? "10.0000" : l.price,
      l.roundedFrom ?? null,
      l.cls ?? "new",
      l.newEventId ?? null,
      ACTOR,
      CORR,
    ],
  );
}

/** Publishes `csId` at `revisionNo` in this transaction: the revision, one book event, the set's published columns. */
async function publish(q: Q, csId: string, revisionNo: number, eventId: string, tenant = TENANT_A, book = BOOK_A, product = PROD_A1): Promise<void> {
  await q.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, correlation_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 'publish', $4, $5)`,
    [tenant, revisionNo, csId, ACTOR, CORR],
  );
  await q.query(
    `INSERT INTO price_events
       (id, tenant_id, price_book_id, scope, product_id, price, currency_code, time_basis, effective_from_local,
        published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, 'book', $4, '10.0000', 'EGP', 'store_local', '2026-12-01T00:00:00', $5, $6, 'change_set', $7, $8)`,
    [eventId, tenant, book, product, revisionNo, csId, ACTOR, CORR],
  );
  await q.query(
    `UPDATE change_sets SET state = 'published', version = version + 1, validated_at_revision = $2 - 1,
            preview_hash = $3, target_store_set_hash = $3, sensitive = true,
            sensitivity_reasons = ARRAY['approval_mode_always'],
            submitted_by_user_id = $4, submitted_at = now(), approved_by_user_id = $5, approved_at = now(),
            published_by_user_id = $4, published_at = now(), revision_no = $2
      WHERE id = $1`,
    [csId, revisionNo, HASH, ACTOR, APPROVER],
  );
}

/** Runs `fn` under a savepoint so the transaction survives an expected error; returns its code or null. */
async function sp(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  const code = await errorCode(fn);
  await c.query(code === null ? "RELEASE SAVEPOINT expect_error" : "ROLLBACK TO SAVEPOINT expect_error");
  return code;
}

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
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    client.release();
  }
}

/** Removes every Change Set content row and the header's record of it, as the superuser with the triggers off (test cleanup only). */
async function clearContent(): Promise<void> {
  const failed = await committed(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("DELETE FROM price_change_set_lines");
    await c.query("DELETE FROM price_change_set_items");
    await c.query("UPDATE change_sets SET items_version = NULL, lines_version = NULL");
  });
  if (failed !== null) throw new Error(`cleanup failed: ${failed}`);
}

/**
 * The committed baseline: Books and Zones for A and B; CS_PUB published at
 * revision 1 with its item, its line (new_event_id still NULL) and EVENT_PUB;
 * CS_DRAFT an empty draft; CS_B a draft of tenant B with one item and one line.
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
    await insertItem(c, { cs: CS_PUB, version: 1, position: 1 });
    await insertLine(c, { cs: CS_PUB, version: 1, lineNo: 1 });
    await publish(c, CS_PUB, 1, EVENT_PUB);
    await createChangeSet(c, CS_DRAFT, TENANT_A);
    await createChangeSet(c, CS_B, TENANT_B);
    await insertItem(c, { cs: CS_B, version: 1, position: 1, tenant: TENANT_B });
    await insertLine(c, { cs: CS_B, version: 1, lineNo: 1, tenant: TENANT_B, book: BOOK_B, product: PROD_B1 });
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
     VALUES ($1, $3, 'A1', 'std', $4, $4), ($2, $5, 'B1', 'std', $4, $4), ($6, $3, 'A2', 'std', $4, $4)`,
    [PROD_A1, PROD_B1, TENANT_A, ACTOR, TENANT_B, PROD_A2],
  );
  await a.query(upSql);
  // GRANT ON ALL TABLES again: the app role must see the new tables too.
  await a.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test`);
  await seedBaseline();
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — shape", () => {
  it("creates both tables and the Drizzle schema declares exactly their columns", async () => {
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

  it("enables and FORCEs RLS: SELECT + INSERT on both, UPDATE on lines only, no DELETE", async () => {
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
// Items
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — items", () => {
  it("writes items only while the set is a draft at exactly that version; each edit writes a new version", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 }))).toBeNull();
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 2, position: 1 }))).toBe("23514");
      await c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 2, position: 1, op: "end_price" }))).toBeNull();
      // Version 1 is history now: no item is added to it.
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 2 }))).toBe("23514");
      const kept = await c.query(`SELECT change_set_version, op FROM price_change_set_items WHERE change_set_id = $1 ORDER BY 1`, [CS_DRAFT]);
      expect(kept.rows).toEqual([
        { change_set_version: 1, op: "set_price" },
        { change_set_version: 2, op: "end_price" },
      ]);
    });
  });

  it("refuses items on a set past draft, a duplicate position, an out-of-range position and a mismatched item op", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertItem(c, { cs: CS_PUB, version: 2, position: 2 }))).toBe("23514");
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 }))).toBe("23505");
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 501 }))).toBe("23514");
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 2, op: "set_price", item: { op: "end_price" } }))).toBe(
        "23514",
      );
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 3, op: "discount" }))).toBe("23514");
      // The item must name its op, and must be an object.
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 4, item: { price: "1" } }))).toBe("23514");
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
             VALUES ($1, $2, 1, 5, 'set_price', '["set_price"]', $3, $4)`,
            [TENANT_A, CS_DRAFT, ACTOR, CORR],
          ),
        ),
      ).toBe("23514");
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 0, position: 6 }))).toBe("23514");
    });
  });

  it("never updates, deletes or truncates an item, for every role", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(`UPDATE price_change_set_items SET item = '{"op":"set_price"}' WHERE change_set_id = $1`, [CS_PUB]))).toBe(
        "42501",
      );
      expect(await sp(c, () => c.query(`DELETE FROM price_change_set_items WHERE change_set_id = $1`, [CS_PUB]))).toBe("42501");
      expect(await sp(c, () => c.query(`TRUNCATE price_change_set_items CASCADE`))).toBe("42501");
    });
  });
});

// -----------------------------------------------------------------------------
// Lines
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — lines", () => {
  it("materializes lines from the latest items, also after a version bump that rewrote no item", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 }))).toBeNull();
      // A stale validation (or a header-only edit) increments the version; the items stay at 1.
      await c.query(`UPDATE change_sets SET version = 3 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 3, lineNo: 1, itemVersion: 1 }))).toBeNull();
      // Lines of the earlier validation are kept, and none is written at an old version.
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2 }))).toBe("23514");
      // Once the items are rewritten at version 4, lines must come from them.
      await c.query(`UPDATE change_sets SET version = 4 WHERE id = $1`, [CS_DRAFT]);
      await insertItem(c, { cs: CS_DRAFT, version: 4, position: 1 });
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 4, lineNo: 1, itemVersion: 1 }))).toBe("23514");
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 4, lineNo: 1, itemVersion: 4 }))).toBeNull();
      // An item version above the set's version, or a position with no item, is refused.
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 4, lineNo: 2, itemVersion: 5 }))).toBe("23514");
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 4, lineNo: 2, itemPosition: 9 }))).toBe("23503");
    });
  });

  it("refuses lines on a set past draft and a new_event_id at validation", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertLine(c, { cs: CS_PUB, version: 2, lineNo: 2, itemVersion: 1 }))).toBe("23514");
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1, newEventId: EVENT_PUB }))).toBe("23514");
    });
  });

  it("enforces the scope target, Zone move, price, rounding, time basis and class rules", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      let n = 0;
      const line = (l: Partial<Line>): Promise<string | null> => sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: ++n, ...l }));
      // Accepted shapes.
      expect(await line({})).toBeNull();
      expect(await line({ scope: "zone", zone: ZONE_A_NORTH, op: "adjust_percent", price: "9.9000", roundedFrom: "9.89999999" })).toBeNull();
      expect(await line({ scope: "store", store: STORE_A1, op: "reset_store_override", price: null })).toBeNull();
      expect(
        await line({ scope: "store", store: STORE_A2, zone: ZONE_A_NORTH, op: "move_store_zone", product: null, sellUnit: null, price: null, timeBasis: "absolute" }),
      ).toBeNull();
      expect(await line({ timeBasis: "absolute", from: "2026-12-01T00:00:00Z", to: "2026-12-31T00:00:00Z", cls: "past_dated" })).toBeNull();
      // Refused shapes.
      expect(await line({ zone: ZONE_A_NORTH })).toBe("23514"); // a book line naming a Zone
      expect(await line({ scope: "zone" })).toBe("23514"); // a Zone line without its Zone
      expect(await line({ scope: "store", store: STORE_A1, zone: ZONE_A_NORTH })).toBe("23514"); // a priced store line naming a Zone
      expect(await line({ op: "reset_store_override", price: null })).toBe("23514"); // a reset outside store scope
      expect(await line({ scope: "store", store: STORE_A2, zone: ZONE_A_NORTH, op: "move_store_zone", sellUnit: null, price: null, timeBasis: "absolute" })).toBe(
        "23514",
      ); // a move naming a product
      expect(await line({ scope: "store", store: STORE_A2, zone: ZONE_A_NORTH, op: "move_store_zone", product: null, sellUnit: null, price: null })).toBe(
        "23514",
      ); // a move in store-local time
      expect(await line({ price: null })).toBe("23514"); // a priced op without a price
      expect(await line({ price: "-1.0000" })).toBe("23514");
      expect(await line({ op: "end_price" })).toBe("23514"); // an end with a price
      expect(await line({ roundedFrom: "9.99999999" })).toBe("23514"); // rounding on a fixed price
      expect(await line({ sellUnit: "case" })).toBe("23514");
      expect(await line({ fromLocal: null })).toBe("23514");
      expect(await line({ toLocal: "2026-11-01T00:00:00" })).toBe("23514"); // ends before it starts
      expect(await line({ cls: "unchanged" })).toBe("23514");
      expect(await line({ sellUnit: null })).toBe("23514"); // a priced line with no sell unit
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 50_001 }))).toBe("23514");
      // A helper result <= 0 is recorded as an invalid line with no price (spec 042 §5), never as a priced one.
      expect(await line({ op: "adjust_amount", price: null, cls: "invalid" })).toBeNull();
      expect(await line({ op: "adjust_amount", price: null, cls: "new" })).toBe("23514");
      // The composite FKs pin every reference to the set's tenant and Book.
      expect(await line({ scope: "zone", zone: ZONE_B_DEFAULT })).toBe("23503");
      expect(await line({ product: PROD_B1 })).toBe("23503");
      expect(await line({ scope: "store", store: STORE_B1, op: "reset_store_override", price: null })).toBe("23503");
    });
  });

  it("sets new_event_id once, in the publishing transaction, to an event that set published", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      // An earlier validation at version 1, then the one that is published, at version 2.
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1, product: PROD_A2 });
      await c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [CS_DRAFT]);
      // Lines 1 and 2 have the published event's target, product, price and start; line 3 is a Zone line.
      await insertLine(c, { cs: CS_DRAFT, version: 2, lineNo: 1, itemVersion: 1, product: PROD_A2 });
      await insertLine(c, { cs: CS_DRAFT, version: 2, lineNo: 2, itemVersion: 1, product: PROD_A2 });
      await insertLine(c, { cs: CS_DRAFT, version: 2, lineNo: 3, itemVersion: 1, product: PROD_A2, scope: "zone", zone: ZONE_A_NORTH });
      const setEventAt = (version: number, lineNo: number, event: string): Promise<string | null> =>
        sp(c, () =>
          c.query(
            `UPDATE price_change_set_lines SET new_event_id = $4 WHERE change_set_id = $1 AND change_set_version = $2 AND line_no = $3`,
            [CS_DRAFT, version, lineNo, event],
          ),
        );
      const setEvent = (lineNo: number, event: string): Promise<string | null> => setEventAt(2, lineNo, event);
      // Not yet published: no revision is this set's.
      expect(await setEvent(1, EVENT_PUB)).toBe("23514");
      const event = id("0a402");
      // Another product: EVENT_PUB already holds PROD_A1's open-ended book interval.
      await publish(c, CS_DRAFT, 2, event, TENANT_A, BOOK_A, PROD_A2);
      // Another set's event is refused; so is a line of the earlier validation.
      expect(await setEvent(1, EVENT_PUB)).toBe("23514");
      expect(await setEventAt(1, 1, event)).toBe("23514");
      // A statement that also matches the earlier validation's line is refused whole.
      expect(
        await sp(c, () => c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1 AND line_no = 1`, [CS_DRAFT, event])),
      ).toBe("23514");
      // An event of this set for another target is refused (the Zone line), and one for another product.
      expect(await setEvent(3, event)).toBe("23514");
      // This set's event on its own latest line is accepted, once, and on one line only.
      expect(await setEvent(1, event)).toBeNull();
      expect(await setEvent(1, event)).toBe("23514");
      expect(await setEvent(2, event)).toBe("23505");
      // Nothing else on a line ever changes, not even alongside new_event_id.
      expect(
        await sp(c, () =>
          c.query(`UPDATE price_change_set_lines SET new_event_id = $2, new_price = '11.0000' WHERE change_set_id = $1 AND line_no = 2`, [
            CS_DRAFT,
            event,
          ]),
        ),
      ).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE price_change_set_lines SET class = 'replaces' WHERE change_set_id = $1`, [CS_DRAFT]))).toBe("23514");
    });
  });

  it("refuses new_event_id from any transaction other than the one that published the set", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      // CS_PUB and EVENT_PUB were committed by the baseline's transaction.
      expect(
        await sp(c, () => c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1`, [CS_PUB, EVENT_PUB])),
      ).toBe("23514");
    });
  });

  it("never deletes or truncates a line, for every role", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(`DELETE FROM price_change_set_lines WHERE change_set_id = $1`, [CS_PUB]))).toBe("42501");
      expect(await sp(c, () => c.query(`TRUNCATE price_change_set_lines`))).toBe("42501");
    });
  });
});

describe("0123_price_change_set_items_lines — a return to draft starts a new version", () => {
  it("refuses content on a validated set, and a return to draft that keeps the version", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 });
      await c.query(
        `UPDATE change_sets SET state = 'validated', validated_at_revision = 1, preview_hash = $2, target_store_set_hash = $2,
                sensitive = true WHERE id = $1`,
        [CS_DRAFT, HASH],
      );
      expect(await sp(c, () => insertItem(c, { cs: CS_DRAFT, version: 1, position: 2 }))).toBe("23514");
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 2 }))).toBe("23514");
      // A reject (or an edit, or a stale validation) moves it back to draft only at a new version.
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'draft' WHERE id = $1`, [CS_DRAFT]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'draft', version = 2 WHERE id = $1`, [CS_DRAFT]))).toBeNull();
      // The re-validation writes its lines at the new version; the first validation's are kept.
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 2, lineNo: 1, itemVersion: 1 }))).toBeNull();
      const kept = await c.query(`SELECT change_set_version FROM price_change_set_lines WHERE change_set_id = $1 ORDER BY 1`, [CS_DRAFT]);
      expect(kept.rows).toEqual([{ change_set_version: 1 }, { change_set_version: 2 }]);
    });
  });
});

describe("0123_price_change_set_items_lines — the header records the item list and the latest validation", () => {
  const rawItem = (c: Q, version: number, position: number): Promise<unknown> =>
    c.query(
      `INSERT INTO price_change_set_items (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, $4, 'set_price', '{"op":"set_price"}', $5, $6)`,
      [TENANT_A, CS_DRAFT, version, position, ACTOR, CORR],
    );

  it("refuses items the header has not recorded, and a recorded version that is not the current one", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => rawItem(c, 1, 1))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET items_version = 2 WHERE id = $1`, [CS_DRAFT]))).toBe("23514");
      await record(c, CS_DRAFT, "items_version", 1);
      expect(await sp(c, () => rawItem(c, 1, 1))).toBeNull();
      // Neither version moves back, nor while the set is past draft.
      await c.query(`UPDATE change_sets SET version = 2, items_version = 2 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET items_version = 1 WHERE id = $1`, [CS_DRAFT]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET lines_version = 1 WHERE id = $1`, [CS_DRAFT]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET items_version = 3 WHERE id = $1`, [CS_PUB]))).toBe("23514");
    });
  });

  it("an empty item replacement leaves nothing to materialize, unlike a header-only edit", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      // A header-only edit: version 2 keeps the version-1 list, so lines come from it.
      await c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 2, lineNo: 1, itemVersion: 1 }))).toBeNull();
      // An empty replacement at version 3 records the list with no rows: no line can come from the old one.
      await c.query(`UPDATE change_sets SET version = 3, items_version = 3 WHERE id = $1`, [CS_DRAFT]);
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 3, lineNo: 1, itemVersion: 1 }))).toBe("23514");
      expect(await sp(c, () => insertLine(c, { cs: CS_DRAFT, version: 3, lineNo: 1, itemVersion: 3 }))).toBe("23503");
    });
  });

  it("a re-validation that materializes no line still retires the earlier validation's lines", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
      await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1, product: PROD_A2 });
      // Version 2 validates to no line (every price unchanged): only the header records it.
      await c.query(`UPDATE change_sets SET version = 2, lines_version = 2 WHERE id = $1`, [CS_DRAFT]);
      const event = id("0a403");
      await publish(c, CS_DRAFT, 2, event, TENANT_A, BOOK_A, PROD_A2);
      expect(
        await sp(c, () => c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1`, [CS_DRAFT, event])),
      ).toBe("23514");
    });
  });
});

// -----------------------------------------------------------------------------
// Tenant isolation
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — tenant isolation under FORCE RLS (app role)", () => {
  it("shows each tenant only its own content and nothing without a tenant", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of TABLES) {
      const a = await asApp(e, TENANT_A, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, a.rows.map((r) => r.t)]).toEqual([table, [TENANT_A]]);
      const b = await asApp(e, TENANT_B, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, b.rows.map((r) => r.t)]).toEqual([table, [TENANT_B]]);
      const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${table}`));
      expect([table, none.rowCount]).toEqual([table, 0]);
    }
  });

  it("refuses a cross-tenant insert and never deletes", async () => {
    if (skip()) return;
    const e = guard();
    // The insert trigger reads the set under tenant B's RLS, finds none and refuses first (non-disclosing).
    expect(await asApp(e, TENANT_B, (c) => errorCode(() => insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 })))).toBe("23514");
    // A line of tenant A's set written under tenant B is refused the same way.
    expect(await asApp(e, TENANT_B, (c) => errorCode(() => insertLine(c, { cs: CS_PUB, version: 2, lineNo: 9, itemVersion: 1 })))).toBe("23514");
    const deleted = await asApp(e, TENANT_A, (c) => c.query(`DELETE FROM price_change_set_lines`));
    expect(deleted.rowCount).toBe(0);
    // Tenant B cannot see, so cannot update, tenant A's lines.
    const updated = await asApp(e, TENANT_B, (c) =>
      c.query(`UPDATE price_change_set_lines SET new_event_id = $2 WHERE change_set_id = $1`, [CS_PUB, EVENT_PUB]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("writes a draft's items and lines as the app role under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    const failed = await asApp(e, TENANT_A, (c) =>
      errorCode(async () => {
        await c.query("SAVEPOINT app_write");
        await insertItem(c, { cs: CS_DRAFT, version: 1, position: 1 });
        await insertLine(c, { cs: CS_DRAFT, version: 1, lineNo: 1 });
        await c.query("ROLLBACK TO SAVEPOINT app_write");
      }),
    );
    expect(failed).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------------

describe("0123_price_change_set_items_lines — down migration", () => {
  // The down also drops the 0123 trigger on change_sets, so the owner owns it too.
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

  it("REFUSES while an item exists or a set records its content, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    const owner = { role: "rt1151_c2_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    // With no item or line left, a set whose header records an (empty) item list still blocks it.
    await clearContent();
    expect(await committed((c) => c.query(`UPDATE change_sets SET items_version = 1 WHERE id = $1`, [CS_DRAFT]))).toBeNull();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
  });

  it("drops the tables and functions once empty, is rerunnable, and the up recreates them", async () => {
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
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    // The 0121 core survived the round trip.
    const sets = await e.admin.query(`SELECT 1 FROM change_sets WHERE id = ANY($1)`, [[CS_PUB, CS_DRAFT, CS_B]]);
    expect(sets.rowCount).toBe(3);
  });
});
