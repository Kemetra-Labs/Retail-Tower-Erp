/**
 * RT-1151 (RT-282 PR-07): `0122_sale_line_pricing_provenance` migration test.
 *
 * Validates `packages/db/drizzle/0122_sale_line_pricing_provenance.sql`
 * (+ `.down.sql`) on a real PostgreSQL 16, applied on top of every earlier
 * migration with a sale and its lines already present (the UPGRADE path):
 *   - the table matches the Drizzle schema; FORCE RLS with exactly a SELECT and
 *     an INSERT tenant policy;
 *   - exactly one variant of the union per row (CHECK), both variants accepted;
 *   - the composite FK pins a row to a line of the same sale, store and tenant;
 *     one row per line at most;
 *   - append-only for every role (UPDATE, DELETE, TRUNCATE refused);
 *   - no FK to the price timeline: an unknown price event is stored verbatim;
 *   - existing sale lines are unchanged and need no row;
 *   - tenant isolation as the app role (own tenant only, empty GUC sees
 *     nothing, cross-tenant insert refused);
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '', and the down REFUSES while a
 *     row exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns } from "drizzle-orm";
import type { PoolClient } from "pg";

import { saleLinePricingProvenance } from "../../src/schema";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, inRolledBackTx, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0122_sale_line_pricing_provenance.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0122_sale_line_pricing_provenance.down.sql");
const TABLE = "sale_line_pricing_provenance";

const id = (n: string): string => `01220000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_B = id("0b021");
const SALE_A = id("0a071");
const SALE_A2 = id("0a072");
const SALE_B = id("0b071");
const LINE_A1 = id("0a081");
const LINE_A2 = id("0a082");
const LINE_A3 = id("0a083");
const LINE_A2_OTHER_SALE = id("0a084");
const LINE_B = id("0b081");
const ACTOR = id("0a0a1");
const EVENT = id("0a401");

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

type Q = Pick<PoolClient, "query">;

const INSERT_PRICING = `INSERT INTO sale_line_pricing_provenance
  (sale_line_id, sale_id, tenant_id, store_id, origin, source_scope, price_event_id, price_kind, pricing_revision)
  VALUES ($1, $2, $3, $4, 'pricing', $5, $6, $7, $8)`;
const INSERT_LEGACY = `INSERT INTO sale_line_pricing_provenance
  (sale_line_id, sale_id, tenant_id, store_id, origin, source_scope, catalog_cursor)
  VALUES ($1, $2, $3, $4, 'legacy', $5, $6)`;

async function pricing(q: Q, line: string, overrides: { scope?: string; kind?: string; revision?: number | null; event?: string | null } = {}) {
  await q.query(INSERT_PRICING, [
    line,
    SALE_A,
    TENANT_A,
    STORE_A,
    overrides.scope ?? "zone",
    overrides.event === undefined ? EVENT : overrides.event,
    overrides.kind ?? "regular",
    overrides.revision === undefined ? 418 : overrides.revision,
  ]);
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

/** Removes every provenance row as the superuser, with the append-only trigger off (test cleanup only). */
async function clearRows(): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`DELETE FROM ${TABLE}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

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
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'slp-a', 'SLP A', 'EGP'), ($2, 'slp-b', 'SLP B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $3, $4, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A, TENANT_B, STORE_B],
  );
  const sale = `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                  source_system, external_id, payload_hash, created_by, device_id)
                VALUES ($1, $2, $3, 'EGP', 100, '2026-12-02T10:00:00Z', '2026-12-02', 'pos', $4, repeat('a', 64), $5, $6)`;
  await a.query(sale, [SALE_A, TENANT_A, STORE_A, "ext-a", ACTOR, DEVICE_A]);
  await a.query(sale, [SALE_A2, TENANT_A, STORE_A, "ext-a2", ACTOR, DEVICE_A]);
  await a.query(sale, [SALE_B, TENANT_B, STORE_B, "ext-b", ACTOR, DEVICE_B]);
  const line = `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                  line_amount, unit)
                VALUES ($1, $2, $3, $4, 'L', 50, 'EGP', 1, 50, 'pcs')`;
  await a.query(line, [LINE_A1, SALE_A, TENANT_A, STORE_A]);
  await a.query(line, [LINE_A2, SALE_A, TENANT_A, STORE_A]);
  await a.query(line, [LINE_A3, SALE_A, TENANT_A, STORE_A]);
  await a.query(line, [LINE_A2_OTHER_SALE, SALE_A2, TENANT_A, STORE_A]);
  await a.query(line, [LINE_B, SALE_B, TENANT_B, STORE_B]);
  await a.query(upSql);
  await a.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test`);
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

