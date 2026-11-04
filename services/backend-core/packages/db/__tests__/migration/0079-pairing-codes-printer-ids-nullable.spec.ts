/**
 * 0079 — the printer USB ids of a pairing code become optional (Jira RT-1181,
 * RT-1165 slice S1, the expand step; [GATED] migration).
 *
 * Applies every migration before 0079 against a real Postgres, seeds pairing
 * codes that carry the printer ids, applies 0079 exactly as the runner does (one
 * `query()` for the file), and proves:
 *   - before it, NULL printer ids are refused (23502);
 *   - every existing row survives with its stored ids, unchanged;
 *   - the two columns accept NULL, and a row with no printer fields is stored;
 *   - the hex CHECKs stay: a non-NULL value that is not 0xHHHH is still refused
 *     (23514), a valid one is accepted;
 *   - the change did not rewrite the table (same relfilenode);
 *   - down refuses while a row holds NULL (23502), and restores NOT NULL once none
 *     does, keeping every row and round-tripping with up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0079_pairing_codes_printer_ids_nullable.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string =>
  readFileSync(resolve(DRIZZLE_DIR, "0079_pairing_codes_printer_ids_nullable.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000118101";
const STORE = "0a000000-0000-7000-8000-000000118102";

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** One pending code; `vendor` / `product` are bound as given (null = NULL). */
async function insertCode(vendor: string | null, product: string | null, comPort: string | null = null): Promise<string> {
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

/** The SQLSTATE the statement fails with, or null. */
async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function nullable(): Promise<Record<string, string>> {
  const r = await pg().admin.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pairing_codes'
        AND column_name IN ('printer_vendor_id', 'printer_product_id', 'printer_com_port')`,
  );
  return Object.fromEntries(r.rows.map((row) => [row.column_name, row.is_nullable]));
}

async function printerRow(id: string): Promise<{ v: string | null; p: string | null; c: string | null }> {
  const r = await pg().admin.query<{ v: string | null; p: string | null; c: string | null }>(
    `SELECT printer_vendor_id AS v, printer_product_id AS p, printer_com_port AS c FROM pairing_codes WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

async function validatedHexChecks(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_constraint
      WHERE conname IN ('pairing_codes_printer_vendor_id_hex', 'pairing_codes_printer_product_id_hex')
        AND convalidated`,
  );
  return Number(r.rows[0]!.n);
}

async function relfilenode(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT relfilenode::text AS n FROM pg_class WHERE oid = 'pairing_codes'::regclass`,
  );
  return r.rows[0]!.n;
}

let oldWithAll = "";
let oldWithCom = "";
let relBefore = "";

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0079 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1181-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  oldWithAll = await insertCode("0x04B8", "0x0202");
  oldWithCom = await insertCode("0x04b8", "0x0e15", "COM3");
  relBefore = await relfilenode();
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0079 before", () => {
  it("refuses a code without the printer ids (23502)", async () => {
    if (skip()) return;
    expect(await nullable()).toMatchObject({ printer_vendor_id: "NO", printer_product_id: "NO", printer_com_port: "YES" });
    expect(await codeOf(() => insertCode(null, null))).toBe("23502");
  });
});

describe("0079 up", () => {
  it("drops NOT NULL on the two ids without rewriting the table; the hex CHECKs stay validated", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await nullable()).toEqual({
      printer_vendor_id: "YES",
      printer_product_id: "YES",
      printer_com_port: "YES",
    });
    expect(await validatedHexChecks()).toBe(2);
    expect(await relfilenode()).toBe(relBefore);
  });

  it("leaves every existing row unchanged", async () => {
    if (skip()) return;
    expect(await printerRow(oldWithAll)).toEqual({ v: "0x04B8", p: "0x0202", c: null });
    expect(await printerRow(oldWithCom)).toEqual({ v: "0x04b8", p: "0x0e15", c: "COM3" });
  });

  it("stores a code without the printer fields as NULLs, and with only one id", async () => {
    if (skip()) return;
    expect(await printerRow(await insertCode(null, null))).toEqual({ v: null, p: null, c: null });
    expect(await printerRow(await insertCode("0x04B8", null))).toEqual({ v: "0x04B8", p: null, c: null });
    expect(await printerRow(await insertCode(null, "0x0202"))).toEqual({ v: null, p: "0x0202", c: null });
  });

  it("keeps the hex CHECKs for non-NULL values (23514), and accepts valid ones", async () => {
    if (skip()) return;
    expect(await codeOf(() => insertCode("04B8", null))).toBe("23514");
    expect(await codeOf(() => insertCode(null, "0xZZZZ"))).toBe("23514");
    expect(await codeOf(() => insertCode("0x04B8", "0x0202"))).toBeNull();
    expect(await codeOf(() => insertCode("0xABCD", "0xef01"))).toBeNull();
  });

  it("is idempotent in effect: a second apply changes nothing", async () => {
    if (skip()) return;
    await pg().admin.query(UP_SQL());
    expect(await nullable()).toMatchObject({ printer_vendor_id: "YES", printer_product_id: "YES" });
  });
});

describe("0079 down", () => {
  it("refuses while a row holds NULL (23502) and changes nothing", async () => {
    if (skip()) return;
    expect(await codeOf(() => pg().admin.query(DOWN_SQL()))).toBe("23502");
    expect(await nullable()).toMatchObject({ printer_vendor_id: "YES", printer_product_id: "YES" });
  });

  it("restores NOT NULL once no row holds NULL, keeps every row, and round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(
      `DELETE FROM pairing_codes WHERE printer_vendor_id IS NULL OR printer_product_id IS NULL`,
    );
    await pg().admin.query(DOWN_SQL());
    expect(await nullable()).toMatchObject({ printer_vendor_id: "NO", printer_product_id: "NO", printer_com_port: "YES" });
    expect(await printerRow(oldWithAll)).toEqual({ v: "0x04B8", p: "0x0202", c: null });
    expect(await printerRow(oldWithCom)).toEqual({ v: "0x04b8", p: "0x0e15", c: "COM3" });
    expect(await codeOf(() => insertCode(null, null))).toBe("23502");

    await pg().admin.query(UP_SQL());
    expect(await nullable()).toMatchObject({ printer_vendor_id: "YES", printer_product_id: "YES" });
    expect(await printerRow(await insertCode(null, null))).toEqual({ v: null, p: null, c: null });
  });
});
