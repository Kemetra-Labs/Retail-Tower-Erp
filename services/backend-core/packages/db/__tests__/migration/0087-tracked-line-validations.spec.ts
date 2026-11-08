/**
 * RT-451 S2: `0087_tracked_line_validations` migration test (M1 part 2;
 * owner approval RT-451 comment 16216; scope comment 16236).
 *
 * Validates `packages/db/drizzle/0087_tracked_line_validations.sql`
 * (+ `.down.sql`):
 *   - the table, its columns and its CHECKs: exactly one of the identity id and
 *     the scanned code, a scanned expiry only with the code, the closed
 *     selection / outcome / reason sets, a refusal carries exactly one reason,
 *     an acceptance names its identity, a positive quantity;
 *   - the same-tenant FKs: a store, device or product of another tenant (or a
 *     device of another store) is refused;
 *   - FORCE RLS with SELECT and INSERT policies only: the app role sees and
 *     writes only its own tenant, an empty tenant GUC sees nothing, and an
 *     UPDATE or DELETE changes nothing (append-only);
 *   - the down REFUSES while any record exists, also as a NOSUPERUSER
 *     migration owner under FORCE RLS, where a bare SELECT would see no rows;
 *   - UP -> DOWN -> UP round-trips once no record exists, also run by that
 *     owner, and the down is rerunnable.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0087_tracked_line_validations.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0087_tracked_line_validations.down.sql");

const id = (n: string): string => `08700000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_A2 = id("0a022");
const DEVICE_B = id("0b021");
const PRODUCT_A = id("0a031");
const PRODUCT_B = id("0b031");
const ACTOR = id("0a0a1");
const IDENTITY = id("0a041");

const TABLE = "tracked_line_validations";

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
      console.warn(`\n[0087-tracked-line-validations.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'tlv-a', 'TLV A', 'USD'), ($2, 'tlv-b', 'TLV B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $4, $5, decode(repeat('a1', 32), 'hex')), ($2, $4, $6, decode(repeat('a2', 32), 'hex')),
            ($3, $7, $8, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_A2, DEVICE_B, TENANT_A, STORE_A, STORE_A2, TENANT_B, STORE_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $3, 'Product A', 'standard', $5, $5, 'batch'), ($2, $4, 'Product B', 'standard', $5, $5, 'batch')`,
    [PRODUCT_A, PRODUCT_B, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(upSql);
  // The app role's table grants are taken after the table exists.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface Row {
  tenant_id: string;
  store_id: string;
  device_id: string;
  operator_user_id: string;
  auth_path: string;
  tenant_product_ref: string;
  requested_identity_id: string | null;
  requested_code: string | null;
  scanned_expiry_date: string | null;
  resolved_identity_id: string | null;
  suggested_identity_id: string | null;
  selection: string;
  quantity: string;
  draft_line_ref: string;
  outcome: string;
  refusal_reason: string | null;
  safety_revision: number;
}

const ACCEPTED: Row = {
  tenant_id: TENANT_A,
  store_id: STORE_A,
  device_id: DEVICE_A,
  operator_user_id: ACTOR,
  auth_path: "device",
  tenant_product_ref: PRODUCT_A,
  requested_identity_id: IDENTITY,
  requested_code: null,
  scanned_expiry_date: null,
  resolved_identity_id: IDENTITY,
  suggested_identity_id: null,
  selection: "scanned",
  quantity: "2",
  draft_line_ref: "draft-1",
  outcome: "accepted",
  refusal_reason: null,
  safety_revision: 0,
};

const COLUMNS = Object.keys(ACCEPTED) as (keyof Row)[];
const INSERT = `INSERT INTO ${TABLE} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;
const values = (row: Row): unknown[] => COLUMNS.map((c) => row[c]);

/** Insert as the superuser inside a rolled-back transaction; returns the error code or null. */
async function tryInsert(row: Row): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(INSERT, values(row));
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("0087: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0087: the table", () => {
  it("creates the table with FORCE ROW LEVEL SECURITY and only SELECT and INSERT policies", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [TABLE],
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await guard().admin.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname`,
      [TABLE],
    );
    expect(policies.rows).toEqual([
      { policyname: "tracked_line_validations_tenant_insert", cmd: "INSERT" },
      { policyname: "tracked_line_validations_tenant_read", cmd: "SELECT" },
    ]);
  });

  it("stores an accepted and a refused record, with a server id and time", async () => {
    if (skip()) return;
    expect(await tryInsert(ACCEPTED)).toBeNull();
    expect(
      await tryInsert({
        ...ACCEPTED,
        requested_identity_id: null,
        requested_code: "LOT-1",
        scanned_expiry_date: "2027-01-31",
        resolved_identity_id: null,
        outcome: "refused",
        refusal_reason: "unknown_identity",
        auth_path: "envelope",
      }),
    ).toBeNull();
    const defaults = await guard().admin.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = $1 AND column_name IN ('id', 'validated_at') ORDER BY column_name`,
      [TABLE],
    );
    expect(defaults.rows).toEqual([
      { column_name: "id", column_default: "gen_random_uuid()" },
      { column_name: "validated_at", column_default: "now()" },
    ]);
  });

  it.each<[string, Partial<Row>]>([
    ["neither the identity id nor the code", { requested_identity_id: null }],
    ["both the identity id and the code", { requested_code: "LOT-1" }],
    ["a scanned expiry without the code", { scanned_expiry_date: "2027-01-31" }],
    ["an empty code", { requested_identity_id: null, requested_code: "" }],
    ["a 129-character code", { requested_identity_id: null, requested_code: "x".repeat(129) }],
    ["an unknown selection", { selection: "guessed" }],
    ["an unknown auth path", { auth_path: "cookie" }],
    ["a zero quantity", { quantity: "0" }],
    ["a negative quantity", { quantity: "-1" }],
    ["an empty draft line ref", { draft_line_ref: "" }],
    ["a 101-character draft line ref", { draft_line_ref: "d".repeat(101) }],
    ["an unknown outcome", { outcome: "maybe" }],
    ["an acceptance with a reason", { refusal_reason: "held" }],
    ["a refusal without a reason", { outcome: "refused" }],
    ["a refusal with an unknown reason", { outcome: "refused", refusal_reason: "out_of_stock" }],
    ["an acceptance without its identity", { resolved_identity_id: null }],
    ["a negative safety revision", { safety_revision: -1 }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await tryInsert({ ...ACCEPTED, ...change })).toBe("23514");
  });

  it.each<[string, Partial<Row>]>([
    ["a store of another tenant", { store_id: STORE_B }],
    ["a device of another store", { device_id: DEVICE_A2 }],
    ["a device of another tenant", { device_id: DEVICE_B }],
    ["a product of another tenant", { tenant_product_ref: PRODUCT_B }],
  ])("refuses %s (23503)", async (_why, change) => {
    if (skip()) return;
    expect(await tryInsert({ ...ACCEPTED, ...change })).toBe("23503");
  });
});

