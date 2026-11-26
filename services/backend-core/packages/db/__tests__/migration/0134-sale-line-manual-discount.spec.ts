/**
 * RT-1571 (RT-285 F-7, RT-740 lineage): `0134_sale_line_manual_discount` ([GATED: migration]) on a real
 * PostgreSQL 16 (Testcontainers), applied on top of every earlier migration.
 *
 * Proves:
 *   - BEFORE 0134: none of the seven columns exist;
 *   - UP: a line recorded before the migration keeps no discount ("not recorded"); a line without a discount
 *     is stored as before; a whole percent or amount discount is stored, with or without the approver's user
 *     id, and reads back as written; a partial discount, an approver id without a discount, a value outside
 *     the contract's vocabularies and a magnitude that breaks its kind's rule are refused by name; the three
 *     CHECKs are NOT VALID (no scan of the hot sale_lines table under the lock); there is no foreign key on
 *     the approver's id (an unverified till claim);
 *   - DOWN, as a NOSUPERUSER migration owner under FORCE RLS: refuses while any line carries a recorded
 *     discount, in any tenant (sale_lines has tenant-only policies, so the guard reads tenant by tenant under
 *     each one's GUC, never lifting FORCE), and once they are cleared it drops every column; FORCE RLS stays
 *     on; the up re-applies cleanly.
 *
 * Fixtures are inserted on one superuser connection with `session_replication_role = replica` (foreign keys
 * and triggers off; CHECK constraints still apply), so no store, user or sale rows are needed; tenant rows
 * are, because the down guard lists the tenants.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asMigrationOwner, startPgEnvOrSkip } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP = "0134_sale_line_manual_discount.sql";
const DOWN = "0134_sale_line_manual_discount.down.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
const OWNER_ROLE = "rt1571_mig_owner";
const TENANT_A = "0a000000-0000-7000-8000-000000157111";
const TENANT_B = "0b000000-0000-7000-8000-000000157112";

const COLUMNS = [
  "discount_kind",
  "discount_value",
  "discount_amount",
  "discount_reason_code",
  "discount_authority_source",
  "discount_approver_role",
  "discount_approver_user_id",
] as const;

let env: PgTestEnv | null = null;
const skip = (): boolean => env === null;
function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

/** The constraint violated by `fn` (or the error code), or null when it succeeded. */
async function violated(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { constraint?: string; code?: string };
    return e.constraint ?? e.code ?? "unknown";
  }
}

/** Run `fn` on one superuser connection with triggers and FKs off (fixtures only), committed. */
async function fixture<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pg().admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

type Discount = Partial<Record<(typeof COLUMNS)[number], string | null>>;

const PERCENT: Discount = {
  discount_kind: "percent",
  discount_value: "10",
  discount_amount: "9.00",
  discount_reason_code: "promotion",
  discount_authority_source: "cashier_approval",
  discount_approver_role: "manager",
};
const AMOUNT: Discount = {
  discount_kind: "amount",
  discount_value: "5.00",
  discount_amount: "5.00",
  discount_reason_code: "price_correction",
  discount_authority_source: "manager_session",
  discount_approver_role: "admin",
};

/** A sale line (no parent sale: FKs are off), with the given discount columns (none = the pre-0134 shape). */
async function insertLine(discount: Discount | undefined, tenantId: string = TENANT_A): Promise<string> {
  const id = randomUUID();
  const keys = Object.keys(discount ?? {}) as Array<keyof Discount>;
  const cols = keys.map((k) => `, ${k}`).join("");
  const vals = keys.map((_k, i) => `, $${i + 5}`).join("");
  const params: unknown[] = [id, randomUUID(), tenantId, randomUUID(), ...keys.map((k) => discount![k])];
  await fixture((c) =>
    c.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, unit${cols})
       VALUES ($1, $2, $3, $4, 'Widget', 45, 'EGP', 2, 81, 'ea'${vals})`,
      params,
    ),
  );
  return id;
}

async function columnCount(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sale_lines' AND column_name = ANY($1::text[])`,
    [COLUMNS],
  );
  return Number(r.rows[0]!.n);
}

