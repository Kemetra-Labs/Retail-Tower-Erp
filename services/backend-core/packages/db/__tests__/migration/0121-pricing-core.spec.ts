/**
 * RT-1151 (RT-282 PR-05): `0121_pricing_core` migration test.
 *
 * Validates `packages/db/drizzle/0121_pricing_core.sql` (+ `.down.sql`) on a
 * real PostgreSQL 16, applied on top of every earlier migration with tenants,
 * stores and products already present (the UPGRADE path):
 *   - the seven tables match the Drizzle schema; FORCE RLS and the exact policy
 *     set (SELECT + INSERT everywhere, UPDATE on five, no DELETE);
 *   - Price Books: one non-retired Book per context (OD-1), never retired in
 *     v1, currency / tax basis / context immutable (472, Q-5), and a Book must
 *     commit with exactly one default Zone (deferred check);
 *   - Zones: the default Zone is immutable and never retired (Q-8); a Zone in
 *     use cannot be retired;
 *   - Pricing Revisions: gapless per tenant, append-only for every role;
 *   - events and memberships: published and ended only by the transaction that
 *     issued the revision (history is frozen), never edited, never deleted; no
 *     two active events of one key overlap, per time basis (23P01); a
 *     superseded event no longer blocks; the event's currency is its Book's
 *     (composite FK); no two active memberships of one Store overlap;
 *   - the fan-out: written by the issuing transaction or at the head (bootstrap);
 *   - Change Sets: identity fixed, version forward, a published set changes only
 *     to superseded / rolled_back, a terminal set never changes;
 *   - tenant isolation under FORCE RLS as the app role;
 *   - legacy price columns untouched;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while a Change Set or a Price Book exists.
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
const UP_NAME = "0121_pricing_core.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0121_pricing_core.down.sql");

const id = (n: string): string => `01210000-0000-7000-8000-0000000${n}`;
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
const CS_A1 = id("0a201");
const CS_B1 = id("0b201");
const REV_A1 = id("0a301");
const REV_B1 = id("0b301");
const EVENT_A_BOOK = id("0a401");
const EVENT_A_STORE = id("0a402");
const MEMBERSHIP_A = id("0a501");
const HASH = `sha256:${"a".repeat(64)}`;
const CORR = id("0acc1");

const TABLES = [
  "change_sets",
  "price_books",
  "price_zones",
  "pricing_revisions",
  "pricing_revision_stores",
  "price_zone_memberships",
  "price_events",
] as const;
const UPDATABLE = new Set(["change_sets", "price_books", "price_zones", "price_zone_memberships", "price_events"]);
const FUNCTIONS = [
  "pricing_append_only()",
  "pricing_no_delete()",
  "change_sets_guard()",
  "price_books_guard()",
  "price_zones_guard()",
  "price_books_has_default_zone()",
  "pricing_revisions_before_insert()",
  "pricing_revision_issued_here(uuid, bigint)",
  "pricing_revision_stores_before_insert()",
  "pricing_timeline_before_insert()",
  "pricing_timeline_guard()",
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

async function createBook(q: Q, bookId: string, tenant: string, zoneId: string, currency = "EGP"): Promise<void> {
  await q.query(
    `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'RETAIL', 'Retail', $3, 'inclusive', $4, $5)`,
    [bookId, tenant, currency, ACTOR, CORR],
  );
  await q.query(
    `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, 'DEFAULT', 'Default', true, $4, $5)`,
    [zoneId, tenant, bookId, ACTOR, CORR],
  );
}

async function createChangeSet(q: Q, csId: string, tenant: string, kind = "standard", rollsBack: string | null = null): Promise<void> {
  await q.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, created_by_user_id, correlation_id, rolls_back_change_set_id)
     VALUES ($1, $2, 'pricing', $3, 'November', $4, $5, $6, $7)`,
    [csId, tenant, kind, kind === "standard" || kind === "legacy_import" ? null : "why", ACTOR, CORR, rollsBack],
  );
}

async function insertRevision(
  q: Q,
  revId: string,
  tenant: string,
  csId: string,
  revisionNo: number,
  kind = "publish",
  rollsBackRevisionNo: number | null = null,
): Promise<void> {
  await q.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, rolls_back_revision_no, published_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [revId, tenant, revisionNo, csId, kind, rollsBackRevisionNo, ACTOR, CORR],
  );
}

/** Moves a draft set through to published at `revisionNo` (the columns the CHECKs require). */
async function markPublished(q: Q, csId: string, revisionNo: number): Promise<void> {
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

const INSERT_EVENT = `INSERT INTO price_events
  (id, tenant_id, price_book_id, scope, price_zone_id, store_id, product_id, price, currency_code, time_basis,
   effective_from_local, effective_to_local, published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'store_local', $10, $11, $12, $13, $14, $15, $16)`;

async function insertEvent(
  q: Q,
  e: {
    id: string;
    tenant?: string;
    book?: string;
    scope?: "book" | "zone" | "store";
    zone?: string | null;
    store?: string | null;
    product?: string;
    price?: string;
    currency?: string;
    from?: string;
    to?: string | null;
    revision: number;
    changeSet?: string;
    source?: string;
  },
): Promise<void> {
  await q.query(INSERT_EVENT, [
    e.id,
    e.tenant ?? TENANT_A,
    e.book ?? BOOK_A,
    e.scope ?? "book",
    e.zone ?? null,
    e.store ?? null,
    e.product ?? PROD_A1,
    e.price ?? "100.0000",
    e.currency ?? "EGP",
    e.from ?? "2026-11-01T00:00:00",
    e.to ?? null,
    e.revision,
    e.changeSet ?? CS_A1,
    e.source ?? "change_set",
    ACTOR,
    CORR,
  ]);
}

/** Runs `fn` under a savepoint so the transaction survives an expected error; returns its code or null. */
async function sp(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  const code = await errorCode(fn);
  await c.query(code === null ? "RELEASE SAVEPOINT expect_error" : "ROLLBACK TO SAVEPOINT expect_error");
  return code;
}

/** Runs `fn` under a savepoint; returns the error message or null. */
async function spMessage(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  try {
    await fn();
    await c.query("RELEASE SAVEPOINT expect_error");
    return null;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT expect_error");
    return (err as Error).message;
  }
}

const MEMBERSHIP_COLUMNS = `(id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, effective_to, published_in_revision,
   carried_forward, created_by_user_id, correlation_id)`;

async function insertMembership(
  q: Q,
  m: { id: string; zone: string; store: string; from: string; to: string | null; revision: number; carried?: boolean },
): Promise<void> {
  await q.query(
    `INSERT INTO price_zone_memberships ${MEMBERSHIP_COLUMNS} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [m.id, TENANT_A, BOOK_A, m.zone, m.store, m.from, m.to, m.revision, m.carried ?? false, ACTOR, CORR],
  );
}

/** Every row of `table` visible to the superuser (RLS is bypassed for it). */
async function count(table: string): Promise<number> {
  const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
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

/** Removes every pricing row as the superuser, with the guard triggers off (test cleanup only). */
async function clearPricing(): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "price_events",
      "price_zone_memberships",
      "pricing_revision_stores",
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    for (const table of ["pricing_revisions", "change_sets", "price_zones", "price_books"]) {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The committed baseline: Books with default Zones for A and B, and revision 1 of A and B. */
async function seedBaseline(): Promise<void> {
  const failed = await committed(async (c) => {
    await createBook(c, BOOK_A, TENANT_A, ZONE_A_DEFAULT);
    await c.query(
      `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, 'NORTH', 'North', $4, $5)`,
      [ZONE_A_NORTH, TENANT_A, BOOK_A, ACTOR, CORR],
    );
    await createBook(c, BOOK_B, TENANT_B, ZONE_B_DEFAULT);
    await createChangeSet(c, CS_A1, TENANT_A);
    await insertRevision(c, REV_A1, TENANT_A, CS_A1, 1);
    await insertEvent(c, { id: EVENT_A_BOOK, revision: 1 });
    await insertEvent(c, { id: EVENT_A_STORE, scope: "store", store: STORE_A1, price: "95.0000", revision: 1 });
    await c.query(
      `INSERT INTO price_zone_memberships
         (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, published_in_revision, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, '2026-11-01T00:00:00Z', 1, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`,
      [MEMBERSHIP_A, TENANT_A, BOOK_A, ZONE_A_NORTH, STORE_A2],
    );
    await c.query(
      `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 1, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1'), ($1, $3, 1, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`,
      [TENANT_A, STORE_A1, STORE_A2],
    );
    await markPublished(c, CS_A1, 1);
    await createChangeSet(c, CS_B1, TENANT_B);
    await insertRevision(c, REV_B1, TENANT_B, CS_B1, 1);
    await markPublished(c, CS_B1, 1);
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
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'prc-a', 'PRC A', 'EGP'), ($2, 'prc-b', 'PRC B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, default_price, default_currency_code)
     VALUES ($1, $4, 'A1', 'std', $5, $5, 12.5, 'EGP'), ($2, $4, 'A2', 'std', $5, $5, NULL, NULL), ($3, $6, 'B1', 'std', $5, $5, NULL, NULL)`,
    [PROD_A1, PROD_A2, PROD_B1, TENANT_A, ACTOR, TENANT_B],
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
// Shape: tables, Drizzle, RLS
// -----------------------------------------------------------------------------

const LATER_CHANGE_SET_COLUMNS: readonly string[] = ["rollback_from", "rollback_from_defaulted"];

describe("0121_pricing_core — shape", () => {
  it("creates the seven tables and the Drizzle schema declares exactly their columns", async () => {
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
        // Columns a LATER migration adds (the schema file is the current shape): 0127 (RT-1532) on change_sets.
        .filter((c) => !(name === "change_sets" && LATER_CHANGE_SET_COLUMNS.includes(c.name)))
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

  it("enables and FORCEs RLS with SELECT + INSERT everywhere, UPDATE on five, no DELETE", async () => {
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
      const expected = UPDATABLE.has(table) ? ["INSERT", "SELECT", "UPDATE"] : ["INSERT", "SELECT"];
      expect([table, policies.rows.map((r) => r.cmd)]).toEqual([table, expected]);
    }
  });

  it("leaves the legacy price columns and price_history untouched", async () => {
    if (skip()) return;
    const e = guard();
    const r = await e.admin.query<{ p: string }>(`SELECT default_price::text AS p FROM tenant_products WHERE id = $1`, [PROD_A1]);
    expect(r.rows[0]!.p).toBe("12.5000");
    expect(await exists("price_history")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Books and Zones
// -----------------------------------------------------------------------------

describe("0121_pricing_core — Price Books and Zones", () => {
  it("a Book must commit with its default Zone (deferred check)", async () => {
    if (skip()) return;
    await clearPricing();
    try {
      const code = await committed((c) =>
        c.query(
          `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
           VALUES ($1, $2, 'X', 'X', 'EGP', 'inclusive', $3, '01210000-0000-7000-8000-00000000acc1')`,
          [BOOK_A, TENANT_A, ACTOR],
        ),
      );
      expect(code).toBe("23514");
      expect(await count("price_books")).toBe(0);
    } finally {
      await clearPricing();
      await seedBaseline();
    }
  });

  it("allows one non-retired Book per context and one default Zone per Book", async () => {
    if (skip()) return;
    const e = guard();
    await inRolledBackTx(e.admin, async (c) => {
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, created_by_user_id, correlation_id)
             VALUES ($1, $2, 'SECOND', 'Second', 'EGP', 'inclusive', $3, '01210000-0000-7000-8000-00000000acc1')`,
            [id("0a199"), TENANT_A, ACTOR],
          ),
        ),
      ).toBe("23505");
    });
    await inRolledBackTx(e.admin, async (c) => {
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
             VALUES ($1, $2, $3, 'D2', 'D2', true, $4, '01210000-0000-7000-8000-00000000acc1')`,
            [id("0a198"), TENANT_A, BOOK_A, ACTOR],
          ),
        ),
      ).toBe("23505");
    });
  });

  it.each([
    ["currency_code = 'USD'"],
    ["tax_price_basis = 'exclusive'"],
    ["code = 'OTHER'"],
    ["retired_at = now()"],
  ])("refuses a Book change: %s", async (set) => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(`UPDATE price_books SET ${set} WHERE id = $1`, [BOOK_A]))).toBe("23514");
    });
  });

  it("allows renaming a Book", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await c.query(`UPDATE price_books SET name = 'Renamed' WHERE id = $1`, [BOOK_A]);
    });
  });

  it("never retires or changes the default Zone (Q-8) and never retires a Zone in use", async () => {
    if (skip()) return;
    const retire = `UPDATE price_zones SET retired_at = now(), retired_by_user_id = $2, retire_reason = 'x' WHERE id = $1`;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(retire, [ZONE_A_DEFAULT, ACTOR]))).toBe("23514");
    });
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(`UPDATE price_zones SET is_default = false WHERE id = $1`, [ZONE_A_DEFAULT]))).toBe("23514");
    });
    // NORTH holds the active membership of STORE_A2.
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(retire, [ZONE_A_NORTH, ACTOR]))).toBe("23514");
    });
  });

  it("retires an unused Zone once", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const unused = id("0a197");
      await c.query(
        `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, 'SOUTH', 'South', $4, '01210000-0000-7000-8000-00000000acc1')`,
        [unused, TENANT_A, BOOK_A, ACTOR],
      );
      await c.query(
        `UPDATE price_zones SET retired_at = now(), retired_by_user_id = $2, retire_reason = 'merged' WHERE id = $1`,
        [unused, ACTOR],
      );
      expect(await sp(c, () => c.query(`UPDATE price_zones SET name = 'x' WHERE id = $1`, [unused]))).toBe("23514");
    });
  });

  it("refuses DELETE and TRUNCATE on Books and Zones for every role", async () => {
    if (skip()) return;
    for (const sql of [`DELETE FROM price_books WHERE id = '${BOOK_B}'`, `TRUNCATE price_zones CASCADE`]) {
      await inRolledBackTx(guard().admin, async (c) => {
        expect(await sp(c, () => c.query(sql))).toBe("42501");
      });
    }
  });
});

// -----------------------------------------------------------------------------
// Revisions, events, memberships, fan-out
// -----------------------------------------------------------------------------

describe("0121_pricing_core — revisions and the timeline", () => {
  it("allocates revisions gaplessly per tenant", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a202"), TENANT_A);
      expect(await sp(c, () => insertRevision(c, id("0a302"), TENANT_A, id("0a202"), 3))).toBe("23514");
    });
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a202"), TENANT_A);
      await insertRevision(c, id("0a302"), TENANT_A, id("0a202"), 2);
    });
  });

  it("revisions and fan-out rows are append-only for every role", async () => {
    if (skip()) return;
    for (const sql of [
      `UPDATE pricing_revisions SET earliest_effective_at = now()`,
      `DELETE FROM pricing_revisions`,
      `TRUNCATE pricing_revisions CASCADE`,
      `UPDATE pricing_revision_stores SET revision_no = 1`,
      `DELETE FROM pricing_revision_stores`,
    ]) {
      await inRolledBackTx(guard().admin, async (c) => {
        expect([sql, await sp(c, () => c.query(sql))]).toEqual([sql, "42501"]);
      });
    }
  });

  it("publishes an event only in the transaction that issued its revision", async () => {
    if (skip()) return;
    // Revision 1 was committed earlier: a new event cannot be slipped into it.
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => insertEvent(c, { id: id("0a499"), product: PROD_A2, revision: 1 }))).toBe("23514");
    });
    // An event cannot be published already ended.
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a203"), TENANT_A);
      await insertRevision(c, id("0a303"), TENANT_A, id("0a203"), 2);
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO price_events (id, tenant_id, price_book_id, scope, product_id, price, currency_code, time_basis,
               effective_from_local, state, published_in_revision, ended_in_revision, change_set_id, source, created_by_user_id, correlation_id)
             VALUES ($1, $2, $3, 'book', $4, 1, 'EGP', 'store_local', '2026-12-01T00:00', 'superseded', 2, 2, $5, 'change_set', '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`,
            [id("0a498"), TENANT_A, BOOK_A, PROD_A2, id("0a203")],
          ),
        ),
      ).not.toBeNull();
    });
  });

  it("refuses an overlapping active event of the same key, per time basis", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a204"), TENANT_A);
      await insertRevision(c, id("0a304"), TENANT_A, id("0a204"), 2);
      expect(
        await sp(c, () => insertEvent(c, { id: id("0a497"), from: "2026-12-01T00:00:00", revision: 2, changeSet: id("0a204") })),
      ).toBe("23P01");
    });
    // A different scope target, product or a disjoint interval is fine.
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a205"), TENANT_A);
      await insertRevision(c, id("0a305"), TENANT_A, id("0a205"), 2);
      await insertEvent(c, { id: id("0a496"), scope: "store", store: STORE_A2, revision: 2, changeSet: id("0a205") });
      await insertEvent(c, { id: id("0a495"), product: PROD_A2, revision: 2, changeSet: id("0a205") });
      await insertEvent(c, {
        id: id("0a494"),
        scope: "zone",
        zone: ZONE_A_NORTH,
        from: "2026-12-01T00:00:00",
        to: "2027-01-01T00:00:00",
        revision: 2,
        changeSet: id("0a205"),
      });
      expect(
        await sp(c, () =>
          insertEvent(c, {
            id: id("0a493"),
            scope: "zone",
            zone: ZONE_A_NORTH,
            from: "2026-12-15T00:00:00",
            revision: 2,
            changeSet: id("0a205"),
          }),
        ),
      ).toBe("23P01");
    });
  });

  it("supersedes an event only with a revision issued by the same transaction; then it no longer blocks", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      // Ending with the old, committed revision 1 is refused.
      expect(
        await sp(c, () =>
          c.query(`UPDATE price_events SET state = 'superseded', ended_in_revision = 1 WHERE id = $1`, [EVENT_A_BOOK]),
        ),
      ).not.toBeNull();
    });
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a206"), TENANT_A);
      await insertRevision(c, id("0a306"), TENANT_A, id("0a206"), 2);
      await c.query(`UPDATE price_events SET state = 'superseded', ended_in_revision = 2 WHERE id = $1`, [EVENT_A_BOOK]);
      await insertEvent(c, { id: id("0a492"), price: "110.0000", revision: 2, changeSet: id("0a206") });
      // A superseded row never changes again.
      expect(
        await sp(c, () => c.query(`UPDATE price_events SET state = 'cancelled' WHERE id = $1`, [EVENT_A_BOOK])),
      ).toBe("23514");
    });
  });

  it("never edits an event and never deletes one", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a207"), TENANT_A);
      await insertRevision(c, id("0a307"), TENANT_A, id("0a207"), 2);
      expect(
        await sp(c, () =>
          c.query(
            `UPDATE price_events SET state = 'superseded', ended_in_revision = 2, price = 1 WHERE id = $1`,
            [EVENT_A_BOOK],
          ),
        ),
      ).toBe("23514");
    });
    for (const sql of [`DELETE FROM price_events`, `TRUNCATE price_events`, `DELETE FROM price_zone_memberships`]) {
      await inRolledBackTx(guard().admin, async (c) => {
        expect(await sp(c, () => c.query(sql))).toBe("42501");
      });
    }
  });

  it("an event's currency is its Book's currency, and its scope target matches its scope", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a208"), TENANT_A);
      await insertRevision(c, id("0a308"), TENANT_A, id("0a208"), 2);
      expect(
        await sp(c, () => insertEvent(c, { id: id("0a491"), product: PROD_A2, currency: "USD", revision: 2, changeSet: id("0a208") })),
      ).toBe("23503");
    });
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a209"), TENANT_A);
      await insertRevision(c, id("0a309"), TENANT_A, id("0a209"), 2);
      expect(
        await sp(c, () =>
          insertEvent(c, { id: id("0a490"), scope: "store", store: null, product: PROD_A2, revision: 2, changeSet: id("0a209") }),
        ),
      ).toBe("23514");
    });
  });

  it("refuses overlapping active memberships of one Store in one Book", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a210"), TENANT_A);
      await insertRevision(c, id("0a310"), TENANT_A, id("0a210"), 2);
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO price_zone_memberships
               (id, tenant_id, price_book_id, price_zone_id, store_id, effective_from, published_in_revision, created_by_user_id, correlation_id)
             VALUES ($1, $2, $3, $4, $5, '2026-12-01T00:00:00Z', 2, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`,
            [id("0a502"), TENANT_A, BOOK_A, ZONE_A_DEFAULT, STORE_A2],
          ),
        ),
      ).toBe("23P01");
    });
  });

  it("writes fan-out rows in the issuing transaction or at the head (Store bootstrap)", async () => {
    if (skip()) return;
    // The issuing transaction may write fan-out rows for its own revision.
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a211"), TENANT_A);
      await insertRevision(c, id("0a311"), TENANT_A, id("0a211"), 2);
      await c.query(`INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 2, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`, [TENANT_A, STORE_A1]);
    });
    // Revision 1 is A's head: a bootstrap row at the head is accepted.
    await inRolledBackTx(guard().admin, async (c) => {
      const store = id("0a013");
      await c.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A3', 'A3')`, [store, TENANT_A]);
      await c.query(`INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 1, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`, [TENANT_A, store]);
    });
  });

  it("refuses a fan-out row for a past revision that is not the head", async () => {
    if (skip()) return;
    const failed = await committed(async (c) => {
      await createChangeSet(c, id("0a212"), TENANT_A);
      await insertRevision(c, id("0a312"), TENANT_A, id("0a212"), 2);
      await markPublished(c, id("0a212"), 2);
    });
    expect(failed).toBeNull();
    try {
      await inRolledBackTx(guard().admin, async (c) => {
        const store = id("0a014");
        await c.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A4', 'A4')`, [store, TENANT_A]);
        expect(
          await sp(c, () =>
            c.query(`INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 1, '01210000-0000-7000-8000-00000000a0a1', '01210000-0000-7000-8000-00000000acc1')`, [TENANT_A, store]),
          ),
        ).toBe("23514");
      });
    } finally {
      await clearPricing();
      await seedBaseline();
    }
  });
});

