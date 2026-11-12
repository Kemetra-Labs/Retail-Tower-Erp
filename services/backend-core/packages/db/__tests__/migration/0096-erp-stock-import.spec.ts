/**
 * RT-1288: `0096_erp_stock_import` migration test (owner authorization, Jira
 * RT-1288 comment 16634).
 *
 * Validates `packages/db/drizzle/0096_erp_stock_import.sql` (+ `.down.sql`):
 *   - the four tables, FORCE RLS, and their policies (runs and pages: SELECT,
 *     INSERT, UPDATE; rows and findings: SELECT and INSERT only);
 *   - the row and finding CHECKs: an `imported` row names its effect and no
 *     other outcome does; a refusal finding is page-level, every other one
 *     names its row; one running run per warehouse map;
 *   - the widened `inventory_effect_integration_confirmed_at`: an `external`
 *     effect carries `erp_confirmed_at`, `not_posted` still cannot;
 *   - tenant isolation under FORCE RLS;
 *   - the down REFUSES while an import run exists, also as a NOSUPERUSER
 *     migration owner, restores the original CHECK, and UP -> DOWN -> UP
 *     round-trips (rerunnable).
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0096_erp_stock_import.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0096_erp_stock_import.down.sql");

const id = (n: string): string => `09600000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_B = id("0b011");
const PRODUCT_A = id("0a031");
const MAP_A = id("0a041");
const MAP_B = id("0b041");
const ACTOR = id("0a0a1");
const MOVEMENT_A = id("0a051");

const TABLES = ["erp_stock_import_runs", "erp_stock_import_pages", "erp_stock_import_rows", "erp_stock_import_findings"];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0096-erp-stock-import.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Only a Docker start failure may be skipped: a migration error fails the suite.
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'esi-a', 'ESI A', 'USD'), ($2, 'esi-b', 'ESI B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A1', 'Store A1'), ($2, $4, 'B1', 'Store B1')`, [
    STORE_A,
    STORE_B,
    TENANT_A,
    TENANT_B,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Product A', 'standard', $3, $3)`,
    [PRODUCT_A, TENANT_A, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES ($1, $3, $5, 'stock', 'WH-A', $7, 1), ($2, $4, $6, 'stock', 'WH-B', $7, 1)`,
    [MAP_A, MAP_B, TENANT_A, TENANT_B, STORE_A, STORE_B, ACTOR],
  );
  await a.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by,
        stock_location_id, inventory_status, origin, event_type, event_ref_id, source_system, external_id)
     VALUES ($1, $2, $3, $4, 'inbound', 5, 'ea', now(), $5,
             (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable',
             'erp_external', 'erp_procurement_receipt', $1, 'erpnext', 'k1')`,
    [MOVEMENT_A, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
  );
  await a.query(upSql);
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const RUN = (runId: string, tenant: string, store: string, map: string, status = "running"): [string, unknown[]] => [
  `INSERT INTO erp_stock_import_runs
     (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, status, settle_seconds, overlap_seconds, ended_at)
   VALUES ($1, $2, $3, $4, 'WH', $5, 300, 3900, CASE WHEN $5 = 'running' THEN NULL ELSE now() END)`,
  [runId, tenant, store, map, status],
];

describe("0096: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0096: tables, RLS and CHECKs", () => {
  it("creates the four tables with FORCE ROW LEVEL SECURITY and the expected policies", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ relname: string; force: boolean }>(
      `SELECT relname, relforcerowsecurity AS force FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [TABLES],
    );
    expect(r.rows).toHaveLength(4);
    expect(r.rows.every((row) => row.force)).toBe(true);
    const p = await guard().admin.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [TABLES],
    );
    const by = (t: string): string[] => p.rows.filter((x) => x.tablename === t).map((x) => x.cmd);
    expect(by("erp_stock_import_runs")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(by("erp_stock_import_pages")).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(by("erp_stock_import_rows")).toEqual(["INSERT", "SELECT"]);
    expect(by("erp_stock_import_findings")).toEqual(["INSERT", "SELECT"]);
  });

  it("lets an external effect carry erp_confirmed_at and still refuses it on not_posted", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_confirmed_at) VALUES ($1, $2, 'external', now())`,
        [MOVEMENT_A, TENANT_A],
      );
      await client.query("SAVEPOINT s");
      await expect(
        client.query(`UPDATE inventory_effect_integration SET state = 'not_posted', erp_document_ref = NULL WHERE effect_id = $1`, [
          MOVEMENT_A,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(
        client.query(`UPDATE inventory_effect_integration SET erp_confirmed_at = NULL WHERE effect_id = $1`, [MOVEMENT_A]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("keeps one running run per map, and pairs row outcomes and finding rows", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(...RUN(id("0a061"), TENANT_A, STORE_A, MAP_A));
      await client.query("SAVEPOINT s");
      await expect(client.query(...RUN(id("0a062"), TENANT_A, STORE_A, MAP_A))).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT s");
      await client.query(
        `INSERT INTO erp_stock_import_pages (id, tenant_id, run_id, page_seq, max_rows) VALUES ($1, $2, $3, 0, 100)`,
        [id("0a071"), TENANT_A, id("0a061")],
      );
      const rowSql = `INSERT INTO erp_stock_import_rows
          (id, tenant_id, store_id, page_id, erpnext_warehouse_ref, ledger_entry_ref, entry_index, voucher_type,
           voucher_no, erpnext_item_ref, creation, is_cancelled, actual_qty, stock_uom, outcome, effect_id)
        VALUES ($1, $2, $3, $4, 'WH', $5, 0, 'Purchase Receipt', 'PR-1', 'ITEM', now(), false, 1, 'ea', $6, $7)`;
      await client.query("SAVEPOINT r");
      await expect(
        client.query(rowSql, [id("0a081"), TENANT_A, STORE_A, id("0a071"), "SLE-1", "imported", null]),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT r");
      await client.query(rowSql, [id("0a081"), TENANT_A, STORE_A, id("0a071"), "SLE-1", "imported", MOVEMENT_A]);
      await client.query("SAVEPOINT f");
      await expect(
        client.query(
          `INSERT INTO erp_stock_import_findings (id, tenant_id, store_id, page_id, row_id, erpnext_warehouse_ref, kind)
           VALUES ($1, $2, $3, $4, NULL, 'WH', 'unknown_item')`,
          [id("0a091"), TENANT_A, STORE_A, id("0a071")],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT f");
      // The same ledger position is recorded once.
      await expect(
        client.query(rowSql, [id("0a082"), TENANT_A, STORE_A, id("0a071"), "SLE-1", "covered", null]),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });
});

describe("0096: a run's warehouse map is of its own tenant", () => {
  it("refuses a run that names another tenant's map (FKs bypass row security, the composite key does not)", async () => {
    if (skip()) return;
    await expect(guard().admin.query(...RUN(id("0a066"), TENANT_A, STORE_A, MAP_B))).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0096: tenant isolation (FORCE RLS)", () => {
  it("writes and reads only the caller's tenant, and nothing under an empty GUC", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(...RUN(id("0a063"), TENANT_A, STORE_A, MAP_A));
      await client.query("SAVEPOINT s");
      await expect(client.query(...RUN(id("0b063"), TENANT_B, STORE_B, MAP_B))).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT s");
      expect((await client.query(`SELECT 1 FROM erp_stock_import_runs`)).rowCount).toBe(1);
      expect((await client.query(`DELETE FROM erp_stock_import_runs`)).rowCount).toBe(0);
    });
    await guard().admin.query(...RUN(id("0a064"), TENANT_A, STORE_A, MAP_A));
    try {
      await asApp(guard(), TENANT_B, async (client) => {
        expect((await client.query(`SELECT 1 FROM erp_stock_import_runs`)).rowCount).toBe(0);
      });
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM erp_stock_import_runs`)).rowCount).toBe(0);
      });
    } finally {
      await guard().admin.query(`DELETE FROM erp_stock_import_runs`);
    }
  });
});

describe("0096: UP -> DOWN -> UP", () => {
  const exists = async (): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass('erp_stock_import_runs')::text AS t`)).rows[0]!.t !== null;
  const OWNER_TABLES = [
    "tenants",
    "stores",
    "erpnext_warehouse_map",
    "tenant_products",
    "stock_movements",
    "inventory_effect_integration",
    ...TABLES,
  ];

  it("refuses while an import run exists, also as a NOSUPERUSER migration owner", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(...RUN(id("0a065"), TENANT_A, STORE_A, MAP_A, "completed"));
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt1288_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists()).toBe(true);
    } finally {
      await e.admin.query(`DELETE FROM erp_stock_import_runs`);
    }
  });

  it("drops the tables once empty, restores the original CHECK, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists()).toBe(false);
    const check = await e.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'inventory_effect_integration_confirmed_at'`,
    );
    expect(check.rows[0]!.def).not.toContain("external");
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists()).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt1288_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists()).toBe(true);
  });
});
