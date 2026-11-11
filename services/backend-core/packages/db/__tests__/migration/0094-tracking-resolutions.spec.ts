/**
 * RT-451 S5: `0094_tracking_resolutions` migration test (M3; owner approval
 * RT-451 comment 16535; content of comment 15288's S5 row).
 *
 * Validates `packages/db/drizzle/0094_tracking_resolutions.sql` (+ `.down.sql`):
 *   - `tracking_resolutions`: one per sale (23505), one per command
 *     fingerprint (23505), the reason-code pattern, a trimmed non-blank note
 *     of at most 500 characters, a SHA-256 hex fingerprint, the sale of the
 *     same tenant and store (23503);
 *   - `tracking_resolution_lines`: one per sale line, the resolution of the
 *     same tenant, an identity of the line's own product and tenant (23503);
 *   - both FORCE RLS with SELECT and INSERT policies only (append-only); an
 *     empty tenant GUC sees nothing;
 *   - the down REFUSES while any resolution exists, also as a NOSUPERUSER
 *     migration owner under FORCE RLS, where a bare SELECT would see no rows;
 *   - UP -> DOWN -> UP round-trips once none exists, also run by that owner,
 *     and the down is rerunnable.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0094_tracking_resolutions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0094_tracking_resolutions.down.sql");

const id = (n: string): string => `09400000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_B = id("0b021");
const PRODUCT_A = id("0a031");
const PRODUCT_A2 = id("0a032");
const PRODUCT_B = id("0b031");
const ACTOR = id("0a0a1");
const IDENTITY_A = id("0a041");
const IDENTITY_A2 = id("0a042");
const IDENTITY_B = id("0b041");
const SALE_A = id("0a061");
const SALE_A2 = id("0a062");
const SALE_B = id("0b061");
const LINE_A = id("0a071");
const LINE_A2 = id("0a072");
const LINE_B = id("0b071");
const RES_A = id("0a081");
const RES_B = id("0b081");

const RESOLUTIONS = "tracking_resolutions";
const LINES = "tracking_resolution_lines";
const FP = "a".repeat(64);

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function seedSale(saleId: string, tenantId: string, storeId: string, deviceId: string, ext: string): Promise<void> {
  await guard().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, device_id, tracking_status)
     VALUES ($1, $2, $3, 'USD', 10, '2026-11-11T10:00:00Z', '2026-11-11', 'pos', $5, repeat('a', 64), $6, $4,
             'tracking_unresolved')`,
    [saleId, tenantId, storeId, deviceId, ext, ACTOR],
  );
}

async function seedLine(lineId: string, saleId: string, tenantId: string, storeId: string, productId: string): Promise<void> {
  await guard().admin.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit, tenant_product_ref, tracking_class, tracking_unresolved_reason)
     VALUES ($1, $2, $3, $4, 'L', 10, 'USD', 1, 10, 'pcs', $5, 'unresolved', 'tracking_missing')`,
    [lineId, saleId, tenantId, storeId, productId],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0094-tracking-resolutions.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'm3-a', 'M3 A', 'USD'), ($2, 'm3-b', 'M3 B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $3, $4, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A, TENANT_B, STORE_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $4, 'Product A', 'standard', $6, $6, 'batch'), ($2, $4, 'Product A2', 'standard', $6, $6, 'batch'),
            ($3, $5, 'Product B', 'standard', $6, $6, 'batch')`,
    [PRODUCT_A, PRODUCT_A2, PRODUCT_B, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code)
     VALUES ($1, $4, $5, 'batch', 'LOT-A'), ($2, $4, $6, 'batch', 'LOT-A2'), ($3, $7, $8, 'batch', 'LOT-B')`,
    [IDENTITY_A, IDENTITY_A2, IDENTITY_B, TENANT_A, PRODUCT_A, PRODUCT_A2, TENANT_B, PRODUCT_B],
  );
  await seedSale(SALE_A, TENANT_A, STORE_A, DEVICE_A, "m3-a-1");
  await seedSale(SALE_A2, TENANT_A, STORE_A, DEVICE_A, "m3-a-2");
  await seedSale(SALE_B, TENANT_B, STORE_B, DEVICE_B, "m3-b-1");
  await seedLine(LINE_A, SALE_A, TENANT_A, STORE_A, PRODUCT_A);
  await seedLine(LINE_A2, SALE_A2, TENANT_A, STORE_A, PRODUCT_A);
  await seedLine(LINE_B, SALE_B, TENANT_B, STORE_B, PRODUCT_B);
  await a.query(upSql);
  // The app role's table grants are taken after the tables exist.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface Resolution {
  id: string;
  tenant_id: string;
  store_id: string;
  sale_id: string;
  captured_at: string;
  reason_code: string;
  note: string;
  command_fingerprint: string;
  resolved_by: string;
}

const RESOLUTION: Resolution = {
  id: RES_A,
  tenant_id: TENANT_A,
  store_id: STORE_A,
  sale_id: SALE_A,
  captured_at: "2026-11-11T10:00:01Z",
  reason_code: "label_misprint",
  note: "Scanned the shelf label; lot read from the box.",
  command_fingerprint: FP,
  resolved_by: ACTOR,
};

const RESOLUTION_B: Resolution = {
  ...RESOLUTION,
  id: RES_B,
  tenant_id: TENANT_B,
  store_id: STORE_B,
  sale_id: SALE_B,
};

interface Binding {
  sale_line_id: string;
  tenant_id: string;
  resolution_id: string;
  tenant_product_ref: string;
  tracking_identity_id: string;
}

const BINDING: Binding = {
  sale_line_id: LINE_A,
  tenant_id: TENANT_A,
  resolution_id: RES_A,
  tenant_product_ref: PRODUCT_A,
  tracking_identity_id: IDENTITY_A,
};

const BINDING_B: Binding = {
  sale_line_id: LINE_B,
  tenant_id: TENANT_B,
  resolution_id: RES_B,
  tenant_product_ref: PRODUCT_B,
  tracking_identity_id: IDENTITY_B,
};

const R_COLUMNS = Object.keys(RESOLUTION) as (keyof Resolution)[];
const B_COLUMNS = Object.keys(BINDING) as (keyof Binding)[];
const INSERT_R = `INSERT INTO ${RESOLUTIONS} (${R_COLUMNS.join(", ")}) VALUES (${R_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;
const INSERT_B = `INSERT INTO ${LINES} (${B_COLUMNS.join(", ")}) VALUES (${B_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;
const rValues = (row: Resolution): unknown[] => R_COLUMNS.map((c) => row[c]);
const bValues = (row: Binding): unknown[] => B_COLUMNS.map((c) => row[c]);

/** Insert resolutions then bindings as the superuser in a rolled-back transaction; the error code or null. */
async function tryRows(resolutions: Resolution[], bindings: Binding[] = []): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    for (const row of resolutions) await client.query(INSERT_R, rValues(row));
    for (const row of bindings) await client.query(INSERT_B, bValues(row));
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("0094: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0094: the tables", () => {
  it.each([RESOLUTIONS, LINES])("creates %s with FORCE ROW LEVEL SECURITY and only SELECT and INSERT policies", async (table) => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [table],
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await guard().admin.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname`,
      [table],
    );
    expect(policies.rows).toEqual([
      { policyname: `${table}_tenant_insert`, cmd: "INSERT" },
      { policyname: `${table}_tenant_read`, cmd: "SELECT" },
    ]);
  });

  it("records a resolution with its bindings, and gives it a server id and resolution time", async () => {
    if (skip()) return;
    expect(await tryRows([RESOLUTION], [BINDING])).toBeNull();
    const defaults = await guard().admin.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = $1 AND column_name IN ('id', 'resolved_at') ORDER BY column_name`,
      [RESOLUTIONS],
    );
    expect(defaults.rows).toEqual([
      { column_name: "id", column_default: "gen_random_uuid()" },
      { column_name: "resolved_at", column_default: "now()" },
    ]);
  });

  it("resolves a sale once, and records a command once (23505)", async () => {
    if (skip()) return;
    const other = { ...RESOLUTION, id: id("0a082") };
    expect(await tryRows([RESOLUTION, { ...other, command_fingerprint: "b".repeat(64) }])).toBe("23505");
    expect(await tryRows([RESOLUTION, { ...other, sale_id: SALE_A2 }])).toBe("23505");
    expect(await tryRows([RESOLUTION, { ...other, sale_id: SALE_A2, command_fingerprint: "b".repeat(64) }])).toBeNull();
  });

  it("binds a line once (23505)", async () => {
    if (skip()) return;
    expect(await tryRows([RESOLUTION], [BINDING, { ...BINDING, tracking_identity_id: IDENTITY_A }])).toBe("23505");
  });

  it.each<[string, Partial<Resolution>]>([
    ["an upper-case reason code", { reason_code: "Label_misprint" }],
    ["a reason code starting with a digit", { reason_code: "1_label" }],
    ["an empty note", { note: "" }],
    ["an untrimmed note", { note: " lot read from the box " }],
    ["a 501-character note", { note: "x".repeat(501) }],
    ["a fingerprint that is not SHA-256 hex", { command_fingerprint: "A".repeat(64) }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await tryRows([{ ...RESOLUTION, ...change }])).toBe("23514");
  });

  it.each<[string, Partial<Resolution>, Partial<Binding>]>([
    ["a sale of another tenant", { sale_id: SALE_B }, {}],
    ["a sale of another store", { store_id: STORE_A2 }, {}],
    ["another product's identity", {}, { tracking_identity_id: IDENTITY_A2 }],
    ["an identity of another tenant", {}, { tracking_identity_id: IDENTITY_B }],
    ["a resolution of another tenant", {}, { resolution_id: RES_B }],
    ["an unknown sale line", {}, { sale_line_id: id("0a0ff") }],
  ])("refuses %s (23503)", async (_why, rChange, bChange) => {
    if (skip()) return;
    const resolutions = bChange.resolution_id === RES_B ? [{ ...RESOLUTION, ...rChange }, RESOLUTION_B] : [{ ...RESOLUTION, ...rChange }];
    expect(await tryRows(resolutions, [{ ...BINDING, ...bChange }])).toBe("23503");
  });
});

