/**
 * RT-451 S2: `0086_tracked_selling_tenant_switch` migration test (M1 part 1;
 * owner approval RT-451 comment 16216).
 *
 * Validates `packages/db/drizzle/0086_tracked_selling_tenant_switch.sql`
 * (+ `.down.sql`):
 *   - three columns on `tenant_inventory_settings`; a settings row that exists
 *     BEFORE 0086 (the UPGRADE path) reads OFF with no recorded change;
 *   - a new row defaults to OFF;
 *   - the CHECKs: changed-at and changed-by both NULL or both set, and ON only
 *     with a recorded change;
 *   - the existing tenant RLS still isolates the new columns, and an app-role
 *     write to another tenant's row changes nothing;
 *   - the down REFUSES while any tenant is switched on (OD-T7: the switch
 *     never turns itself off), also as a NOSUPERUSER migration owner under
 *     FORCE RLS, where a bare SELECT would see no rows;
 *   - UP -> DOWN -> UP round-trips once every tenant is off, also run by that
 *     owner; the down drops ONLY the three columns and two CHECKs.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0086_tracked_selling_tenant_switch.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0086_tracked_selling_tenant_switch.down.sql");

const TENANT_A = "08600000-0000-7000-8000-00000000a001";
const TENANT_B = "08600000-0000-7000-8000-00000000b001";
const ACTOR = "08600000-0000-7000-8000-00000000a0a1";

const COLUMNS = ["tracked_selling_changed_at", "tracked_selling_changed_by", "tracked_selling_enabled"];
const CONSTRAINTS = [
  "tenant_inventory_settings_tracked_selling_change_pair",
  "tenant_inventory_settings_tracked_selling_on_changed",
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
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0086-tracked-selling-tenant-switch.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'ts-a', 'Switch A', 'USD'), ($2, 'ts-b', 'Switch B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  // A settings row that exists BEFORE 0086: it must read OFF, never changed.
  await a.query(`INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2)`, [TENANT_A, ACTOR]);
  await a.query(upSql);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const SET_SWITCH = `UPDATE tenant_inventory_settings
    SET tracked_selling_enabled = $2, tracked_selling_changed_at = $3, tracked_selling_changed_by = $4
  WHERE tenant_id = $1`;

describe("0086: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0086: the columns", () => {
  it("adds the switch NOT NULL DEFAULT false and the two nullable change columns", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'tenant_inventory_settings' AND column_name = ANY($1) ORDER BY column_name`,
      [COLUMNS],
    );
    expect(cols.rows).toEqual([
      { column_name: "tracked_selling_changed_at", is_nullable: "YES", column_default: null },
      { column_name: "tracked_selling_changed_by", is_nullable: "YES", column_default: null },
      { column_name: "tracked_selling_enabled", is_nullable: "NO", column_default: "false" },
    ]);
  });

  it("reads a pre-0086 settings row as OFF with no recorded change (upgrade path)", async () => {
    if (skip()) return;
    const r = await guard().admin.query(`SELECT ${COLUMNS.join(", ")} FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(r.rows).toEqual([
      { tracked_selling_changed_at: null, tracked_selling_changed_by: null, tracked_selling_enabled: false },
    ]);
  });

  it("defaults a new settings row to OFF", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ tracked_selling_enabled: boolean }>(
        `INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2) RETURNING tracked_selling_enabled`,
        [TENANT_B, ACTOR],
      );
      expect(r.rows).toEqual([{ tracked_selling_enabled: false }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("declares the two CHECK constraints", async () => {
    if (skip()) return;
    const c = await guard().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'tenant_inventory_settings'::regclass AND conname = ANY($1) ORDER BY conname`,
      [CONSTRAINTS],
    );
    expect(c.rows.map((r) => r.conname)).toEqual(CONSTRAINTS);
  });
});

describe("0086: the CHECKs", () => {
  afterEach(async () => {
    if (skip()) return;
    await guard().admin.query(SET_SWITCH, [TENANT_A, false, null, null]);
  });

  it("stores ON with its change, and OFF after a change", async () => {
    if (skip()) return;
    await expect(guard().admin.query(SET_SWITCH, [TENANT_A, true, new Date(), ACTOR])).resolves.toBeDefined();
    await expect(guard().admin.query(SET_SWITCH, [TENANT_A, false, new Date(), ACTOR])).resolves.toBeDefined();
  });

  it.each<[string, boolean, Date | null, string | null]>([
    ["ON with no recorded change", true, null, null],
    ["a change time without its actor", false, new Date(), null],
    ["an actor without its change time", false, null, ACTOR],
    ["ON with only an actor", true, null, ACTOR],
  ])("refuses %s (23514)", async (_why, enabled, at, by) => {
    if (skip()) return;
    await expect(guard().admin.query(SET_SWITCH, [TENANT_A, enabled, at, by])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0086: tenant isolation (the existing FORCE RLS on tenant_inventory_settings)", () => {
  it("hides another tenant's switch and refuses to change it", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_B, async (client) => {
      const seen = await client.query(`SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
      expect(seen.rowCount).toBe(0);
      const write = await client.query(SET_SWITCH, [TENANT_A, true, new Date(), ACTOR]);
      expect(write.rowCount).toBe(0);
    });
    const stored = await guard().admin.query(`SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(stored.rows).toEqual([{ tracked_selling_enabled: false }]);
  });
});

describe("0086: UP -> DOWN -> UP", () => {
  const columnNames = async (): Promise<string[]> =>
    (
      await guard().admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_inventory_settings' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);

  it("refuses while a tenant is switched on, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(SET_SWITCH, [TENANT_A, true, new Date(), ACTOR]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt451_m1_refuse_owner", tables: ["tenants", "tenant_inventory_settings"], functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await columnNames()).toEqual(expect.arrayContaining(COLUMNS));
      const kept = await e.admin.query(`SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
      expect(kept.rows).toEqual([{ tracked_selling_enabled: true }]);
    } finally {
      await e.admin.query(SET_SWITCH, [TENANT_A, false, new Date(), ACTOR]);
    }
  });

  it("drops ONLY the three columns and two CHECKs once every tenant is off, keeps every row, and comes back OFF", async () => {
    if (skip()) return;
    const e = guard();
    // Switched off after a change: the down discards the change time and actor.
    await e.admin.query(SET_SWITCH, [TENANT_A, false, new Date(), ACTOR]);
    const before = await columnNames();
    await e.admin.query(downSql);
    const after = await columnNames();
    expect(before.filter((c) => !after.includes(c))).toEqual(COLUMNS);
    expect(after).toHaveLength(before.length - COLUMNS.length);
    const left = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conname = ANY($1)`, [CONSTRAINTS]);
    expect(left.rowCount).toBe(0);
    expect((await e.admin.query(`SELECT 1 FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(1);
    // The down is rerunnable, and the up brings the switch back OFF.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    const back = await e.admin.query(`SELECT tracked_selling_enabled FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(back.rows).toEqual([{ tracked_selling_enabled: false }]);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt451_m1_owner", tables: ["tenants", "tenant_inventory_settings"], functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await columnNames()).toEqual(expect.arrayContaining(COLUMNS));
  });
});
