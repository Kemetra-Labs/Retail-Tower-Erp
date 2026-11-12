/**
 * RT-1336 (RT-286 spec 048 slice S3): `0101_offer_engine` migration test.
 *
 * Validates `packages/db/drizzle/0101_offer_engine.sql` (+ `.down.sql`) on a
 * real PostgreSQL 16 (Testcontainers), applied on top of every earlier
 * migration (0100's sale_lines key included) with a catalog, a sale and a
 * return already present (the UPGRADE path):
 *   - FORCE RLS and the exact policy set on all ten tables (SELECT + INSERT
 *     everywhere, UPDATE only on the four guarded tables, no DELETE policy);
 *   - AC2 immutability: a published version (row, store scope, rules), a Pack
 *     revision, a sale_line_promotions row and a clawback refuse UPDATE,
 *     DELETE and TRUNCATE for every role (the superuser included); a version's
 *     scope and rules can only be written in its own transaction;
 *   - version numbering, the deferred "whole version" check (an include rule;
 *     a store unless all_stores), the V1 parameter domain, the schedule shape;
 *   - offers: draft revision never moves back, end and archive are recorded
 *     once, an archived offer never changes and gets no version;
 *   - pauses: one open whole-offer pause and one per store, resumed once;
 *   - Pack revisions gapless per tenant, the per-store applied revision only
 *     moves forward;
 *   - materialised eligible sets: rows open and close only at the latest
 *     revision (history frozen), and the OD-7 Pack invariant (a product in at
 *     most one offer per store in any revision) is refused with 23P01;
 *   - sale_line_promotions: the composite FK pins it to a line of the same
 *     sale, store and tenant; the line arithmetic (whole quantity, net
 *     invariant, quantity 1 on a reward) is refused when it does not hold;
 *   - tenant isolation under FORCE RLS as the app role on every table: own
 *     tenant only, an empty tenant GUC sees nothing, cross-tenant INSERT
 *     refused, no DELETE, cross-tenant references refused by the FKs;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while an offer or a Pack revision exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PoolClient } from "pg";

import * as schema from "../../src/schema";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0101_offer_engine.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0101_offer_engine.down.sql");

const id = (n: string): string => `01010000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A1 = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B1 = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_B = id("0b021");
const PROD_A1 = id("0a031");
const PROD_A2 = id("0a032");
const PROD_A3 = id("0a033");
const PROD_B1 = id("0b031");
const CAT_A = id("0a041");
const CAT_B = id("0b041");
const BRAND_A = id("0a051");
const BRAND_B = id("0b051");
const OFFER_A = id("0a061");
const OFFER_A2 = id("0a062");
const OFFER_A3 = id("0a063");
const OFFER_B = id("0b061");
const SALE_A = id("0a071");
const SALE_A_OTHER = id("0a072");
const SALE_B = id("0b071");
/** qty 1, unit 100, net 60: a reward line at 40% off. */
const LINE_REWARD = id("0a081");
/** qty 2, unit 50, net 100: an eligible line that is not a reward. */
const LINE_PLAIN = id("0a082");
/** qty 1.5 (measured): never takes part (F-9). */
const LINE_MEASURED = id("0a083");
/** qty 2, unit 50, net 80: a (wrong) reward on quantity 2. */
const LINE_QTY2_DISCOUNTED = id("0a084");
const LINE_B = id("0b081");
const RETURN_A = id("0a091");
const ACTOR = id("0a0a1");
const PAUSE_1 = id("0a0c1");
const PAUSE_2 = id("0a0c2");
const PAUSE_3 = id("0a0c3");

const TABLES = [
  "offers",
  "offer_versions",
  "offer_version_stores",
  "offer_version_rules",
  "offer_pauses",
  "offer_pack_revisions",
  "offer_pack_store_revisions",
  "offer_pack_eligible_products",
  "sale_line_promotions",
  "sale_return_promotion_clawbacks",
] as const;
const UPDATABLE = new Set(["offers", "offer_pauses", "offer_pack_store_revisions", "offer_pack_eligible_products"]);
const FUNCTIONS = [
  "offer_engine_append_only()",
  "offers_guard()",
  "offer_versions_before_insert()",
  "offer_version_children_guard()",
  "offer_versions_complete()",
  "offer_pauses_guard()",
  "offer_pack_revisions_before_insert()",
  "offer_pack_store_revisions_guard()",
  "offer_pack_eligible_products_guard()",
  "sale_line_promotions_line_guard()",
  "sale_return_promotion_clawbacks_guard()",
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

const INSERT_OFFER = `INSERT INTO offers (id, tenant_id, created_by_user_id) VALUES ($1, $2, $3)`;
const INSERT_VERSION = `INSERT INTO offer_versions
  (tenant_id, offer_id, version, name_ar, offer_type, buy_quantity, get_quantity, percent_off, reward_selection,
   price_basis, all_stores, time_basis, starts_local, eligible_set_count, published_by_user_id)
  VALUES ($1, $2, $3, 'القطعة التانية بخصم 40%', 'buy_x_get_y_percent', 1, 1, 40, 'cheapest',
          'resolved_store_price', $4, 'store_local', '2026-12-01T00:00', 1, $5)`;
const INSERT_RULE = `INSERT INTO offer_version_rules (tenant_id, offer_id, version, effect, product_id, category_id, brand_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;
const INSERT_SCOPE = `INSERT INTO offer_version_stores (tenant_id, offer_id, version, store_id) VALUES ($1, $2, $3, $4)`;
const INSERT_REVISION = `INSERT INTO offer_pack_revisions (tenant_id, revision) VALUES ($1, $2)`;
const INSERT_ELIGIBLE = `INSERT INTO offer_pack_eligible_products
  (tenant_id, store_id, product_id, offer_id, offer_version, from_revision) VALUES ($1, $2, $3, $4, $5, $6)`;
const INSERT_PROMOTION = `INSERT INTO sale_line_promotions
  (sale_line_id, sale_id, tenant_id, store_id, offer_id, offer_version, pack_revision, discount_amount)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
const INSERT_CLAWBACK = `INSERT INTO sale_return_promotion_clawbacks
  (return_id, tenant_id, store_id, offer_id, offer_version, amount) VALUES ($1, $2, $3, $4, $5, $6)`;
const INSERT_PAUSE = `INSERT INTO offer_pauses (id, tenant_id, offer_id, store_id, reason, paused_by_user_id)
  VALUES ($1, $2, $3, $4, 'stock issue', $5)`;

/** Run one statement inside a savepoint; returns its error code or null, and leaves the transaction usable. */
async function attempt(client: PoolClient, sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT attempt");
    return null;
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    return (err as { code?: string }).code ?? "unknown";
  }
}