// -----------------------------------------------------------------------------
// Change Sets
// -----------------------------------------------------------------------------

describe("0121_pricing_core — Change Set header", () => {
  it("a published set changes only to superseded or rolled_back", async () => {
    if (skip()) return;
    for (const sql of [
      `UPDATE change_sets SET title = 'x' WHERE id = '${CS_A1}'`,
      `UPDATE change_sets SET state = 'draft' WHERE id = '${CS_A1}'`,
      `UPDATE change_sets SET revision_no = NULL, state = 'draft' WHERE id = '${CS_A1}'`,
    ]) {
      await inRolledBackTx(guard().admin, async (c) => {
        expect([sql, await sp(c, () => c.query(sql))]).toEqual([sql, "23514"]);
      });
    }
    await inRolledBackTx(guard().admin, async (c) => {
      await c.query(`UPDATE change_sets SET state = 'superseded' WHERE id = $1`, [CS_A1]);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'published' WHERE id = $1`, [CS_A1]))).toBe("23514");
    });
  });

  it("identity and creation facts never change and the version only moves forward", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const draft = id("0a213");
      await createChangeSet(c, draft, TENANT_A);
      await c.query(`UPDATE change_sets SET version = 3, title = 'Edited' WHERE id = $1`, [draft]);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET version = 2 WHERE id = $1`, [draft]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET kind = 'emergency', reason = 'r' WHERE id = $1`, [draft]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE change_sets SET created_by_user_id = $2 WHERE id = $1`, [draft, APPROVER]))).toBe("23514");
    });
  });

  it("emergency and rollback carry a reason; a past-draft state needs a preview; a cancelled set is frozen", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id) VALUES ($1, $2, 'pricing', 'emergency', 'E', $3, '01210000-0000-7000-8000-00000000acc1')`,
            [id("0a214"), TENANT_A, ACTOR],
          ),
        ),
      ).toBe("23514");
    });
    await inRolledBackTx(guard().admin, async (c) => {
      const draft = id("0a215");
      await createChangeSet(c, draft, TENANT_A);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET state = 'validated' WHERE id = $1`, [draft]))).toBe("23514");
      await c.query(`UPDATE change_sets SET state = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1`, [
        draft,
        ACTOR,
      ]);
      expect(await sp(c, () => c.query(`UPDATE change_sets SET title = 'x' WHERE id = $1`, [draft]))).toBe("23514");
    });
  });

  it("refuses DELETE on Change Sets", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(`DELETE FROM change_sets`))).toBe("42501");
    });
  });
});


