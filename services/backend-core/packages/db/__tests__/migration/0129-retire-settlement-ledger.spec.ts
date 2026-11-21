/**
 * RT-422: `0129_retire_settlement_ledger` migration test, on a real PostgreSQL 16 (Testcontainers),
 * applied on top of every earlier migration, run as a NOSUPERUSER migration owner under FORCE RLS
 * (session tenant GUC pre-set to ''), like the production migrate role:
 *   - a plain count as that owner reads 0 although a row exists, which is why the guard walks the tenants;
 *   - a single row of ANY of the six tables, in a tenant that is not the first, makes the migration refuse
 *     (check_violation naming the table and the count, never row data) and every table survives;
 *   - with the six tables empty the migration drops them and keeps `payer_account` and the tables that
 *     reference it (`sale_responsibilities`, `sale_credit_reversals`) with their foreign keys;
 *   - DOWN recreates the six tables empty with their ENABLE + FORCE RLS and policies, and the up applies again.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 * Even with the opt-in only "no container runtime" skips; any other setup failure is rethrown
 * (`startPgEnvOrSkip`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asMigrationOwner, startPgEnvOrSkip } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP = "0129_retire_settlement_ledger.sql";
const DOWN = "0129_retire_settlement_ledger.down.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");

const id = (n: string): string => `01290000-0000-7000-8000-0000000${n}`;
const TENANTS = [id("0a001"), id("0b001"), id("0c001")] as const;
const LAST_TENANT = TENANTS[2];
const OWNER_ROLE = "rt422_mig_owner";

/** The six dropped tables, children first (the order the migration drops them in). */
const RETIRED = ["reconciliation_result", "remittance", "claim_receivables", "payment_application", "claim", "receivable"];
const KEPT = ["payer_account", "sale_responsibilities", "sale_credit_reversals"];

/** One minimal row per retired table; the foreign keys are off while fixtures are written. */
const SEED: Record<string, string> = {
  receivable: `INSERT INTO receivable (tenant_id, store_id, sale_id, payer_id, outstanding_balance)
               VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 10)`,
  payment_application: `INSERT INTO payment_application (tenant_id, store_id, receivable_id, applied_amount)
                        VALUES ($1, gen_random_uuid(), gen_random_uuid(), 5)`,
  claim: `INSERT INTO claim (tenant_id, store_id, payer_id) VALUES ($1, gen_random_uuid(), gen_random_uuid())`,
  claim_receivables: `INSERT INTO claim_receivables (tenant_id, store_id, claim_id, receivable_id)
                      VALUES ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
  remittance: `INSERT INTO remittance (tenant_id, store_id, claim_id, remitted_amount)
               VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1)`,
  reconciliation_result: `INSERT INTO reconciliation_result (tenant_id, store_id, claim_id, claimed_amount, remitted_amount, variance, outcome)
                          VALUES ($1, gen_random_uuid(), gen_random_uuid(), 2, 1, 1, 'partial')`,
};

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function count(query: string, params: unknown[] = []): Promise<number> {
  const r = await guard().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${query}) q`, params);
  return Number(r.rows[0]!.n);
}

const existingTables = (names: readonly string[]): Promise<number> =>
  count(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [
    [...names],
  ]);

async function seedRow(table: string): Promise<void> {
  const c = await guard().admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(SEED[table]!, [LAST_TENANT]);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/** Run `fileSql` as the migration owner with the session tenant GUC pre-set to ''; null on success. */
async function runAsOwner(fileSql: string): Promise<{ code: string | undefined; message: string } | null> {
  const c = await guard().admin.connect();
  try {
    await c.query(`SET ROLE ${OWNER_ROLE}`);
    await c.query("SELECT set_config('app.current_tenant', '', false)");
    await c.query(fileSql);
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.query("RESET ROLE").catch(() => undefined);
    c.release();
  }
}

const owner = (): { role: string; tables: readonly string[]; functions: readonly string[] } => ({
  role: OWNER_ROLE,
  tables: ["tenants", ...RETIRED, ...KEPT],
  functions: [],
});

beforeAll(async () => {
  const started = await startPgEnvOrSkip(startPgEnv, process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1");
  if (started.env === null) {
    dockerSkipReason = started.skipReason;
    return;
  }
  env = started.env;
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP);
  await env.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
     VALUES ($1, 'rt422-a', 'RT422 A', 'EGP'), ($2, 'rt422-b', 'RT422 B', 'EGP'), ($3, 'rt422-c', 'RT422 C', 'EGP')`,
    [...TENANTS],
  );
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("RT-422 0129 pre-drop guard, as the NOSUPERUSER owner under FORCE RLS", () => {
  it("(setup) all six tables exist before the migration, and a plain count as the owner reads 0 over a row", async () => {
    if (skip()) return;
    expect(await existingTables(RETIRED)).toBe(6);
    await seedRow("claim");
    expect(await count(`SELECT 1 FROM claim`)).toBe(1);
    await asMigrationOwner(guard(), owner(), async () => {
      const c = await guard().admin.connect();
      try {
        await c.query(`SET ROLE ${OWNER_ROLE}`);
        await c.query("SELECT set_config('app.current_tenant', '', false)");
        const plain = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM claim`);
        expect(plain.rows[0]!.n).toBe("0");
      } finally {
        await c.query("RESET ROLE").catch(() => undefined);
        c.release();
      }
    });
    await guard().admin.query(`DELETE FROM claim`);
    expect(await count(`SELECT 1 FROM claim`)).toBe(0);
  });

  for (const table of RETIRED) {
    it(`refuses and changes nothing while ${table} holds one row of the last tenant`, async () => {
      if (skip()) return;
      await seedRow(table);
      const failure = await asMigrationOwner(guard(), owner(), () => runAsOwner(sql(UP)));
      expect(failure?.code).toBe("23514");
      expect(failure?.message).toContain("RT-422");
      expect(failure?.message).toContain(table);
      expect(failure?.message).toContain("1 row(s)");
      expect(await existingTables(RETIRED)).toBe(6);
      expect(await existingTables(KEPT)).toBe(3);
      await guard().admin.query(`DELETE FROM ${table}`);
    });
  }
});

describe("RT-422 0129 drop, down and re-up", () => {
  it("with the six tables empty it drops them and keeps the payer facade and its foreign keys", async () => {
    if (skip()) return;
    const failure = await asMigrationOwner(guard(), owner(), () => runAsOwner(sql(UP)));
    expect(failure).toBeNull();
    expect(await existingTables(RETIRED)).toBe(0);
    expect(await existingTables(KEPT)).toBe(3);
    expect(
      await count(
        `SELECT 1 FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'payer_account'::regclass
            AND conrelid IN ('sale_responsibilities'::regclass, 'sale_credit_reversals'::regclass)`,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("DOWN recreates the six tables empty, with FORCE RLS and every policy", async () => {
    if (skip()) return;
    await guard().admin.query(sql(DOWN));
    expect(await existingTables(RETIRED)).toBe(6);
    for (const table of RETIRED) expect(await count(`SELECT 1 FROM ${table}`)).toBe(0);
    expect(
      await count(
        `SELECT 1 FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity`,
        [RETIRED],
      ),
    ).toBe(6);
    expect(await count(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])`, [RETIRED])).toBe(14);
    expect(await existingTables(KEPT)).toBe(3);
  });

  it("the up applies again over the recreated empty tables", async () => {
    if (skip()) return;
    await guard().admin.query(sql(UP));
    expect(await existingTables(RETIRED)).toBe(0);
    expect(await existingTables(KEPT)).toBe(3);
  });
});
