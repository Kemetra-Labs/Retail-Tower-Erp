/**
 * 0080 — the printer fields leave pairing_codes (Jira RT-1184, RT-1165 slice S4,
 * the contract step; [GATED] DESTRUCTIVE migration).
 *
 * Applies every migration before 0080 (so 0079 is in), seeds pairing codes that
 * carry the printer fields, applies 0080 exactly as the runner does (one `query()`
 * for the file), and proves:
 *   - before it, the three columns and their three CHECKs exist;
 *   - after it, the three columns and their CHECKs are gone, every other column
 *     and every row survives unchanged, and a code is stored without them;
 *   - the other CHECKs and the FORCE ROW LEVEL SECURITY of the table are untouched;
 *   - a second apply is a no-op;
 *   - down restores the three columns EMPTY (NULL in every row, the dropped values
 *     are not restored) with their CHECKs, which still refuse a non-NULL bad value;
 *   - up -> down -> up round-trips.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0080_pairing_codes_drop_printer_fields.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string =>
  readFileSync(resolve(DRIZZLE_DIR, "0080_pairing_codes_drop_printer_fields.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000118401";
const STORE = "0a000000-0000-7000-8000-000000118402";

const PRINTER_COLUMNS = ["printer_com_port", "printer_product_id", "printer_vendor_id"];
const PRINTER_CHECKS = [
  "pairing_codes_printer_com_port_non_empty",
  "pairing_codes_printer_product_id_hex",
  "pairing_codes_printer_vendor_id_hex",
];

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** One pending code carrying the printer fields (only valid before 0080 / after its down). */
async function insertWithPrinter(vendor: string | null, product: string | null, comPort: string | null): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(
    `INSERT INTO pairing_codes
       (id, tenant_id, store_id, code_hash, terminal_label, branch_name, branch_address,
        tenant_tax_registration_id, printer_vendor_id, printer_product_id, printer_com_port,
        status, expires_at)
     VALUES ($1, $2, $3, decode($4, 'hex'), 'Counter 1', 'Branch', 'Addr', '123456789', $5, $6, $7,
             'pending', now() + interval '10 minutes')`,
    [id, TENANT, STORE, randomUUID().replace(/-/g, "").padEnd(64, "0"), vendor, product, comPort],
  );
  return id;
}

/** One pending code without any printer field (the shape after 0080). */
async function insertPlain(): Promise<string> {
  const id = randomUUID();
  await pg().admin.query(
    `INSERT INTO pairing_codes
       (id, tenant_id, store_id, code_hash, terminal_label, branch_name, branch_address,
        tenant_tax_registration_id, status, expires_at)
     VALUES ($1, $2, $3, decode($4, 'hex'), 'Counter 2', 'Branch', 'Addr', '123456789',
             'pending', now() + interval '10 minutes')`,
    [id, TENANT, STORE, randomUUID().replace(/-/g, "").padEnd(64, "0")],
  );
  return id;
}

/** The SQLSTATE the statement fails with, or null. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function printerColumns(): Promise<Record<string, string>> {
  const r = await pg().admin.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pairing_codes' AND column_name LIKE 'printer\\_%'
      ORDER BY column_name`,
  );
  return Object.fromEntries(r.rows.map((row) => [row.column_name, row.is_nullable]));
}

async function printerChecks(): Promise<string[]> {
  const r = await pg().admin.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'pairing_codes'::regclass AND conname LIKE 'pairing_codes\\_printer\\_%'
      ORDER BY conname`,
  );
  return r.rows.map((row) => row.conname);
}

/** The columns and constraints that must be untouched by 0080 (everything but the printer ones). */
async function otherShape(): Promise<{ columns: string[]; checks: string[]; forceRls: boolean }> {
  const cols = await pg().admin.query<{ column_name: string; is_nullable: string; data_type: string }>(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pairing_codes' AND column_name NOT LIKE 'printer\\_%'
      ORDER BY column_name`,
  );
  const checks = await pg().admin.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'pairing_codes'::regclass AND conname NOT LIKE 'pairing_codes\\_printer\\_%'
      ORDER BY conname`,
  );
  const rls = await pg().admin.query<{ f: boolean }>(
    `SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'pairing_codes'::regclass`,
  );
  return {
    columns: cols.rows.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`),
    checks: checks.rows.map((c) => c.conname),
    forceRls: rls.rows[0]!.f,
  };
}

async function rowCount(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pairing_codes`);
  return Number(r.rows[0]!.n);
}