describe("0087: tenant isolation and append-only (FORCE RLS)", () => {
  it("lets the app role write and read only its own tenant, and never change or remove a record", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(INSERT, values(ACCEPTED));
      expect((await client.query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(1);
      // Another tenant's row is refused by the INSERT policy (42501).
      await client.query("SAVEPOINT other");
      await expect(
        client.query(INSERT, values({ ...ACCEPTED, tenant_id: TENANT_B, store_id: STORE_B, device_id: DEVICE_B, tenant_product_ref: PRODUCT_B })),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT other");
      // No UPDATE or DELETE policy: nothing is visible to change.
      expect((await client.query(`UPDATE ${TABLE} SET draft_line_ref = 'x'`)).rowCount).toBe(0);
      expect((await client.query(`DELETE FROM ${TABLE}`)).rowCount).toBe(0);
      expect((await client.query(`SELECT draft_line_ref FROM ${TABLE}`)).rows).toEqual([{ draft_line_ref: "draft-1" }]);
    });
    await asApp(guard(), TENANT_B, async (client) => {
      await client.query(INSERT, values({ ...ACCEPTED, tenant_id: TENANT_B, store_id: STORE_B, device_id: DEVICE_B, tenant_product_ref: PRODUCT_B }));
      const seen = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${TABLE}`);
      expect(seen.rows).toEqual([{ tenant_id: TENANT_B }]);
    });
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await guard().admin.query(INSERT, values(ACCEPTED));
    try {
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(0);
      });
    } finally {
      await guard().admin.query(`DELETE FROM ${TABLE}`);
    }
  });
});

describe("0087: UP -> DOWN -> UP", () => {
  const tableExists = async (): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [TABLE])).rows[0]!.t !== null;
  const OWNER_TABLES = ["tenants", "stores", "devices", "tenant_products", TABLE];

  it("refuses while a record exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(INSERT, values(ACCEPTED));
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt451_m1b_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await tableExists()).toBe(true);
      expect((await e.admin.query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(1);
    } finally {
      await e.admin.query(`DELETE FROM ${TABLE}`);
    }
  });

  it("drops the table once empty, is rerunnable, and the up recreates it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await tableExists()).toBe(false);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await tableExists()).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt451_m1b_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await tableExists()).toBe(true);
  });
});