/** Superuser work in one transaction that is always rolled back. */
async function rolledBack(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Superuser work in one committed transaction. */
async function committed(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface Rule {
  readonly effect?: "include" | "exclude";
  readonly product?: string;
  readonly category?: string;
  readonly brand?: string;
}

/** Insert one published version and its children, in the caller's transaction. */
async function publish(
  client: PoolClient,
  tenant: string,
  offer: string,
  version: number,
  opts: { allStores?: boolean; stores?: readonly string[]; rules?: readonly Rule[] } = {},
): Promise<void> {
  const allStores = opts.allStores ?? true;
  await client.query(INSERT_VERSION, [tenant, offer, version, allStores, ACTOR]);
  for (const store of opts.stores ?? []) await client.query(INSERT_SCOPE, [tenant, offer, version, store]);
  for (const r of opts.rules ?? [{ product: tenant === TENANT_A ? PROD_A1 : PROD_B1 }]) {
    await client.query(INSERT_RULE, [
      tenant,
      offer,
      version,
      r.effect ?? "include",
      r.product ?? null,
      r.category ?? null,
      r.brand ?? null,
    ]);
  }
}

/**
 * Committed seed used by the isolation and round-trip cases: per tenant one
 * offer with version 1, Pack revision 1 with its eligible product, the store
 * revision and a promotion fact; tenant A also a clawback.
 */
async function seedCommitted(): Promise<void> {
  await committed(async (c) => {
    await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
    await c.query(INSERT_OFFER, [OFFER_B, TENANT_B, ACTOR]);
    await publish(c, TENANT_A, OFFER_A, 1, { allStores: false, stores: [STORE_A1] });
    await publish(c, TENANT_B, OFFER_B, 1, { allStores: false, stores: [STORE_B1] });
    await c.query(INSERT_REVISION, [TENANT_A, 1]);
    await c.query(INSERT_REVISION, [TENANT_B, 1]);
    await c.query(INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1]);
    await c.query(INSERT_ELIGIBLE, [TENANT_B, STORE_B1, PROD_B1, OFFER_B, 1, 1]);
    await c.query(`INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision) VALUES ($1, $2, 1)`, [
      TENANT_A,
      STORE_A1,
    ]);
    await c.query(`INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision) VALUES ($1, $2, 1)`, [
      TENANT_B,
      STORE_B1,
    ]);
    await c.query(INSERT_PAUSE, [PAUSE_1, TENANT_A, OFFER_A, STORE_A2, ACTOR]);
    await c.query(INSERT_PROMOTION, [LINE_REWARD, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, "40.00"]);
    await c.query(INSERT_PROMOTION, [LINE_B, SALE_B, TENANT_B, STORE_B1, OFFER_B, 1, 1, "0"]);
    await c.query(INSERT_CLAWBACK, [RETURN_A, TENANT_A, STORE_A1, OFFER_A, 1, "16.00"]);
  });
}

/** Superuser cleanup: the facts are append-only, so the user triggers are bypassed (replica role). */
async function clearOffers(): Promise<void> {
  await committed(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    for (const table of [...TABLES].reverse()) await c.query(`DELETE FROM ${table}`);
  });
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0101-offer-engine.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'ofr-a', 'OFR A', 'EGP'), ($2, 'ofr-b', 'OFR B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $3, $4, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A1, TENANT_B, STORE_B1],
  );
  await a.query(
    `INSERT INTO tenant_product_categories (id, tenant_id, name, created_by) VALUES ($1, $3, 'Shoes', $4), ($2, $5, 'Shoes', $4)`,
    [CAT_A, CAT_B, TENANT_A, ACTOR, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_product_brands (id, tenant_id, name, created_by) VALUES ($1, $3, 'Nile', $4), ($2, $5, 'Nile', $4)`,
    [BRAND_A, BRAND_B, TENANT_A, ACTOR, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, category_id, brand_id)
     VALUES ($1, $5, 'A1', 'std', $7, $7, $8, $9), ($2, $5, 'A2', 'std', $7, $7, NULL, NULL),
            ($3, $5, 'A3', 'std', $7, $7, NULL, NULL), ($4, $6, 'B1', 'std', $7, $7, $10, $11)`,
    [PROD_A1, PROD_A2, PROD_A3, PROD_B1, TENANT_A, TENANT_B, ACTOR, CAT_A, BRAND_A, CAT_B, BRAND_B],
  );
  const sale = `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                  source_system, external_id, payload_hash, created_by, device_id)
                VALUES ($1, $2, $3, 'EGP', 100, '2026-12-02T10:00:00Z', '2026-12-02', 'pos', $4, repeat('a', 64), $5, $6)`;
  await a.query(sale, [SALE_A, TENANT_A, STORE_A1, "ext-a", ACTOR, DEVICE_A]);
  await a.query(sale, [SALE_A_OTHER, TENANT_A, STORE_A1, "ext-a2", ACTOR, DEVICE_A]);
  await a.query(sale, [SALE_B, TENANT_B, STORE_B1, "ext-b", ACTOR, DEVICE_B]);
  const line = `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                  line_amount, unit, tenant_product_ref)
                VALUES ($1, $2, $3, $4, 'L', $5, 'EGP', $6, $7, 'pcs', $8)`;
  await a.query(line, [LINE_REWARD, SALE_A, TENANT_A, STORE_A1, "100", "1", "60", PROD_A1]);
  await a.query(line, [LINE_PLAIN, SALE_A, TENANT_A, STORE_A1, "50", "2", "100", PROD_A1]);
  await a.query(line, [LINE_MEASURED, SALE_A, TENANT_A, STORE_A1, "10", "1.5", "15", PROD_A1]);
  await a.query(line, [LINE_QTY2_DISCOUNTED, SALE_A, TENANT_A, STORE_A1, "50", "2", "80", PROD_A1]);
  await a.query(line, [LINE_B, SALE_B, TENANT_B, STORE_B1, "100", "1", "100", PROD_B1]);
  await a.query(
    `INSERT INTO sale_returns
       (id, sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, '2026-12-03', 'EGP', 44, 'pos', 'ret-a', repeat('f', 64), $5)`,
    [RETURN_A, SALE_A, TENANT_A, STORE_A1, ACTOR],
  );
  await a.query(upSql);
  // The app role's table grants are taken after the tables exist.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

describe("0101: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0101: the Drizzle schema matches the database", () => {
  it("declares exactly each table's columns, with the same nullability", async () => {
    if (skip()) return;
    const drizzle = Object.values(schema as unknown as Record<string, unknown>).filter((t) => {
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
      const db = await guard().admin.query<{ c: string }>(
        `SELECT column_name || ':' || is_nullable AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      expect([name, declared]).toEqual([name, db.rows.map((r) => r.c).sort()]);
    }
  });
});

describe("0101: RLS and policies", () => {
  it("forces RLS on all ten tables", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r' ORDER BY relname`,
      [[...TABLES]],
    );
    expect(r.rows).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
  });

  it("has SELECT and INSERT tenant policies everywhere, UPDATE only on the guarded tables, and no DELETE policy", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ tablename: string; policyname: string; cmd: string }>(
      `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename, policyname`,
      [[...TABLES]],
    );
    const expected = [...TABLES]
      .sort()
      .flatMap((t) => [
        { tablename: t, policyname: `${t}_tenant_insert`, cmd: "INSERT" },
        { tablename: t, policyname: `${t}_tenant_select`, cmd: "SELECT" },
        ...(UPDATABLE.has(t) ? [{ tablename: t, policyname: `${t}_tenant_update`, cmd: "UPDATE" }] : []),
      ]);
    expect(r.rows).toEqual(expected);
  });

  it("references sale_lines through the 0100 composite key, and categories through the new (id, tenant_id) key", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('fk_sale_line_promotions_line', 'fk_offer_version_rules_category_tenant') ORDER BY conname`,
    );
    expect(r.rows).toEqual([
      {
        conname: "fk_offer_version_rules_category_tenant",
        def: "FOREIGN KEY (category_id, tenant_id) REFERENCES tenant_product_categories(id, tenant_id) ON DELETE RESTRICT",
      },
      {
        conname: "fk_sale_line_promotions_line",
        def: "FOREIGN KEY (sale_line_id, sale_id, tenant_id, store_id) REFERENCES sale_lines(id, sale_id, tenant_id, store_id) ON DELETE RESTRICT",
      },
    ]);
  });
});

// -----------------------------------------------------------------------------
// Offers and versions
// -----------------------------------------------------------------------------

describe("0101: offers", () => {
  it("keeps a draft whole, never moves the draft revision back, and records an end once", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      const setDraft = `UPDATE offers SET draft_revision = $2, draft_definition = $3::jsonb, draft_updated_at = now(),
                          draft_updated_by_user_id = $4 WHERE id = $1`;
      expect(await attempt(c, setDraft, [OFFER_A, 1, '{"nameAr":"x"}', ACTOR])).toBeNull();
      // A draft without its author, or that is not an object, or at revision 0, is refused.
      expect(await attempt(c, `UPDATE offers SET draft_updated_by_user_id = NULL WHERE id = $1`, [OFFER_A])).toBe("23514");
      expect(await attempt(c, setDraft, [OFFER_A, 2, '["x"]', ACTOR])).toBe("23514");
      expect(await attempt(c, `INSERT INTO offers (id, tenant_id, created_by_user_id, draft_definition, draft_updated_at, draft_updated_by_user_id)
                                VALUES ($1, $2, $3, '{}', now(), $3)`, [OFFER_A2, TENANT_A, ACTOR])).toBe("23514");
      // The revision never moves back; clearing the draft keeps it.
      expect(await attempt(c, setDraft, [OFFER_A, 0, '{"nameAr":"y"}', ACTOR])).toBe("23514");
      expect(
        await attempt(c, `UPDATE offers SET draft_definition = NULL, draft_updated_at = NULL, draft_updated_by_user_id = NULL WHERE id = $1`, [OFFER_A]),
      ).toBeNull();
      // A new draft (or new content) takes a new revision, so a stale token never matches it.
      expect(await attempt(c, setDraft, [OFFER_A, 1, '{"nameAr":"z"}', ACTOR])).toBe("23514");
      expect(await attempt(c, setDraft, [OFFER_A, 2, '{"nameAr":"z"}', ACTOR])).toBe(null);
      expect(await attempt(c, `UPDATE offers SET draft_definition = '{"nameAr":"w"}' WHERE id = $1`, [OFFER_A])).toBe("23514");
      expect(await attempt(c, `UPDATE offers SET draft_revision = 3, draft_definition = '{"nameAr":"w"}' WHERE id = $1`, [OFFER_A])).toBeNull();
      expect(await attempt(c, `UPDATE offers SET tenant_id = $2 WHERE id = $1`, [OFFER_A, TENANT_B])).toBe("23514");
      // End once.
      expect(await attempt(c, `UPDATE offers SET ended_at = now(), ended_by_user_id = $2 WHERE id = $1`, [OFFER_A, ACTOR])).toBeNull();
      expect(await attempt(c, `UPDATE offers SET ended_at = now() + interval '1 hour' WHERE id = $1`, [OFFER_A])).toBe("23514");
      expect(await attempt(c, `UPDATE offers SET ended_at = NULL, ended_by_user_id = NULL WHERE id = $1`, [OFFER_A])).toBe("23514");
    });
  });

  it("never changes an archived offer, and gives it no new version", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      await c.query(`UPDATE offers SET archived_at = now(), archived_by_user_id = $2 WHERE id = $1`, [OFFER_A, ACTOR]);
      expect(await attempt(c, `UPDATE offers SET archived_at = NULL, archived_by_user_id = NULL WHERE id = $1`, [OFFER_A])).toBe("23514");
      expect(await attempt(c, `UPDATE offers SET draft_revision = 9 WHERE id = $1`, [OFFER_A])).toBe("23514");
      expect(await attempt(c, INSERT_VERSION, [TENANT_A, OFFER_A, 2, true, ACTOR])).toBe("23514");
    });
  });
});

describe("0101: offer versions (AC2: immutable once published)", () => {
  it("numbers versions 1, 2, 3 per offer with no gap, and forces the server publish time", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      expect(await attempt(c, INSERT_VERSION, [TENANT_A, OFFER_A, 2, true, ACTOR])).toBe("23514");
      expect(await attempt(c, INSERT_VERSION, [TENANT_A, OFFER_A, 0, true, ACTOR])).toBe("23514");
      await publish(c, TENANT_A, OFFER_A, 1);
      expect(await attempt(c, INSERT_VERSION, [TENANT_A, OFFER_A, 1, true, ACTOR])).toBe("23514");
      expect(await attempt(c, INSERT_VERSION, [TENANT_A, OFFER_A, 3, true, ACTOR])).toBe("23514");
      await publish(c, TENANT_A, OFFER_A, 2);
      const r = await c.query<{ version: number; same: boolean }>(
        `SELECT version, published_at = now() AS same FROM offer_versions WHERE offer_id = $1 ORDER BY version`,
        [OFFER_A],
      );
      expect(r.rows).toEqual([
        { version: 1, same: true },
        { version: 2, same: true },
      ]);
      // An explicit publish time is replaced by the server's.
      await c.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await c.query(
        `INSERT INTO offer_versions (tenant_id, offer_id, version, name_ar, offer_type, buy_quantity, get_quantity,
           percent_off, reward_selection, price_basis, all_stores, time_basis, starts_local, eligible_set_count,
           published_by_user_id, published_at)
         VALUES ($1, $2, 1, 'n', 'buy_x_get_y_percent', 1, 1, 40, 'cheapest', 'resolved_store_price', true,
                 'store_local', '2026-12-01T00:00', 1, $3, '2000-01-01T00:00:00Z')`,
        [TENANT_A, OFFER_A2, ACTOR],
      );
      const t = await c.query<{ same: boolean }>(`SELECT published_at = now() AS same FROM offer_versions WHERE offer_id = $1`, [OFFER_A2]);
      expect(t.rows).toEqual([{ same: true }]);
      await c.query(INSERT_RULE, [TENANT_A, OFFER_A2, 1, "include", PROD_A1, null, null]);
    });
  });

  it("holds the V1 parameter domain and the schedule shape", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      const base = {
        name_ar: "'n'",
        name_en: "NULL",
        offer_type: "'buy_x_get_y_percent'",
        buy_quantity: "1",
        get_quantity: "1",
        percent_off: "40",
        reward_selection: "'cheapest'",
        max_applications_per_sale: "NULL",
        price_basis: "'resolved_store_price'",
        time_basis: "'store_local'",
        starts_local: "'2026-12-01T00:00'",
        ends_local: "NULL",
        starts_at: "NULL",
        ends_at: "NULL",
        offline_policy: "'allow_cached'",
        eligible_set_count: "1",
      };
      const insertWith = async (over: Partial<typeof base>): Promise<string | null> => {
        const row = { ...base, ...over };
        const cols = Object.keys(row).join(", ");
        const vals = Object.values(row).join(", ");
        return attempt(
          c,
          `INSERT INTO offer_versions (tenant_id, offer_id, version, all_stores, published_by_user_id, ${cols})
           VALUES ($1, $2, 1, true, $3, ${vals})`,
          [TENANT_A, OFFER_A, ACTOR],
        );
      };
      for (const bad of [
        { name_ar: "''" },
        { name_ar: `'${"x".repeat(121)}'` },
        { name_en: "''" },
        { offer_type: "'fixed_amount'" },
        { buy_quantity: "0" },
        { get_quantity: "1001" },
        { percent_off: "0" },
        { percent_off: "101" },
        { reward_selection: "'most_expensive'" },
        { max_applications_per_sale: "0" },
        { price_basis: "'list_price'" },
        { offline_policy: "'always'" },
        { eligible_set_count: "-1" },
        { time_basis: "'utc'" },
        // store_local with an instant, or with fractional seconds; absolute without an instant.
        { starts_at: "'2026-12-01T00:00:00Z'" },
        { starts_local: "'2026-12-01T00:00:00.5'" },
        { time_basis: "'absolute'" },
        // [startsAt, endsAt): the end is after the start.
        { ends_local: "'2026-12-01T00:00'" },
        { time_basis: "'absolute'", starts_local: "NULL", starts_at: "'2026-12-02T00:00:00Z'", ends_at: "'2026-12-01T00:00:00Z'" },
      ]) {
        expect([JSON.stringify(bad), await insertWith(bad)]).toEqual([JSON.stringify(bad), "23514"]);
      }
      expect(await insertWith({ percent_off: "100", max_applications_per_sale: "1000", ends_local: "'2026-12-31T23:59:59'" })).toBeNull();
    });
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      expect(
        await attempt(
          c,
          `INSERT INTO offer_versions (tenant_id, offer_id, version, name_ar, offer_type, buy_quantity, get_quantity,
             percent_off, reward_selection, price_basis, all_stores, time_basis, starts_at, ends_at,
             eligible_set_count, published_by_user_id)
           VALUES ($1, $2, 1, 'n', 'buy_x_get_y_percent', 1, 1, 40, 'cheapest', 'resolved_store_price', true,
                   'absolute', '2026-12-01T00:00:00.123+02:00', NULL, 1, $3)`,
          [TENANT_A, OFFER_A, ACTOR],
        ),
      ).toBeNull();
    });
  });

  it("checks at COMMIT that a version is whole: an include rule, and a store unless all stores", async () => {
    if (skip()) return;
    const immediate = "SET CONSTRAINTS offer_versions_complete IMMEDIATE";
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      // An exclude rule alone is not enough (§5.2 rule 1).
      await publish(c, TENANT_A, OFFER_A, 1, { rules: [{ effect: "exclude", product: PROD_A2 }] });
      expect(await attempt(c, immediate)).toBe("23514");
    });
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1, { allStores: false });
      expect(await attempt(c, immediate)).toBe("23514");
    });
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1, {
        allStores: false,
        stores: [STORE_A1, STORE_A2],
        rules: [{ category: CAT_A }, { brand: BRAND_A }, { effect: "exclude", product: PROD_A2 }],
      });
      expect(await attempt(c, immediate)).toBeNull();
      // IMMEDIATE stays in force for the transaction; defer again for the next version.
      await c.query("SET CONSTRAINTS offer_versions_complete DEFERRED");
      // An all-stores version lists no store.
      await c.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A2, 1);
      expect(await attempt(c, INSERT_SCOPE, [TENANT_A, OFFER_A2, 1, STORE_A1])).toBe("23514");
    });
    // A whole version commits.
    await committed(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A3, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A3, 1, { allStores: false, stores: [STORE_A1] });
    });
    await clearOffers();
  });

  it("refuses rules with no or two dimensions, duplicates, and another tenant's product, category or brand", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      const rule = (effect: string, p: string | null, cat: string | null, b: string | null): Promise<string | null> =>
        attempt(c, INSERT_RULE, [TENANT_A, OFFER_A, 1, effect, p, cat, b]);
      expect(await rule("include", null, null, null)).toBe("23514");
      expect(await rule("include", PROD_A2, CAT_A, null)).toBe("23514");
      expect(await rule("only", PROD_A2, null, null)).toBe("23514");
      expect(await rule("include", PROD_A1, null, null)).toBe("23505");
      // The same product may be both included and excluded (exclusion wins, OD-1).
      expect(await rule("exclude", PROD_A1, null, null)).toBeNull();
      expect(await rule("include", PROD_B1, null, null)).toBe("23503");
      expect(await rule("include", null, CAT_B, null)).toBe("23503");
      expect(await rule("include", null, null, BRAND_B)).toBe("23503");
      expect(await rule("include", null, CAT_A, null)).toBeNull();
      expect(await rule("include", null, null, BRAND_A)).toBeNull();
      // Another tenant's store in the scope is refused by the composite FK.
      await c.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await c.query(INSERT_VERSION, [TENANT_A, OFFER_A2, 1, false, ACTOR]);
      expect(await attempt(c, INSERT_SCOPE, [TENANT_A, OFFER_A2, 1, STORE_B1])).toBe("23503");
    });
  });

  it("AC2: refuses UPDATE, DELETE and TRUNCATE of a published version, its scope and rules, also for the superuser", async () => {
    if (skip()) return;
    await committed(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1, { allStores: false, stores: [STORE_A1] });
    });
    try {
      await rolledBack(async (c) => {
        expect(await attempt(c, `UPDATE offer_versions SET percent_off = 90 WHERE offer_id = $1`, [OFFER_A])).toBe("42501");
        expect(await attempt(c, `UPDATE offer_versions SET name_ar = 'x' WHERE offer_id = $1`, [OFFER_A])).toBe("42501");
        expect(await attempt(c, `DELETE FROM offer_versions WHERE offer_id = $1`, [OFFER_A])).toBe("42501");
        expect(await attempt(c, `TRUNCATE offer_versions CASCADE`)).toBe("42501");
        expect(await attempt(c, `UPDATE offer_version_stores SET store_id = $2 WHERE offer_id = $1`, [OFFER_A, STORE_A2])).toBe("42501");
        expect(await attempt(c, `DELETE FROM offer_version_stores WHERE offer_id = $1`, [OFFER_A])).toBe("42501");
        expect(await attempt(c, `UPDATE offer_version_rules SET product_id = $2 WHERE offer_id = $1`, [OFFER_A, PROD_A2])).toBe("42501");
        expect(await attempt(c, `DELETE FROM offer_version_rules WHERE offer_id = $1`, [OFFER_A])).toBe("42501");
        expect(await attempt(c, `TRUNCATE offer_version_rules`)).toBe("42501");
        expect(await attempt(c, `TRUNCATE offer_version_stores`)).toBe("42501");
        // A later transaction cannot widen the published version's scope or rules.
        expect(await attempt(c, INSERT_SCOPE, [TENANT_A, OFFER_A, 1, STORE_A2])).toBe("42501");
        expect(await attempt(c, INSERT_RULE, [TENANT_A, OFFER_A, 1, "include", PROD_A2, null, null])).toBe("42501");
      });
      const r = await guard().admin.query(`SELECT percent_off FROM offer_versions WHERE offer_id = $1`, [OFFER_A]);
      expect(r.rows).toEqual([{ percent_off: 40 }]);
    } finally {
      await clearOffers();
    }
  });
});

// -----------------------------------------------------------------------------
// Pauses and Pack revisions
// -----------------------------------------------------------------------------

describe("0101: pauses", () => {
  it("allows one open whole-offer pause and one per store, resumed once, and nothing else changes", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_1, TENANT_A, OFFER_A, null, ACTOR])).toBeNull();
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_2, TENANT_A, OFFER_A, null, ACTOR])).toBe("23505");
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_2, TENANT_A, OFFER_A, STORE_A1, ACTOR])).toBeNull();
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_3, TENANT_A, OFFER_A, STORE_A1, ACTOR])).toBe("23505");
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_3, TENANT_A, OFFER_A, STORE_B1, ACTOR])).toBe("23503");
      expect(
        await attempt(c, `INSERT INTO offer_pauses (id, tenant_id, offer_id, reason, paused_by_user_id) VALUES ($1, $2, $3, '', $4)`, [
          PAUSE_3,
          TENANT_A,
          OFFER_A,
          ACTOR,
        ]),
      ).toBe("23514");
      expect(await attempt(c, `UPDATE offer_pauses SET reason = 'other' WHERE id = $1`, [PAUSE_1])).toBe("23514");
      expect(await attempt(c, `UPDATE offer_pauses SET resumed_at = now() WHERE id = $1`, [PAUSE_1])).toBe("23514");
      const resume = `UPDATE offer_pauses SET resumed_at = now(), resumed_by_user_id = $2 WHERE id = $1`;
      expect(await attempt(c, resume, [PAUSE_1, ACTOR])).toBeNull();
      expect(await attempt(c, resume, [PAUSE_1, ACTOR])).toBe("23514");
      // A resumed pause frees the slot; the history stays.
      expect(await attempt(c, INSERT_PAUSE, [PAUSE_3, TENANT_A, OFFER_A, null, ACTOR])).toBeNull();
      expect(await attempt(c, `DELETE FROM offer_pauses WHERE id = $1`, [PAUSE_1])).toBe("42501");
      expect((await c.query(`SELECT 1 FROM offer_pauses WHERE offer_id = $1`, [OFFER_A])).rowCount).toBe(3);
    });
  });
});

describe("0101: Offer Pack revisions", () => {
  it("are gapless and append-only per tenant; the store's applied revision only moves forward", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      expect(await attempt(c, INSERT_REVISION, [TENANT_A, 2])).toBe("23514");
      expect(await attempt(c, INSERT_REVISION, [TENANT_A, 1])).toBeNull();
      expect(await attempt(c, INSERT_REVISION, [TENANT_A, 1])).toBe("23514");
      expect(await attempt(c, INSERT_REVISION, [TENANT_A, 2])).toBeNull();
      // Another tenant counts on its own.
      expect(await attempt(c, INSERT_REVISION, [TENANT_B, 1])).toBeNull();
      expect(await attempt(c, `UPDATE offer_pack_revisions SET revision = 9 WHERE tenant_id = $1`, [TENANT_A])).toBe("42501");
      expect(await attempt(c, `DELETE FROM offer_pack_revisions WHERE tenant_id = $1`, [TENANT_A])).toBe("42501");
      expect(await attempt(c, `TRUNCATE offer_pack_revisions CASCADE`)).toBe("42501");

      const insertStore = `INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision) VALUES ($1, $2, $3)`;
      // Only the latest revision (2), issued in this transaction.
      expect(await attempt(c, insertStore, [TENANT_A, STORE_A1, 3])).toBe("23514");
      expect(await attempt(c, insertStore, [TENANT_A, STORE_A1, 1])).toBe("23514");
      expect(await attempt(c, insertStore, [TENANT_A, STORE_B1, 2])).toBe("23503");
      expect(await attempt(c, insertStore, [TENANT_A, STORE_A1, 2])).toBeNull();
      const move = `UPDATE offer_pack_store_revisions SET applied_revision = $3 WHERE tenant_id = $1 AND store_id = $2`;
      expect(await attempt(c, move, [TENANT_A, STORE_A1, 2])).toBe("23514");
      expect(await attempt(c, move, [TENANT_A, STORE_A1, 1])).toBe("23514");
      await c.query(INSERT_REVISION, [TENANT_A, 3]);
      expect(await attempt(c, move, [TENANT_A, STORE_A1, 3])).toBeNull();
      expect(await attempt(c, move, [TENANT_A, STORE_A1, 2])).toBe("23514");
      expect(await attempt(c, `UPDATE offer_pack_store_revisions SET store_id = $2 WHERE store_id = $1`, [STORE_A1, STORE_A2])).toBe("23514");
      expect(await attempt(c, `DELETE FROM offer_pack_store_revisions`)).toBe("42501");
    });
  });
});

describe("0101: materialised eligible sets (OD-6, OD-7 Pack invariant)", () => {
  it("opens and closes rows only at the latest revision, so an older revision's content is frozen", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      // No revision yet: nothing can open.
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1])).toBe("23514");
      await c.query(INSERT_REVISION, [TENANT_A, 1]);
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1])).toBeNull();
      expect(
        await attempt(
          c,
          `INSERT INTO offer_pack_eligible_products (tenant_id, store_id, product_id, offer_id, offer_version, from_revision, to_revision)
           VALUES ($1, $2, $3, $4, 1, 1, 2)`,
          [TENANT_A, STORE_A1, PROD_A2, OFFER_A],
        ),
      ).toBe("23514");
      await c.query(INSERT_REVISION, [TENANT_A, 2]);
      // Revision 1 is history now: nothing opens at 1, and closing must be at 2.
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A2, OFFER_A, 1, 1])).toBe("23514");
      const close = `UPDATE offer_pack_eligible_products SET to_revision = $2 WHERE product_id = $1`;
      expect(await attempt(c, close, [PROD_A1, 1])).toBe("23514");
      expect(await attempt(c, `UPDATE offer_pack_eligible_products SET store_id = $2 WHERE product_id = $1`, [PROD_A1, STORE_A2])).toBe("23514");
      expect(await attempt(c, close, [PROD_A1, 2])).toBeNull();
      // A closed row never changes again, even at a later revision.
      await c.query(INSERT_REVISION, [TENANT_A, 3]);
      expect(await attempt(c, close, [PROD_A1, 3])).toBe("23514");
      expect(await attempt(c, `DELETE FROM offer_pack_eligible_products`)).toBe("42501");
      expect(await attempt(c, `TRUNCATE offer_pack_eligible_products`)).toBe("42501");
    });
  });

  it("freezes a revision when its transaction commits: a later transaction changes nothing at it, only at a new revision", async () => {
    if (skip()) return;
    await committed(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      await c.query(INSERT_REVISION, [TENANT_A, 1]);
      await c.query(INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1]);
      await c.query(`INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision) VALUES ($1, $2, 1)`, [
        TENANT_A,
        STORE_A1,
      ]);
    });
    try {
      await rolledBack(async (c) => {
        // Revision 1 is committed: nothing opens at it, nothing closes, the store does not re-apply it.
        expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A2, OFFER_A, 1, 1])).toBe("23514");
        expect(await attempt(c, `UPDATE offer_pack_eligible_products SET to_revision = 1 WHERE product_id = $1`, [PROD_A1])).toBe("23514");
        expect(
          await attempt(c, `INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision) VALUES ($1, $2, 1)`, [
            TENANT_A,
            STORE_A2,
          ]),
        ).toBe("23514");
      });
      await committed(async (c) => {
        // A new revision issued in this transaction takes the changes.
        await c.query(INSERT_REVISION, [TENANT_A, 2]);
        await c.query(`UPDATE offer_pack_eligible_products SET to_revision = 2 WHERE product_id = $1`, [PROD_A1]);
        await c.query(INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A2, OFFER_A, 1, 2]);
        await c.query(`UPDATE offer_pack_store_revisions SET applied_revision = 2 WHERE store_id = $1`, [STORE_A1]);
      });
      await rolledBack(async (c) => {
        expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A3, OFFER_A, 1, 2])).toBe("23514");
        expect(await attempt(c, `UPDATE offer_pack_eligible_products SET to_revision = 2 WHERE product_id = $1`, [PROD_A2])).toBe("23514");
      });
      const rows = await guard().admin.query<{ k: string }>(
        `SELECT product_id || ':' || from_revision || '-' || coalesce(to_revision::text, '') AS k FROM offer_pack_eligible_products`,
      );
      expect(rows.rows.map((r) => r.k).sort()).toEqual([`${PROD_A1}:1-2`, `${PROD_A2}:2-`].sort());
    } finally {
      await clearOffers();
    }
  });

  it("refuses a product in two offers of one store in any revision (PK, EXCLUDE 23P01), and allows other stores and successive revisions", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await c.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      await publish(c, TENANT_A, OFFER_A2, 1);
      await c.query(INSERT_REVISION, [TENANT_A, 1]);
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1])).toBeNull();
      // At the same revision, a second offer (or the same row again) for the product and store is
      // refused by the primary key, one row per (store, product) opening at a revision.
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A2, 1, 1])).toBe("23505");
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A, 1, 1])).toBe("23505");
      // Another store, or another product, is fine.
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A2, PROD_A1, OFFER_A2, 1, 1])).toBeNull();
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A2, OFFER_A2, 1, 1])).toBeNull();
      // Re-materialisation: revision 2 moves PROD_A1 in store A1 from OFFER_A to OFFER_A2. Opening it
      // for OFFER_A2 while OFFER_A's row is still open overlaps the ranges: the EXCLUDE refuses it.
      // (Windows play no part: two offers with disjoint windows are refused the same way, the
      // contract's "disjoint per Pack" reading.)
      await c.query(INSERT_REVISION, [TENANT_A, 2]);
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A2, 1, 2])).toBe("23P01");
      await c.query(`UPDATE offer_pack_eligible_products SET to_revision = 2 WHERE offer_id = $1 AND store_id = $2`, [OFFER_A, STORE_A1]);
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_A1, OFFER_A2, 1, 2])).toBeNull();
      // The Pack of each revision, read back from the ranges.
      const pack = async (rev: number): Promise<string[]> =>
        (
          await c.query<{ k: string }>(
            `SELECT product_id || ':' || offer_id AS k FROM offer_pack_eligible_products
              WHERE tenant_id = $1 AND store_id = $2 AND int8range(from_revision, to_revision) @> $3::bigint`,
            [TENANT_A, STORE_A1, rev],
          )
        ).rows
          .map((r) => r.k)
          .sort();
      expect(await pack(1)).toEqual([`${PROD_A1}:${OFFER_A}`, `${PROD_A2}:${OFFER_A2}`].sort());
      expect(await pack(2)).toEqual([`${PROD_A1}:${OFFER_A2}`, `${PROD_A2}:${OFFER_A2}`].sort());
      // Another tenant's store or product is refused by the composite FKs.
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_B1, PROD_A3, OFFER_A, 1, 2])).toBe("23503");
      expect(await attempt(c, INSERT_ELIGIBLE, [TENANT_A, STORE_A1, PROD_B1, OFFER_A, 1, 2])).toBe("23503");
    });
  });
});

// -----------------------------------------------------------------------------
// Sale facts
// -----------------------------------------------------------------------------

describe("0101: sale_line_promotions", () => {
  const withOffer = async (c: PoolClient): Promise<void> => {
    await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
    await publish(c, TENANT_A, OFFER_A, 1);
    await c.query(INSERT_REVISION, [TENANT_A, 1]);
  };

  it("records a reward line and a non-reward line, one fact per line", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await withOffer(c);
      expect(await attempt(c, INSERT_PROMOTION, [LINE_REWARD, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, "40.00"])).toBeNull();
      expect(await attempt(c, INSERT_PROMOTION, [LINE_PLAIN, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, "0"])).toBeNull();
      expect(await attempt(c, INSERT_PROMOTION, [LINE_PLAIN, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, "0"])).toBe("23505");
      const r = await c.query(`SELECT sale_line_id, discount_amount FROM sale_line_promotions WHERE sale_id = $1 ORDER BY sale_line_id`, [SALE_A]);
      expect(r.rows).toEqual([
        { sale_line_id: LINE_REWARD, discount_amount: "40.0000" },
        { sale_line_id: LINE_PLAIN, discount_amount: "0.0000" },
      ]);
    });
  });

  it("refuses arithmetic that cannot hold: net invariant, discount above gross, reward on quantity 2, non-whole quantity, negative", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await withOffer(c);
      const fact = (line: string, discount: string): Promise<string | null> =>
        attempt(c, INSERT_PROMOTION, [line, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, discount]);
      // 100 x 1 - 30 <> 60.
      expect(await fact(LINE_REWARD, "30")).toBe("23514");
      // A non-reward line whose net is not its gross.
      expect(await fact(LINE_QTY2_DISCOUNTED, "0")).toBe("23514");
      // 50 x 2 - 20 = 80 holds, but a reward has quantity 1 (OD-4).
      expect(await fact(LINE_QTY2_DISCOUNTED, "20")).toBe("23514");
      expect(await fact(LINE_MEASURED, "0")).toBe("23514");
      expect(await fact(LINE_REWARD, "-40")).toBe("23514");
      expect(await fact(LINE_REWARD, "NaN")).toBe("23514");
      expect(await fact(LINE_REWARD, "40")).toBeNull();
    });
  });

  it("pins the fact to a line of the same sale, store and tenant, and to an existing version and revision", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await withOffer(c);
      const p = (line: string, sale: string, tenant: string, store: string, version = 1, rev = 1): Promise<string | null> =>
        attempt(c, INSERT_PROMOTION, [line, sale, tenant, store, OFFER_A, version, rev, "40"]);
      // The line belongs to SALE_A, not SALE_A_OTHER; to store A1, not A2.
      expect(await p(LINE_REWARD, SALE_A_OTHER, TENANT_A, STORE_A1)).toBe("23503");
      expect(await p(LINE_REWARD, SALE_A, TENANT_A, STORE_A2)).toBe("23503");
      // Another tenant's line is invisible to the line guard, and fails the FK.
      expect(await p(LINE_B, SALE_B, TENANT_A, STORE_B1)).toBe("23503");
      expect(await p(LINE_REWARD, SALE_A, TENANT_A, STORE_A1, 2)).toBe("23503");
      expect(await p(LINE_REWARD, SALE_A, TENANT_A, STORE_A1, 1, 2)).toBe("23503");
    });
  });

  it("AC2: refuses UPDATE, DELETE and TRUNCATE of a recorded fact and of a clawback, also for the superuser", async () => {
    if (skip()) return;
    await seedCommitted();
    try {
      await rolledBack(async (c) => {
        expect(await attempt(c, `UPDATE sale_line_promotions SET discount_amount = 0 WHERE sale_line_id = $1`, [LINE_REWARD])).toBe("42501");
        expect(await attempt(c, `DELETE FROM sale_line_promotions WHERE sale_line_id = $1`, [LINE_REWARD])).toBe("42501");
        expect(await attempt(c, `TRUNCATE sale_line_promotions`)).toBe("42501");
        expect(await attempt(c, `UPDATE sale_return_promotion_clawbacks SET amount = 1`)).toBe("42501");
        expect(await attempt(c, `DELETE FROM sale_return_promotion_clawbacks`)).toBe("42501");
        expect(await attempt(c, `TRUNCATE sale_return_promotion_clawbacks`)).toBe("42501");
      });
      const r = await guard().admin.query(`SELECT discount_amount FROM sale_line_promotions WHERE sale_line_id = $1`, [LINE_REWARD]);
      expect(r.rows).toEqual([{ discount_amount: "40.0000" }]);
    } finally {
      await clearOffers();
    }
  });
});

describe("0101: sale_return_promotion_clawbacks", () => {
  it("records one positive clawback per offer per return, of an offer version on the returned sale, pinned to the return's tenant and store", async () => {
    if (skip()) return;
    await rolledBack(async (c) => {
      await c.query(INSERT_OFFER, [OFFER_A, TENANT_A, ACTOR]);
      await c.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await publish(c, TENANT_A, OFFER_A, 1);
      await publish(c, TENANT_A, OFFER_A2, 1);
      await c.query(INSERT_REVISION, [TENANT_A, 1]);
      const claw = (store: string, amount: string, offer = OFFER_A): Promise<string | null> =>
        attempt(c, INSERT_CLAWBACK, [RETURN_A, TENANT_A, store, offer, 1, amount]);
      // Before the sale carries a fact of the offer, no clawback of it.
      expect(await claw(STORE_A1, "16")).toBe("23503");
      await c.query(INSERT_PROMOTION, [LINE_REWARD, SALE_A, TENANT_A, STORE_A1, OFFER_A, 1, 1, "40"]);
      // An offer that is not on the returned sale.
      expect(await claw(STORE_A1, "16", OFFER_A2)).toBe("23503");
      expect(await claw(STORE_A1, "0")).toBe("23514");
      expect(await claw(STORE_A1, "-1")).toBe("23514");
      expect(await claw(STORE_A2, "16")).toBe("23503");
      expect(await claw(STORE_A1, "16")).toBeNull();
      expect(await claw(STORE_A1, "8")).toBe("23505");
    });
  });
});

// -----------------------------------------------------------------------------
// Tenant isolation as the app role
// -----------------------------------------------------------------------------

describe("0101: tenant isolation (FORCE RLS, app role)", () => {
  beforeAll(async () => {
    if (skip()) return;
    await seedCommitted();
  });
  afterAll(async () => {
    if (skip()) return;
    await clearOffers();
  });

  it("shows every table's own-tenant rows only, and nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      for (const table of TABLES) {
        const r = await client.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM ${table}`);
        expect([table, r.rows]).toEqual([table, [{ tenant_id: TENANT_A }]]);
      }
    });
    await asApp(guard(), "", async (client) => {
      for (const table of TABLES) {
        expect([table, (await client.query(`SELECT 1 FROM ${table}`)).rowCount]).toEqual([table, 0]);
      }
    });
  });

  it("refuses another tenant's rows on INSERT, deletes nothing, and updates only its own tenant", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      expect(await attempt(client, INSERT_OFFER, [OFFER_A2, TENANT_B, ACTOR])).toBe("42501");
      // (Revision 1 passes B's numbering as tenant A sees it, so the policy is what refuses.)
      expect(await attempt(client, INSERT_REVISION, [TENANT_B, 1])).toBe("42501");
      for (const table of TABLES) {
        expect([table, (await client.query(`DELETE FROM ${table}`)).rowCount]).toEqual([table, 0]);
      }
      // UPDATE sees only tenant A, and cannot move a row to tenant B (the guard refuses before the policy).
      expect((await client.query(`UPDATE offers SET draft_revision = draft_revision + 1`)).rowCount).toBe(1);
      expect(await attempt(client, `UPDATE offer_pack_store_revisions SET tenant_id = $1`, [TENANT_B])).toBe("23514");
      expect(await attempt(client, `UPDATE offers SET tenant_id = $1`, [TENANT_B])).toBe("23514");
      // Cross-tenant references from tenant A's own rows fail the composite FKs.
      expect(await attempt(client, INSERT_PROMOTION, [LINE_PLAIN, SALE_A, TENANT_A, STORE_A1, OFFER_B, 1, 1, "0"])).toBe("23503");
      expect(await attempt(client, INSERT_PAUSE, [PAUSE_2, TENANT_A, OFFER_B, null, ACTOR])).toBe("23503");
    });
    await asApp(guard(), TENANT_A, async (client) => {
      // The app role publishes a whole version in one transaction (scope, rules, the deferred check).
      await client.query(INSERT_OFFER, [OFFER_A2, TENANT_A, ACTOR]);
      await publish(client, TENANT_A, OFFER_A2, 1, { allStores: false, stores: [STORE_A2], rules: [{ brand: BRAND_A }] });
      expect(await attempt(client, "SET CONSTRAINTS ALL IMMEDIATE")).toBeNull();
      await client.query(INSERT_REVISION, [TENANT_A, 2]);
      expect(await attempt(client, INSERT_ELIGIBLE, [TENANT_A, STORE_A2, PROD_A1, OFFER_A2, 1, 2])).toBeNull();
      // The version trigger and guards see only tenant A, so the next revision is 3, not B's.
      expect(await attempt(client, INSERT_REVISION, [TENANT_A, 3])).toBeNull();
    });
    const b = await guard().admin.query(`SELECT 1 FROM offers WHERE tenant_id = $1`, [TENANT_B]);
    expect(b.rowCount).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// UP -> DOWN -> UP