async function forcedRls(): Promise<boolean> {
  const r = await pg().admin.query<{ forced: boolean }>(
    `SELECT relforcerowsecurity AS forced FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = 'sale_lines'`,
  );
  return r.rows[0]!.forced;
}

/** Run a migration file as the NOSUPERUSER owner of the tables, tenant GUC pre-set to ''. */
async function runAsOwner(file: string): Promise<{ code: string | null; message: string }> {
  const owner = { role: OWNER_ROLE, tables: ["tenants", "sale_lines"], functions: [] };
  return asMigrationOwner(pg(), owner, async () => {
    const c = await pg().admin.connect();
    try {
      await c.query(`SET ROLE ${OWNER_ROLE}`);
      await c.query(`SELECT set_config('app.current_tenant', '', false)`);
      await c.query(sql(file));
      return { code: null, message: "" };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query("RESET app.current_tenant").catch(() => undefined);
      c.release();
    }
  });
}

/** Clear every recorded discount (fixtures; triggers and FKs off). */
async function clearDiscounts(): Promise<void> {
  await fixture((c) => c.query(`UPDATE sale_lines SET ${COLUMNS.map((k) => `${k} = NULL`).join(", ")}`));
}

let preExistingLine = "";

beforeAll(async () => {
  const started = await startPgEnvOrSkip(startPgEnv, process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1");
  if (started.env === null) {
    // eslint-disable-next-line no-console
    console.warn(`\n[0134-sale-line-manual-discount.spec] Docker NOT AVAILABLE — skipping: ${started.skipReason}\n`);
    return;
  }
  env = started.env;
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP);
  await fixture((c) =>
    c.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'rt1571-a', 'RT1571 A', 'EGP'), ($2, 'rt1571-b', 'RT1571 B', 'EGP')`,
      [TENANT_A, TENANT_B],
    ),
  );
  preExistingLine = await insertLine(undefined);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0134 — before the migration", () => {
  it("has none of the seven columns", async () => {
    if (skip()) return;
    expect(await columnCount()).toBe(0);
  });
});

describe("0134 — up", () => {
  beforeAll(async () => {
    if (skip()) return;
    await pg().admin.query(sql(UP));
  });

  it("adds the seven columns", async () => {
    if (skip()) return;
    expect(await columnCount()).toBe(7);
  });

  it("keeps a line recorded before the migration, with no discount (not recorded)", async () => {
    if (skip()) return;
    const r = await pg().admin.query(`SELECT discount_kind, discount_amount FROM sale_lines WHERE id = $1`, [
      preExistingLine,
    ]);
    expect(r.rows).toEqual([{ discount_kind: null, discount_amount: null }]);
  });

  it("stores a line without a discount and whole percent and amount discounts, with and without the approver id", async () => {
    if (skip()) return;
    expect(await violated(() => insertLine(undefined))).toBeNull();
    expect(await violated(() => insertLine(PERCENT))).toBeNull();
    const approver = randomUUID();
    const id = await insertLine({ ...AMOUNT, discount_approver_user_id: approver }, TENANT_B);
    const r = await pg().admin.query(
      `SELECT discount_kind, discount_value::text AS v, discount_amount::text AS a, discount_reason_code,
              discount_authority_source, discount_approver_role, discount_approver_user_id::text AS u
         FROM sale_lines WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({
      discount_kind: "amount",
      v: "5.0000",
      a: "5.0000",
      discount_reason_code: "price_correction",
      discount_authority_source: "manager_session",
      discount_approver_role: "admin",
      u: approver,
    });
  });

  it.each(
    [
      ...COLUMNS.filter((k) => k !== "discount_approver_user_id").map(
        (k) => [`without ${k}`, { ...PERCENT, [k]: null }] as const,
      ),
      ["an approver id without a discount", { discount_approver_user_id: randomUUID() }] as const,
      ["only a reason code", { discount_reason_code: "promotion" }] as const,
    ],
  )("refuses a partial discount (%s)", async (_label, discount) => {
    if (skip()) return;
    expect(await violated(() => insertLine(discount))).toBe("sale_lines_discount_whole");
  });

  it.each([
    ["an unknown kind", { ...PERCENT, discount_kind: "fixed" }],
    ["a free-text reason", { ...PERCENT, discount_reason_code: "customer is a friend" }],
    ["an unknown authority source", { ...PERCENT, discount_authority_source: "self" }],
    ["a cashier approver role", { ...PERCENT, discount_approver_role: "cashier" }],
  ])("refuses %s", async (_label, discount) => {
    if (skip()) return;
    expect(await violated(() => insertLine(discount))).toBe("sale_lines_discount_vocabulary");
  });

  it.each([
    ["a fractional percent", { ...PERCENT, discount_value: "10.5" }],
    ["a percent over 100", { ...PERCENT, discount_value: "101" }],
    ["a zero value", { ...PERCENT, discount_value: "0" }],
    ["a negative amount", { ...PERCENT, discount_amount: "-1" }],
    ["an amount discount whose value differs from its amount", { ...AMOUNT, discount_value: "4.00" }],
    ["a NaN amount", { ...PERCENT, discount_amount: "NaN" }],
    ["a NaN value", { ...AMOUNT, discount_value: "NaN", discount_amount: "NaN" }],
  ])("refuses %s", async (_label, discount) => {
    if (skip()) return;
    expect(await violated(() => insertLine(discount))).toBe("sale_lines_discount_magnitude");
  });

  it("accepts the edges: 100% (a free line), a percent rounding to an amount of 0", async () => {
    if (skip()) return;
    expect(await violated(() => insertLine({ ...PERCENT, discount_value: "100", discount_amount: "90.00" }))).toBeNull();
    expect(await violated(() => insertLine({ ...PERCENT, discount_value: "1", discount_amount: "0" }))).toBeNull();
  });

  it("adds the three CHECKs NOT VALID and no foreign key on the approver id", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ conname: string; validated: boolean }>(
      `SELECT conname, convalidated AS validated FROM pg_constraint
        WHERE conrelid = 'public.sale_lines'::regclass AND conname LIKE 'sale_lines_discount_%'
        ORDER BY conname`,
    );
    expect(r.rows).toEqual([
      { conname: "sale_lines_discount_magnitude", validated: false },
      { conname: "sale_lines_discount_vocabulary", validated: false },
      { conname: "sale_lines_discount_whole", validated: false },
    ]);
    const fks = await pg().admin.query(
      `SELECT 1 FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'public.sale_lines'::regclass AND c.contype = 'f' AND a.attname = 'discount_approver_user_id'`,
    );
    expect(fks.rowCount).toBe(0);
  });
});

