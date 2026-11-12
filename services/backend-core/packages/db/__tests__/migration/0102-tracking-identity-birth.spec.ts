/**
 * RT-453: `0102_tracking_identity_birth` migration test (authorization: Jira
 * RT-453 comment 16685).
 *
 * Validates `packages/db/drizzle/0102_tracking_identity_birth.sql` (+ `.down.sql`):
 *   - the four tables, FORCE RLS, SELECT and INSERT policies only;
 *   - a birth names exactly its own evidence (a run XOR an import row), and
 *     the identity of its own product and tenant;
 *   - a resolution is once per row, and `imported` names its effect;
 *   - `erp_stock_import_rows.event_type` takes only the ERP event types;
 *   - an identity anchor line names the identity of its own product, once per anchor;
 *   - `erpnext_reconciliation_result` accepts `tracking_mismatch`;
 *   - tenant isolation under FORCE RLS;
 *   - the down REFUSES while a birth exists, also as a NOSUPERUSER migration
 *     owner, restores the 0066 CHECK, and UP -> DOWN -> UP round-trips.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0102_tracking_identity_birth.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0102_tracking_identity_birth.down.sql");

const id = (n: string): string => `10000000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_B = id("0b011");
const PRODUCT_A = id("0a031");
const PRODUCT_A2 = id("0a032");
const PRODUCT_B = id("0b031");
const IDENTITY_A = id("0a041");
const IDENTITY_B = id("0b041");
const RUN_A = id("0a051");
const RUN_B = id("0b051");
const ANCHOR_A = id("0a061");
const MAP_A = id("0a071");
const IMPORT_RUN_A = id("0a081");
const PAGE_A = id("0a091");
const ROW_A = id("0a0a1");
const MOVEMENT_A = id("0a0b1");
const ACTOR = id("0a0c1");

const TABLES = [
  "tracking_identity_births",
  "erp_stock_import_row_resolutions",
  "inventory_identity_anchors",
  "inventory_identity_anchor_lines",
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

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0102-tracking-identity-birth.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
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
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'tib-a', 'TIB A', 'USD'), ($2, 'tib-b', 'TIB B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A1', 'Store A1'), ($2, $4, 'B1', 'Store B1')`, [
    STORE_A,
    STORE_B,
    TENANT_A,
    TENANT_B,
  ]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $4, 'Lot A', 'standard', $6, $6, 'batch'), ($2, $4, 'Lot A2', 'standard', $6, $6, 'batch'),
            ($3, $5, 'Lot B', 'standard', $6, $6, 'batch')`,
    [PRODUCT_A, PRODUCT_A2, PRODUCT_B, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, origin)
     VALUES ($1, $3, $4, 'batch', 'LOT-A', 'erp_external'), ($2, $5, $6, 'batch', 'LOT-B', 'erp_external')`,
    [IDENTITY_A, IDENTITY_B, TENANT_A, PRODUCT_A, TENANT_B, PRODUCT_B],
  );
  await a.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at, summary)
     VALUES ($1, $3, $4, 'stock', 'on_demand', 'completed', now(), '{}'::jsonb),
            ($2, $5, $6, 'stock', 'on_demand', 'completed', now(), '{}'::jsonb)`,
    [RUN_A, RUN_B, TENANT_A, STORE_A, TENANT_B, STORE_B],
  );
  await a.query(
    `INSERT INTO inventory_anchors
       (id, tenant_id, store_id, stock_location_id, inventory_status, generation, source_run_id,
        snapshot_read_at, snapshot_recorded_at, erpnext_warehouse_ref, activated_at, coverage, created_by)
     VALUES ($1, $2, $3, (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable', 1, $4,
             now(), now(), 'WH-A', now(), '{}'::jsonb, $5)`,
    [ANCHOR_A, TENANT_A, STORE_A, RUN_A, ACTOR],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
     VALUES ($1, $2, $3, 'stock', 'WH-A', $4, 1)`,
    [MAP_A, TENANT_A, STORE_A, ACTOR],
  );
  await a.query(
    `INSERT INTO erp_stock_import_runs
       (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, status, settle_seconds, overlap_seconds, ended_at)
     VALUES ($1, $2, $3, $4, 'WH-A', 'completed', 300, 3900, now())`,
    [IMPORT_RUN_A, TENANT_A, STORE_A, MAP_A],
  );
  await a.query(`INSERT INTO erp_stock_import_pages (id, tenant_id, run_id, page_seq, max_rows) VALUES ($1, $2, $3, 0, 100)`, [
    PAGE_A,
    TENANT_A,
    IMPORT_RUN_A,
  ]);
  await a.query(
    `INSERT INTO erp_stock_import_rows
       (id, tenant_id, store_id, page_id, erpnext_warehouse_ref, ledger_entry_ref, entry_index, voucher_type,
        voucher_no, erpnext_item_ref, erpnext_batch_ref, creation, is_cancelled, actual_qty, stock_uom, outcome,
        tenant_product_ref)
     VALUES ($1, $2, $3, $4, 'WH-A', 'SLE-1', 0, 'Purchase Receipt', 'PR-1', 'ITEM-A', 'LOT-A', now(), false, 2, 'ea',
             'awaiting_identity', $5)`,
    [ROW_A, TENANT_A, STORE_A, PAGE_A, PRODUCT_A],
  );
  await a.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by,
        stock_location_id, inventory_status, origin, event_type, event_ref_id, source_system, external_id,
        tracking_identity_id)
     VALUES ($1, $2, $3, $4, 'inbound', 2, 'ea', now(), $5,
             (SELECT id FROM stock_locations WHERE store_id = $3 AND kind = 'primary'), 'sellable',
             'erp_external', 'erp_procurement_receipt', $6, 'erpnext', 'k-100', $7)`,
    [MOVEMENT_A, TENANT_A, STORE_A, PRODUCT_A, ACTOR, ROW_A, IDENTITY_A],
  );
  await a.query(upSql);
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const BIRTH_SQL = `INSERT INTO tracking_identity_births
    (id, tenant_id, tracking_identity_id, tenant_product_ref, source, reconciliation_run_id, import_row_id,
     erpnext_item_ref, erpnext_batch_ref)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'ITEM-A', 'LOT-A')`;

const RESOLUTION_SQL = `INSERT INTO erp_stock_import_row_resolutions
    (id, tenant_id, row_id, tracking_identity_id, tenant_product_ref, outcome, effect_key, effect_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

describe("0102: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0102: tables, RLS and CHECKs", () => {
  it("creates the four tables with FORCE ROW LEVEL SECURITY and SELECT / INSERT policies only", async () => {
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
    for (const t of TABLES) {
      expect(p.rows.filter((x) => x.tablename === t).map((x) => x.cmd)).toEqual(["INSERT", "SELECT"]);
    }
  });

  it("a birth names exactly its own evidence and the identity of its own product", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      const attempt = async (args: unknown[], code: string): Promise<void> => {
        await client.query("SAVEPOINT s");
        await expect(client.query(BIRTH_SQL, args)).rejects.toMatchObject({ code });
        await client.query("ROLLBACK TO SAVEPOINT s");
      };
      // tracking_master without its run, or with an import row too.
      await attempt([id("0a101"), TENANT_A, IDENTITY_A, PRODUCT_A, "tracking_master", null, null], "23514");
      await attempt([id("0a102"), TENANT_A, IDENTITY_A, PRODUCT_A, "tracking_master", RUN_A, ROW_A], "23514");
      // stock_import without its row.
      await attempt([id("0a103"), TENANT_A, IDENTITY_A, PRODUCT_A, "stock_import", null, null], "23514");
      // The identity of another product.
      await attempt([id("0a104"), TENANT_A, IDENTITY_A, PRODUCT_A2, "tracking_master", RUN_A, null], "23503");
      await attempt([id("0a105"), TENANT_A, IDENTITY_A, PRODUCT_A, "manual", null, null], "23514");
      await client.query(BIRTH_SQL, [id("0a106"), TENANT_A, IDENTITY_A, PRODUCT_A, "stock_import", null, ROW_A]);
      // An identity is born once.
      await attempt([id("0a107"), TENANT_A, IDENTITY_A, PRODUCT_A, "tracking_master", RUN_A, null], "23505");
    });
  });

  it("a resolution is once per row, and only `imported` names its effect", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      const attempt = async (args: unknown[], code: string): Promise<void> => {
        await client.query("SAVEPOINT s");
        await expect(client.query(RESOLUTION_SQL, args)).rejects.toMatchObject({ code });
        await client.query("ROLLBACK TO SAVEPOINT s");
      };
      await attempt([id("0a111"), TENANT_A, ROW_A, IDENTITY_A, PRODUCT_A, "imported", "k", null], "23514");
      await attempt([id("0a112"), TENANT_A, ROW_A, IDENTITY_A, PRODUCT_A, "covered", null, MOVEMENT_A], "23514");
      await attempt([id("0a113"), TENANT_A, ROW_A, IDENTITY_A, PRODUCT_A, "awaiting_identity", null, null], "23514");
      await client.query(RESOLUTION_SQL, [id("0a114"), TENANT_A, ROW_A, IDENTITY_A, PRODUCT_A, "imported", "k-100", MOVEMENT_A]);
      await attempt([id("0a115"), TENANT_A, ROW_A, IDENTITY_A, PRODUCT_A, "covered", null, null], "23505");
    });
  });

  it("an import row's event_type is an ERP event type or null", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      // No UPDATE policy: under FORCE RLS the rows stay append-only for the app role.
      const r = await client.query(`UPDATE erp_stock_import_rows SET event_type = 'erp_correction' WHERE id = $1`, [ROW_A]);
      expect(r.rowCount).toBe(0);
    });
    const a = guard().admin;
    await expect(a.query(`UPDATE erp_stock_import_rows SET event_type = 'sale' WHERE id = $1`, [ROW_A])).rejects.toMatchObject({
      code: "23514",
    });
    await a.query(`UPDATE erp_stock_import_rows SET event_type = 'erp_procurement_receipt' WHERE id = $1`, [ROW_A]);
    await a.query(`UPDATE erp_stock_import_rows SET event_type = NULL WHERE id = $1`, [ROW_A]);
  });

  it("an identity anchor line names its own product's identity, once per anchor", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO inventory_identity_anchors
           (id, tenant_id, store_id, generation, base_anchor_id, source_run_id, snapshot_read_at, snapshot_recorded_at,
            erpnext_warehouse_ref, activated_at, coverage, created_by)
         VALUES ($1, $2, $3, 1, $4, $5, now(), now(), 'WH-A', now(), '{}'::jsonb, $6)`,
        [id("0a121"), TENANT_A, STORE_A, ANCHOR_A, RUN_A, ACTOR],
      );
      const LINE = `INSERT INTO inventory_identity_anchor_lines
          (id, identity_anchor_id, tenant_id, tracking_identity_id, tenant_product_ref, quantity, erp_stock_uom, erpnext_batch_ref)
        VALUES ($1, $2, $3, $4, $5, 6, 'ea', 'LOT-A')`;
      await client.query("SAVEPOINT s");
      await expect(client.query(LINE, [id("0a122"), id("0a121"), TENANT_A, IDENTITY_A, PRODUCT_A2])).rejects.toMatchObject({
        code: "23503",
      });
      await client.query("ROLLBACK TO SAVEPOINT s");
      await client.query(LINE, [id("0a123"), id("0a121"), TENANT_A, IDENTITY_A, PRODUCT_A]);
      await client.query("SAVEPOINT t");
      await expect(client.query(LINE, [id("0a124"), id("0a121"), TENANT_A, IDENTITY_A, PRODUCT_A])).rejects.toMatchObject({
        code: "23505",
      });
      await client.query("ROLLBACK TO SAVEPOINT t");
      // generation 1 again for the store
      await client.query("SAVEPOINT u");
      await expect(
        client.query(
          `INSERT INTO inventory_identity_anchors
             (id, tenant_id, store_id, generation, base_anchor_id, source_run_id, snapshot_read_at, snapshot_recorded_at,
              erpnext_warehouse_ref, activated_at, coverage, created_by)
           VALUES ($1, $2, $3, 1, $4, $5, now(), now(), 'WH-A', now(), '{}'::jsonb, $6)`,
          [id("0a125"), TENANT_A, STORE_A, ANCHOR_A, RUN_A, ACTOR],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT u");
    });
  });

  it("accepts the tracking_mismatch reconciliation class and still refuses an unknown one", async () => {
    if (skip()) return;
    const SQL = `INSERT INTO erpnext_reconciliation_result (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
                 VALUES ($1, $2, $3, $4, $5, 'open')`;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(SQL, [id("0a131"), RUN_A, TENANT_A, "tracking_mismatch", PRODUCT_A]);
      await client.query("SAVEPOINT s");
      await expect(client.query(SQL, [id("0a132"), RUN_A, TENANT_A, "tracking_grain", PRODUCT_A])).rejects.toMatchObject({
        code: "23514",
      });
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    const v = await guard().admin.query<{ validated: boolean }>(
      `SELECT convalidated AS validated FROM pg_constraint WHERE conname = 'erpnext_reconciliation_result_class_valid'`,
    );
    expect(v.rows[0]!.validated).toBe(true);
  });
});

describe("0102: tenant isolation (FORCE RLS)", () => {
  it("writes and reads only the caller's tenant, and nothing under an empty GUC", async () => {
    if (skip()) return;
    await guard().admin.query(BIRTH_SQL, [id("0b141"), TENANT_B, IDENTITY_B, PRODUCT_B, "tracking_master", RUN_B, null]);
    try {
      await asApp(guard(), TENANT_A, async (client) => {
        expect((await client.query(`SELECT 1 FROM tracking_identity_births`)).rowCount).toBe(0);
        await client.query("SAVEPOINT s");
        await expect(
          client.query(BIRTH_SQL, [id("0b142"), TENANT_B, IDENTITY_B, PRODUCT_B, "tracking_master", RUN_B, null]),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT s");
        expect((await client.query(`DELETE FROM tracking_identity_births`)).rowCount).toBe(0);
      });
      await asApp(guard(), TENANT_B, async (client) => {
        expect((await client.query(`SELECT 1 FROM tracking_identity_births`)).rowCount).toBe(1);
      });
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM tracking_identity_births`)).rowCount).toBe(0);
      });
    } finally {
      await guard().admin.query(`DELETE FROM tracking_identity_births`);
    }
  });
});

describe("0102: UP -> DOWN -> UP", () => {
  const exists = async (): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass('tracking_identity_births')::text AS t`)).rows[0]!
      .t !== null;
  const OWNER_TABLES = [
    "tenants",
    "tracking_identities",
    "erp_stock_import_rows",
    "stock_movements",
    "inventory_anchors",
    "erpnext_reconciliation_run",
    "erpnext_reconciliation_result",
    "stores",
    ...TABLES,
  ];

  it("refuses while a birth exists, also as a NOSUPERUSER migration owner", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(BIRTH_SQL, [id("0a151"), TENANT_A, IDENTITY_A, PRODUCT_A, "tracking_master", RUN_A, null]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt453_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists()).toBe(true);
    } finally {
      await e.admin.query(`DELETE FROM tracking_identity_births`);
    }
  });

  it("refuses while a tracking_mismatch result exists", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(
      `INSERT INTO erpnext_reconciliation_result (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
       VALUES ($1, $2, $3, 'tracking_mismatch', $4, 'open')`,
      [id("0a161"), RUN_A, TENANT_A, PRODUCT_A],
    );
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    } finally {
      await e.admin.query(`DELETE FROM erpnext_reconciliation_result WHERE mismatch_class = 'tracking_mismatch'`);
    }
  });

  it("drops the tables and the column once empty, restores the 0066 CHECK, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists()).toBe(false);
    const check = await e.admin.query<{ def: string; validated: boolean }>(
      `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
         FROM pg_constraint WHERE conname = 'erpnext_reconciliation_result_class_valid'`,
    );
    expect(check.rows[0]!.def).not.toContain("tracking_mismatch");
    // Validated again, as 0066 left it (the 0066 probe reads a validated CHECK).
    expect(check.rows[0]!.validated).toBe(true);
    expect(check.rows[0]!.def).toContain("uom_mismatch");
    const col = await e.admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'erp_stock_import_rows' AND column_name = 'event_type'`,
    );
    expect(col.rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists()).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt453_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists()).toBe(true);
  });
});