// -----------------------------------------------------------------------------
// Publish flows the constraints must allow (spec 041 data-model, spec 042, spec 044)
// -----------------------------------------------------------------------------

describe("0121_pricing_core — publish flows", () => {
  it("refuses publishing into, or ending with, a revision committed by another transaction", async () => {
    if (skip()) return;
    const failed = await committed(async (c) => {
      await createChangeSet(c, id("0a220"), TENANT_A);
      await insertRevision(c, id("0a320"), TENANT_A, id("0a220"), 2);
      await markPublished(c, id("0a220"), 2);
    });
    expect(failed).toBeNull();
    try {
      await inRolledBackTx(guard().admin, async (c) => {
        expect(
          await spMessage(c, () => insertEvent(c, { id: id("0a480"), product: PROD_A2, revision: 2, changeSet: id("0a220") })),
        ).toMatch(/was not issued by this transaction/);
        expect(
          await spMessage(c, () =>
            c.query(`UPDATE price_events SET state = 'superseded', ended_in_revision = 2 WHERE id = $1`, [EVENT_A_BOOK]),
          ),
        ).toMatch(/was not issued by this transaction/);
        expect(
          await spMessage(c, () =>
            c.query(`UPDATE price_zone_memberships SET state = 'superseded', ended_in_revision = 2 WHERE id = $1`, [MEMBERSHIP_A]),
          ),
        ).toMatch(/was not issued by this transaction/);
      });
    } finally {
      await clearPricing();
      await seedBaseline();
    }
  });

  it("publishes a Zone move: the old row superseded, carried-forward head and tail, the new row (data-model §2.3)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0a221"), TENANT_A);
      await insertRevision(c, id("0a321"), TENANT_A, id("0a221"), 2);
      await c.query(`UPDATE price_zone_memberships SET state = 'superseded', ended_in_revision = 2 WHERE id = $1`, [MEMBERSHIP_A]);
      await insertMembership(c, { id: id("0a510"), zone: ZONE_A_NORTH, store: STORE_A2, from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z", revision: 2, carried: true });
      await insertMembership(c, { id: id("0a511"), zone: ZONE_A_DEFAULT, store: STORE_A2, from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z", revision: 2 });
      await insertMembership(c, { id: id("0a512"), zone: ZONE_A_NORTH, store: STORE_A2, from: "2027-01-01T00:00:00Z", to: null, revision: 2, carried: true });
      await c.query(
        `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 2, $3, $4)`,
        [TENANT_A, STORE_A2, ACTOR, CORR],
      );
      await markPublished(c, id("0a221"), 2);
      const active = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM price_zone_memberships WHERE store_id = $1 AND state = 'active'`,
        [STORE_A2],
      );
      expect(active.rows[0]!.n).toBe("3");
    });
  });

  it("publishes the system legacy-import set with no preview or approval (spec 044 §4.2)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const cs = id("0a222");
      await createChangeSet(c, cs, TENANT_A, "legacy_import");
      await insertRevision(c, id("0a322"), TENANT_A, cs, 2, "legacy_import");
      await insertEvent(c, { id: id("0a481"), product: PROD_A2, revision: 2, changeSet: cs, source: "legacy_import" });
      await c.query(
        `UPDATE change_sets SET state = 'published', revision_no = 2, published_by_user_id = $2, published_at = now() WHERE id = $1`,
        [cs, ACTOR],
      );
    });
  });

  it("publishes a rollback set: a rollback revision, the target rolled_back", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const rb = id("0a223");
      await createChangeSet(c, rb, TENANT_A, "rollback", CS_A1);
      await insertRevision(c, id("0a323"), TENANT_A, rb, 2, "rollback", 1);
      await c.query(`UPDATE price_events SET state = 'superseded', ended_in_revision = 2 WHERE id = $1`, [EVENT_A_STORE]);
      await markPublished(c, rb, 2);
      await c.query(`UPDATE change_sets SET state = 'rolled_back' WHERE id = $1`, [CS_A1]);
      // A second live rollback of the same set is refused by uq_change_sets_rolls_back.
      expect(await sp(c, () => createChangeSet(c, id("0a224"), TENANT_A, "rollback", CS_A1))).toBe("23505");
    });
  });

  it("a published set names its OWN revision, never another set's", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      // Revision 1 is already CS_A1's: the unique key refuses reusing it.
      const other = id("0a225");
      await createChangeSet(c, other, TENANT_A);
      expect(await sp(c, () => markPublished(c, other, 1))).toBe("23505");
      // Revision 2 belongs to set X and no set records it yet: set Y naming it is the FK's refusal.
      const x = id("0a227");
      await createChangeSet(c, x, TENANT_A);
      await insertRevision(c, id("0a327"), TENANT_A, x, 2);
      expect(await sp(c, () => markPublished(c, other, 2))).toBe("23503");
      await markPublished(c, x, 2);
    });
  });

  it("refuses an event or membership in a retired Zone, and retiring a Zone a price event uses", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      const south = id("0a196");
      await c.query(
        `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, 'SOUTH', 'South', $4, $5)`,
        [south, TENANT_A, BOOK_A, ACTOR, CORR],
      );
      await c.query(
        `UPDATE price_zones SET retired_at = now(), retired_by_user_id = $2, retire_reason = 'closed' WHERE id = $1`,
        [south, ACTOR],
      );
      await createChangeSet(c, id("0a226"), TENANT_A);
      await insertRevision(c, id("0a326"), TENANT_A, id("0a226"), 2);
      expect(
        await spMessage(c, () =>
          insertEvent(c, { id: id("0a482"), scope: "zone", zone: south, product: PROD_A2, revision: 2, changeSet: id("0a226") }),
        ),
      ).toMatch(/is retired/);
      expect(
        await spMessage(c, () =>
          insertMembership(c, { id: id("0a513"), zone: south, store: STORE_A1, from: "2026-12-01T00:00:00Z", to: null, revision: 2 }),
        ),
      ).toMatch(/is retired/);
      const east = id("0a195");
      await c.query(
        `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, 'EAST', 'East', $4, $5)`,
        [east, TENANT_A, BOOK_A, ACTOR, CORR],
      );
      await insertEvent(c, { id: id("0a483"), scope: "zone", zone: east, product: PROD_A2, revision: 2, changeSet: id("0a226") });
      expect(
        await sp(c, () =>
          c.query(`UPDATE price_zones SET retired_at = now(), retired_by_user_id = $2, retire_reason = 'x' WHERE id = $1`, [east, ACTOR]),
        ),
      ).toBe("23514");
    });
  });

  it("runs a whole publish as the app role under FORCE RLS (gapless counter, guards, fan-out)", async () => {
    if (skip()) return;
    const e = guard();
    await asApp(e, TENANT_B, async (c) => {
      const cs = id("0b230");
      await createChangeSet(c, cs, TENANT_B);
      await insertRevision(c, id("0b330"), TENANT_B, cs, 2);
      await insertEvent(c, { id: id("0b480"), tenant: TENANT_B, book: BOOK_B, product: PROD_B1, revision: 2, changeSet: cs });
      await c.query(
        `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id) VALUES ($1, $2, 2, $3, $4)`,
        [TENANT_B, STORE_B1, ACTOR, CORR],
      );
      await markPublished(c, cs, 2);
      // Under RLS the counter still sees tenant B's head: the next revision is 3, so 2 again is refused.
      expect(await spMessage(c, () => insertRevision(c, id("0b331"), TENANT_B, id("0b231"), 2))).toMatch(/the next Pricing Revision is 3/);
    });
  });
});

// -----------------------------------------------------------------------------
// Tenant isolation
// -----------------------------------------------------------------------------

describe("0121_pricing_core — tenant isolation under FORCE RLS (app role)", () => {
  it.each(TABLES)("%s: own tenant only; an empty GUC sees nothing", async (table) => {
    if (skip()) return;
    const e = guard();
    const all = await e.admin.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`);
    const own = await asApp(e, TENANT_B, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
    expect(own.rows.every((r) => r.t === TENANT_B)).toBe(true);
    if (all.rows.some((r) => r.t === TENANT_A)) {
      const a = await asApp(e, TENANT_A, (c) => c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [TENANT_A]));
      expect(a.rowCount).toBeGreaterThan(0);
    }
    const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${table}`));
    expect(none.rowCount).toBe(0);
  });

  it("refuses a cross-tenant insert and never deletes", async () => {
    if (skip()) return;
    const e = guard();
    expect(
      await asApp(e, TENANT_B, (c) =>
        errorCode(() =>
          c.query(
            `INSERT INTO change_sets (id, tenant_id, domain, kind, title, created_by_user_id, correlation_id) VALUES ($1, $2, 'pricing', 'standard', 'T', $3, '01210000-0000-7000-8000-00000000acc1')`,
            [id("0b202"), TENANT_A, ACTOR],
          ),
        ),
      ),
    ).toBe("42501");
    const deleted = await asApp(e, TENANT_A, (c) => c.query(`DELETE FROM price_zones WHERE tenant_id = $1`, [TENANT_A]));
    expect(deleted.rowCount).toBe(0);
  });

  it("refuses a cross-tenant reference through the composite FKs", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await createChangeSet(c, id("0b203"), TENANT_B);
      await insertRevision(c, id("0b303"), TENANT_B, id("0b203"), 2);
      // Tenant B's event naming tenant A's product.
      expect(
        await sp(c, () =>
          insertEvent(c, {
            id: id("0b401"),
            tenant: TENANT_B,
            book: BOOK_B,
            product: PROD_A1,
            revision: 2,
            changeSet: id("0b203"),
          }),
        ),
      ).toBe("23503");
    });
  });
});

// -----------------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------------

describe("0121_pricing_core — down migration", () => {
  const OWNER_TABLES = [...TABLES, "tenants"];

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

  it("REFUSES while a Change Set or a Price Book exists, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    const owner = { role: "rt1151_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    // A Price Book alone also blocks it.
    await clearPricing();
    try {
      expect(await committed((c) => createBook(c, BOOK_A, TENANT_A, ZONE_A_DEFAULT))).toBeNull();
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    } finally {
      await clearPricing();
    }
  });

  it("drops the tables and functions once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await clearPricing();
    const owner = { role: "rt1151_down_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, false]);
    const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname = ANY($1)`, [FUNCTIONS.map((f) => f.replace(/\(.*\)$/, ""))]);
    expect(fns.rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    // The catalog survived the round trip.
    const products = await e.admin.query(`SELECT 1 FROM tenant_products WHERE id = ANY($1)`, [[PROD_A1, PROD_A2, PROD_B1]]);
    expect(products.rowCount).toBe(3);
  });
});