// -----------------------------------------------------------------------------

describe("0101: UP -> DOWN -> UP", () => {
  const exists = async (table: string): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table])).rows[0]!.t !== null;
  const OWNER_TABLES = ["tenants", "stores", "tenant_products", "tenant_product_categories", "tenant_product_brands",
    "sale_lines", "sale_returns", ...TABLES];

  /**
   * Run a migration file on one connection as `role`, with the session's
   * `app.current_tenant` pre-set to '' (the state a pooled connection can be
   * in), and return its error code or null. Rolled back on failure.
   */
  async function runFileWithEmptyGuc(path: string, role: string): Promise<string | null> {
    const client = await guard().admin.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await client.query("SELECT set_config('app.current_tenant', '', false)");
      return await errorCode(() => client.query(readFileSync(path, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("RESET app.current_tenant").catch(() => undefined);
      client.release();
    }
  }

  it("refuses while an offer or a Pack revision exists, also as a NOSUPERUSER migration owner under an empty GUC", async () => {
    if (skip()) return;
    const e = guard();
    await seedCommitted();
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt1336_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
      await asMigrationOwner(e, owner, async () => {
        expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      });
      for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    } finally {
      await clearOffers();
    }
    // A Pack revision alone also blocks the rollback.
    await e.admin.query(INSERT_REVISION, [TENANT_A, 1]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    } finally {
      await clearOffers();
    }
  });

  it("drops the tables, functions and categories key once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, false]);
    expect(await exists("uq_tenant_product_categories_id_tenant")).toBe(false);
    const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname = ANY($1)`, [FUNCTIONS.map((f) => f.replace("()", ""))]);
    expect(fns.rowCount).toBe(0);
    await e.admin.query(downSql);
    // The catalog, the sale and the return survived; the 0100 key is untouched.
    expect((await e.admin.query(`SELECT 1 FROM sale_lines WHERE sale_id = $1`, [SALE_A])).rowCount).toBe(4);
    expect(await exists("uq_sale_lines_id_sale_tenant_store")).toBe(true);
    await e.admin.query(upSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    await ensureAppRole(e);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS with an empty session GUC", async () => {
    if (skip()) return;
    const owner = { role: "rt1336_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
      expect(await runFileWithEmptyGuc(UP_PATH, owner.role)).toBeNull();
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    await ensureAppRole(guard());
  });
});