describe("0122_sale_line_pricing_provenance — shape", () => {
  it("creates the table and the Drizzle schema declares exactly its columns", async () => {
    if (skip()) return;
    const declared = Object.values(getTableColumns(saleLinePricingProvenance) as Record<string, { name: string; notNull: boolean }>)
      .map((c) => `${c.name}:${c.notNull ? "NO" : "YES"}`)
      .sort();
    const actual = await guard().admin.query<{ c: string }>(
      `SELECT column_name || ':' || is_nullable AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
      [TABLE],
    );
    expect(actual.rows.map((r) => r.c).sort()).toEqual(declared);
  });

  it("enables and FORCEs RLS with exactly a SELECT and an INSERT policy", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ rel: boolean; force: boolean }>(
      `SELECT relrowsecurity AS rel, relforcerowsecurity AS force FROM pg_class WHERE relname = $1`,
      [TABLE],
    );
    expect(rls.rows[0]).toEqual({ rel: true, force: true });
    const policies = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY cmd`,
      [TABLE],
    );
    expect(policies.rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("leaves existing sale lines unchanged and without a row", async () => {
    if (skip()) return;
    const r = await guard().admin.query(`SELECT 1 FROM sale_lines WHERE id = ANY($1)`, [[LINE_A1, LINE_A2, LINE_A3, LINE_B]]);
    expect(r.rowCount).toBe(4);
    const rows = await guard().admin.query(`SELECT 1 FROM ${TABLE}`);
    expect(rows.rowCount).toBe(0);
  });
});

describe("0122_sale_line_pricing_provenance — the union", () => {
  it("accepts each variant, and an unknown price event (no FK to the timeline)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await pricing(c, LINE_A1);
      await c.query(INSERT_LEGACY, [LINE_A2, SALE_A, TENANT_A, STORE_A, "legacy_store", "c:1042"]);
      const r = await c.query(`SELECT origin FROM ${TABLE} ORDER BY origin`);
      expect(r.rows.map((x: { origin: string }) => x.origin)).toEqual(["legacy", "pricing"]);
    });
  });

  it.each([
    ["a legacy scope on pricing", { scope: "legacy_store" }],
    ["a kind other than regular", { kind: "clearance" }],
    ["revision 0", { revision: 0 }],
    ["no revision", { revision: null }],
    ["no event", { event: null }],
  ])("refuses a pricing row with %s (23514)", async (_name, overrides) => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => pricing(c, LINE_A1, overrides))).toBe("23514");
    });
  });

  it("refuses a mixed or incomplete legacy row and an unknown origin (23514)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      expect(await sp(c, () => c.query(INSERT_LEGACY, [LINE_A1, SALE_A, TENANT_A, STORE_A, "store", "c:1"]))).toBe("23514");
      expect(await sp(c, () => c.query(INSERT_LEGACY, [LINE_A1, SALE_A, TENANT_A, STORE_A, "legacy_tenant", null]))).toBe("23514");
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO ${TABLE} (sale_line_id, sale_id, tenant_id, store_id, origin, source_scope, catalog_cursor, price_event_id)
             VALUES ($1, $2, $3, $4, 'legacy', 'legacy_tenant', 'c:1', $5)`,
            [LINE_A1, SALE_A, TENANT_A, STORE_A, EVENT],
          ),
        ),
      ).toBe("23514");
      expect(
        await sp(c, () =>
          c.query(
            `INSERT INTO ${TABLE} (sale_line_id, sale_id, tenant_id, store_id, origin, source_scope, catalog_cursor)
             VALUES ($1, $2, $3, $4, 'erp', 'legacy_tenant', 'c:1')`,
            [LINE_A1, SALE_A, TENANT_A, STORE_A],
          ),
        ),
      ).toBe("23514");
    });
  });

  it("pins a row to a line of the same sale, store and tenant, once per line", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      // A line of another sale.
      expect(
        await sp(c, () =>
          c.query(INSERT_PRICING, [LINE_A2_OTHER_SALE, SALE_A, TENANT_A, STORE_A, "zone", EVENT, "regular", 1]),
        ),
      ).toBe("23503");
      // The wrong store.
      expect(
        await sp(c, () => c.query(INSERT_PRICING, [LINE_A1, SALE_A, TENANT_A, STORE_A2, "zone", EVENT, "regular", 1])),
      ).toBe("23503");
      // Another tenant's line.
      expect(
        await sp(c, () => c.query(INSERT_PRICING, [LINE_B, SALE_B, TENANT_A, STORE_B, "zone", EVENT, "regular", 1])),
      ).toBe("23503");
      await pricing(c, LINE_A1);
      expect(await sp(c, () => pricing(c, LINE_A1))).toBe("23505");
    });
  });
});

describe("0122_sale_line_pricing_provenance — append-only", () => {
  it.each([
    [`UPDATE ${TABLE} SET pricing_revision = 1`],
    [`DELETE FROM ${TABLE}`],
    [`TRUNCATE ${TABLE}`],
  ])("refuses %s for every role (42501)", async (sql) => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await pricing(c, LINE_A1);
      expect(await sp(c, () => c.query(sql))).toBe("42501");
    });
  });

  it("refuses deleting a line that carries provenance (the FK restricts)", async () => {
    if (skip()) return;
    await inRolledBackTx(guard().admin, async (c) => {
      await pricing(c, LINE_A1);
      expect(await sp(c, () => c.query(`DELETE FROM sale_lines WHERE id = $1`, [LINE_A1]))).toBe("23503");
    });
  });
});

describe("0122_sale_line_pricing_provenance — tenant isolation (app role)", () => {
  it("own tenant only; an empty GUC sees nothing; a cross-tenant insert is refused", async () => {
    if (skip()) return;
    const e = guard();
    await clearRows();
    const client = await e.admin.connect();
    try {
      await client.query(INSERT_PRICING, [LINE_A1, SALE_A, TENANT_A, STORE_A, "zone", EVENT, "regular", 1]);
      await client.query(INSERT_LEGACY, [LINE_B, SALE_B, TENANT_B, STORE_B, "legacy_tenant", "c:7"]);
    } finally {
      client.release();
    }
    try {
      const a = await asApp(e, TENANT_A, (c) => c.query<{ t: string }>(`SELECT tenant_id::text AS t FROM ${TABLE}`));
      expect(a.rows.map((r) => r.t)).toEqual([TENANT_A]);
      const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${TABLE}`));
      expect(none.rowCount).toBe(0);
      expect(
        await asApp(e, TENANT_B, (c) =>
          errorCode(() => c.query(INSERT_PRICING, [LINE_A2, SALE_A, TENANT_A, STORE_A, "zone", EVENT, "regular", 1])),
        ),
      ).toBe("42501");
      const deleted = await asApp(e, TENANT_A, (c) => errorCode(() => c.query(`DELETE FROM ${TABLE}`)));
      // No DELETE policy: nothing is visible to delete, and the trigger refuses any row that is.
      expect([null, "42501"]).toContain(deleted);
    } finally {
      await clearRows();
    }
  });
});

describe("0122_sale_line_pricing_provenance — down migration", () => {
  const OWNER_TABLES = [TABLE, "tenants"];
  const FUNCTIONS = ["sale_line_pricing_provenance_append_only()"];

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

  it("REFUSES while a row exists, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    await clearRows();
    await e.admin.query(INSERT_PRICING, [LINE_A1, SALE_A, TENANT_A, STORE_A, "zone", EVENT, "regular", 1]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt1151_slp_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
      await asMigrationOwner(e, owner, async () => {
        expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists(TABLE)).toBe(true);
    } finally {
      await clearRows();
    }
  });

  it("drops the table and function once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await clearRows();
    const owner = { role: "rt1151_slp_down_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
    });
    expect(await exists(TABLE)).toBe(false);
    const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname = 'sale_line_pricing_provenance_append_only'`);
    expect(fns.rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists(TABLE)).toBe(true);
    const lines = await e.admin.query(`SELECT 1 FROM sale_lines`);
    expect(lines.rowCount).toBe(5);
  });
});