describe("0094: tenant isolation and append-only (FORCE RLS)", () => {
  it("lets the app role write and read only its own tenant, and never change or remove a resolution", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(INSERT_R, rValues(RESOLUTION));
      await client.query(INSERT_B, bValues(BINDING));
      expect((await client.query(`SELECT 1 FROM ${RESOLUTIONS}`)).rowCount).toBe(1);
      expect((await client.query(`SELECT 1 FROM ${LINES}`)).rowCount).toBe(1);
      await client.query("SAVEPOINT other");
      await expect(client.query(INSERT_R, rValues(RESOLUTION_B))).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT other");
      expect((await client.query(`UPDATE ${RESOLUTIONS} SET note = 'changed'`)).rowCount).toBe(0);
      expect((await client.query(`UPDATE ${LINES} SET tracking_identity_id = tracking_identity_id`)).rowCount).toBe(0);
      expect((await client.query(`DELETE FROM ${LINES}`)).rowCount).toBe(0);
      expect((await client.query(`DELETE FROM ${RESOLUTIONS}`)).rowCount).toBe(0);
      expect((await client.query(`SELECT note FROM ${RESOLUTIONS}`)).rows).toEqual([{ note: RESOLUTION.note }]);
    });
    await asApp(guard(), TENANT_B, async (client) => {
      await client.query(INSERT_R, rValues(RESOLUTION_B));
      await client.query(INSERT_B, bValues(BINDING_B));
      const seen = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${RESOLUTIONS}`);
      expect(seen.rows).toEqual([{ tenant_id: TENANT_B }]);
      const lines = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${LINES}`);
      expect(lines.rows).toEqual([{ tenant_id: TENANT_B }]);
    });
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await guard().admin.query(INSERT_R, rValues(RESOLUTION));
    await guard().admin.query(INSERT_B, bValues(BINDING));
    try {
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${RESOLUTIONS}`)).rowCount).toBe(0);
        expect((await client.query(`SELECT 1 FROM ${LINES}`)).rowCount).toBe(0);
      });
    } finally {
      await guard().admin.query(`DELETE FROM ${LINES}`);
      await guard().admin.query(`DELETE FROM ${RESOLUTIONS}`);
    }
  });
});

describe("0094: UP -> DOWN -> UP", () => {
  const tablesExist = async (): Promise<boolean[]> =>
    (
      await guard().admin.query<{ r: string | null; l: string | null }>(
        `SELECT to_regclass($1)::text AS r, to_regclass($2)::text AS l`,
        [RESOLUTIONS, LINES],
      )
    ).rows.map((row) => [row.r !== null, row.l !== null])[0]!;
  const OWNER_TABLES = [
    "tenants",
    "stores",
    "devices",
    "tenant_products",
    "tracking_identities",
    "sales",
    "sale_lines",
    RESOLUTIONS,
    LINES,
  ];

  it("refuses while a resolution exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(INSERT_R, rValues(RESOLUTION_B));
    await e.admin.query(INSERT_B, bValues(BINDING_B));
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt451_m3_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await tablesExist()).toEqual([true, true]);
      expect((await e.admin.query(`SELECT 1 FROM ${LINES}`)).rowCount).toBe(1);
    } finally {
      await e.admin.query(`DELETE FROM ${LINES}`);
      await e.admin.query(`DELETE FROM ${RESOLUTIONS}`);
    }
  });

  it("drops both tables once no resolution exists, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await tablesExist()).toEqual([false, false]);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await tablesExist()).toEqual([true, true]);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt451_m3_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await tablesExist()).toEqual([true, true]);
  });
});