async function labelOf(id: string): Promise<string> {
  const r = await pg().admin.query<{ terminal_label: string }>(
    `SELECT terminal_label FROM pairing_codes WHERE id = $1`,
    [id],
  );
  return r.rows[0]!.terminal_label;
}

let seededA = "";
let seededB = "";
let shapeBefore: Awaited<ReturnType<typeof otherShape>>;

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0080 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1184-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  seededA = await insertWithPrinter("0x04B8", "0x0202", null);
  seededB = await insertWithPrinter(null, null, "COM3");
  shapeBefore = await otherShape();
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0080 before", () => {
  it("has the three printer columns (all nullable after 0079) and their three CHECKs", async () => {
    if (skip()) return;
    expect(Object.keys(await printerColumns())).toEqual(PRINTER_COLUMNS);
    expect(await printerColumns()).toEqual({
      printer_com_port: "YES",
      printer_product_id: "YES",
      printer_vendor_id: "YES",
    });
    expect(await printerChecks()).toEqual(PRINTER_CHECKS);
  });
});

describe("0080 up", () => {
  it("drops the three columns and their CHECKs, and nothing else", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await printerColumns()).toEqual({});
    expect(await printerChecks()).toEqual([]);
    expect(await otherShape()).toEqual(shapeBefore);
  });

  it("keeps every row, and stores a code without printer fields", async () => {
    if (skip()) return;
    expect(await rowCount()).toBe(2);
    expect(await labelOf(seededA)).toBe("Counter 1");
    expect(await labelOf(seededB)).toBe("Counter 1");
    expect(await labelOf(await insertPlain())).toBe("Counter 2");
  });

  it("refuses an insert that still names a printer column (42703)", async () => {
    if (skip()) return;
    expect(await codeOf(() => insertWithPrinter("0x04B8", "0x0202", null))).toBe("42703");
  });

  it("is idempotent in effect: a second apply changes nothing", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await printerColumns()).toEqual({});
    expect(await otherShape()).toEqual(shapeBefore);
  });
});

describe("0080 down", () => {
  it("restores the three columns nullable and their CHECKs, EMPTY: the dropped values are gone", async () => {
    if (skip()) return;
    await pg().admin.query(DOWN_SQL());
    expect(await printerColumns()).toEqual({
      printer_com_port: "YES",
      printer_product_id: "YES",
      printer_vendor_id: "YES",
    });
    expect(await printerChecks()).toEqual(PRINTER_CHECKS);
    expect(await otherShape()).toEqual(shapeBefore);
    const r = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pairing_codes
        WHERE printer_vendor_id IS NOT NULL OR printer_product_id IS NOT NULL OR printer_com_port IS NOT NULL`,
    );
    expect(r.rows[0]!.n).toBe("0");
    expect(await rowCount()).toBe(3);
  });

  it("keeps the restored CHECKs working for non-NULL values", async () => {
    if (skip()) return;
    expect(await codeOf(() => insertWithPrinter("04B8", null, null))).toBe("23514");
    expect(await codeOf(() => insertWithPrinter(null, "0xZZZZ", null))).toBe("23514");
    expect(await codeOf(() => insertWithPrinter(null, null, "   "))).toBe("23514");
    expect(await codeOf(() => insertWithPrinter("0x04B8", "0x0202", "COM3"))).toBeNull();
  });

  it("round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await printerColumns()).toEqual({});
    expect(await printerChecks()).toEqual([]);
    expect(await otherShape()).toEqual(shapeBefore);
    await pg().admin.query(DOWN_SQL());
    expect(Object.keys(await printerColumns())).toEqual(PRINTER_COLUMNS);
  });
});