describe("0134 — down, as the NOSUPERUSER migration owner under FORCE RLS", () => {
  it("refuses while a discount is recorded, and changes nothing", async () => {
    if (skip()) return;
    const refused = await runAsOwner(DOWN);
    expect(refused.code).toBe("P0001");
    expect(refused.message).toContain("0134 down refused");
    expect(await columnCount()).toBe(7);
    expect(await forcedRls()).toBe(true);
  });

  it("refuses with a single discount recorded in one tenant only", async () => {
    if (skip()) return;
    await clearDiscounts();
    await insertLine(AMOUNT, TENANT_B);
    const refused = await runAsOwner(DOWN);
    expect(refused.code).toBe("P0001");
    expect(refused.message).toContain("0134 down refused: 1 sale line(s)");
    expect(await columnCount()).toBe(7);
  });

  it("drops every column once the discounts are cleared, and the up re-applies", async () => {
    if (skip()) return;
    await clearDiscounts();
    expect((await runAsOwner(DOWN)).code).toBeNull();
    expect(await columnCount()).toBe(0);
    expect(await forcedRls()).toBe(true);
    expect((await runAsOwner(DOWN)).code).toBeNull();

    await pg().admin.query(sql(UP));
    expect(await columnCount()).toBe(7);
    expect(await violated(() => insertLine(PERCENT))).toBeNull();
  });
});
