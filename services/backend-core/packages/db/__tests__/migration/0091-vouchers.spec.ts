/**
 * RT-1107: `0091_vouchers` migration test (voucher issuance slice I-2 of
 * RT-1098; owner authorization RT-1098 comment 16496).
 *
 * Validates `packages/db/drizzle/0091_vouchers.sql` (+ `.down.sql`):
 *   - FORCE RLS and the exact policy set: `vouchers` SELECT + INSERT + UPDATE,
 *     `voucher_eligible_stores` SELECT + INSERT, no DELETE policy on either;
 *   - the CHECKs: status set, positive amount, currency shape, the cancel
 *     columns set together and only for a cancelled voucher, note length, and
 *     a nullable `expires_at`;
 *   - UNIQUE (tenant_id, code_hash);
 *   - the composite FKs (AC1): an eligible-store row whose voucher or store
 *     belongs to another tenant, or does not exist, is refused;
 *   - tenant isolation (AC2): the app role reads only its own tenant, an empty
 *     tenant GUC sees nothing, an INSERT for another tenant is refused, the
 *     app role may UPDATE its own voucher (cancel) but never DELETE it, and
 *     eligible stores are append-only;
 *   - UP -> DOWN -> UP (AC3), also as a NOSUPERUSER migration owner under FORCE
 *     RLS, and the down REFUSES while a voucher exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0091_vouchers.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0091_vouchers.down.sql");

const id = (n: string): string => `09100000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_B = id("0b011");
const ACTOR = id("0a0a1");
const BATCH = id("0a0b1");
const VOUCHER_A = id("0a0c1");
const VOUCHER_B = id("0b0c1");
const MISSING_VOUCHER = id("0a0c9");

const V = "vouchers";
const E = "voucher_eligible_stores";

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
      console.warn(`\n[0091-vouchers.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'vch-a', 'VCH A', 'USD'), ($2, 'vch-b', 'VCH B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A1', 'Store A1'), ($2, $4, 'B1', 'Store B1')`,
    [STORE_A, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(upSql);
  // The app role's table grants are taken after the tables exist.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface VoucherRow {
  id: string;
  tenant_id: string;
  batch_id: string;
  code_hash: Buffer;
  amount_minor: number;
  currency_code: string;
  status: string;
  expires_at: string | null;
  applies_to_all_stores: boolean;
  issued_by_user_id: string;
  cancelled_by_user_id: string | null;
  cancelled_at: string | null;
  note: string | null;
}

const hash = (hex: string): Buffer => Buffer.from(hex.repeat(32).slice(0, 64), "hex");

const ACTIVE: VoucherRow = {
  id: VOUCHER_A,
  tenant_id: TENANT_A,
  batch_id: BATCH,
  code_hash: hash("a1"),
  amount_minor: 5000,
  currency_code: "USD",
  status: "active",
  expires_at: "2099-01-01T00:00:00Z",
  applies_to_all_stores: false,
  issued_by_user_id: ACTOR,
  cancelled_by_user_id: null,
  cancelled_at: null,
  note: null,
};
const ACTIVE_B: VoucherRow = { ...ACTIVE, id: VOUCHER_B, tenant_id: TENANT_B, code_hash: hash("b1") };

const COLUMNS = Object.keys(ACTIVE) as (keyof VoucherRow)[];
const INSERT_V = `INSERT INTO ${V} (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;
const valuesOf = (row: VoucherRow): unknown[] => COLUMNS.map((c) => row[c]);
const INSERT_E = `INSERT INTO ${E} (tenant_id, voucher_id, store_id) VALUES ($1, $2, $3)`;

/** Run one statement as the superuser inside a rolled-back transaction; returns the error code or null. */
async function tryRun(sql: string, params: unknown[]): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Insert voucher A (active, one store) as the superuser; the caller deletes it. */
async function seedVoucherA(): Promise<void> {
  await guard().admin.query(INSERT_V, valuesOf(ACTIVE));
  await guard().admin.query(INSERT_E, [TENANT_A, VOUCHER_A, STORE_A]);
}
async function clearVouchers(): Promise<void> {
  await guard().admin.query(`DELETE FROM ${E}`);
  await guard().admin.query(`DELETE FROM ${V}`);
}

describe("0091: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0091: RLS and policies", () => {
  it("forces RLS on both tables with the exact policy set", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid IN (to_regclass($1), to_regclass($2)) ORDER BY relname`,
      [V, E],
    );
    expect(rls.rows).toEqual([
      { relname: E, relrowsecurity: true, relforcerowsecurity: true },
      { relname: V, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await guard().admin.query<{ tablename: string; policyname: string; cmd: string }>(
      `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ($1, $2) ORDER BY tablename, policyname`,
      [V, E],
    );
    expect(policies.rows).toEqual([
      { tablename: E, policyname: "voucher_eligible_stores_tenant_insert", cmd: "INSERT" },
      { tablename: E, policyname: "voucher_eligible_stores_tenant_select", cmd: "SELECT" },
      { tablename: V, policyname: "vouchers_tenant_insert", cmd: "INSERT" },
      { tablename: V, policyname: "vouchers_tenant_select", cmd: "SELECT" },
      { tablename: V, policyname: "vouchers_tenant_update", cmd: "UPDATE" },
    ]);
  });
});

describe("0091: vouchers constraints", () => {
  it("stores an active voucher, a never-expiring one and a cancelled one", async () => {
    if (skip()) return;
    expect(await tryRun(INSERT_V, valuesOf(ACTIVE))).toBeNull();
    expect(await tryRun(INSERT_V, valuesOf({ ...ACTIVE, expires_at: null }))).toBeNull();
    expect(
      await tryRun(
        INSERT_V,
        valuesOf({ ...ACTIVE, status: "cancelled", cancelled_by_user_id: ACTOR, cancelled_at: "2026-11-11T00:00:00Z", note: "x" }),
      ),
    ).toBeNull();
    expect(await tryRun(INSERT_V, valuesOf({ ...ACTIVE, status: "redeemed" }))).toBeNull();
  });

  it.each<[string, Partial<VoucherRow>]>([
    ["an unknown status (expired is derived, never stored)", { status: "expired" }],
    ["a zero amount", { amount_minor: 0 }],
    ["a negative amount", { amount_minor: -1 }],
    ["a lower-case currency", { currency_code: "usd" }],
    ["a cancelled voucher without its cancel columns", { status: "cancelled" }],
    ["cancel columns on an active voucher", { cancelled_by_user_id: ACTOR, cancelled_at: "2026-11-11T00:00:00Z" }],
    ["a cancelled voucher without who cancelled it", { status: "cancelled", cancelled_at: "2026-11-11T00:00:00Z" }],
    ["a cancelled voucher without when", { status: "cancelled", cancelled_by_user_id: ACTOR }],
    ["an empty note", { note: "" }],
    ["a 201-character note", { note: "n".repeat(201) }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await tryRun(INSERT_V, valuesOf({ ...ACTIVE, ...change }))).toBe("23514");
  });

  it("refuses a missing tenant (23503) and a missing required column (23502)", async () => {
    if (skip()) return;
    expect(await tryRun(INSERT_V, valuesOf({ ...ACTIVE, tenant_id: id("0f001") }))).toBe("23503");
    expect(await tryRun(INSERT_V, valuesOf({ ...ACTIVE, code_hash: null as unknown as Buffer }))).toBe("23502");
  });

  it("enforces UNIQUE (tenant_id, code_hash): a duplicate hash in one tenant is refused, in another tenant is allowed", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(INSERT_V, valuesOf(ACTIVE));
      await client.query("SAVEPOINT dup");
      await expect(client.query(INSERT_V, valuesOf({ ...ACTIVE, id: id("0a0c2") }))).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT dup");
      // The same hash for another tenant is a different voucher.
      await client.query(INSERT_V, valuesOf({ ...ACTIVE_B, code_hash: ACTIVE.code_hash }));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("0091: voucher_eligible_stores composite FKs (AC1)", () => {
  it("accepts a same-tenant voucher and store", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(INSERT_V, valuesOf(ACTIVE));
      await client.query(INSERT_E, [TENANT_A, VOUCHER_A, STORE_A]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("refuses another tenant's voucher_id, a missing voucher and another tenant's store_id (23503), and a duplicate (23505)", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(INSERT_V, valuesOf(ACTIVE));
      await client.query(INSERT_V, valuesOf(ACTIVE_B));
      const attempt = async (params: unknown[]): Promise<string | null> => {
        await client.query("SAVEPOINT s");
        try {
          await client.query(INSERT_E, params);
          return null;
        } catch (err) {
          return (err as { code?: string }).code ?? "unknown";
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT s");
        }
      };
      // Tenant A's row naming tenant B's voucher.
      expect(await attempt([TENANT_A, VOUCHER_B, STORE_A])).toBe("23503");
      // A voucher that does not exist.
      expect(await attempt([TENANT_A, MISSING_VOUCHER, STORE_A])).toBe("23503");
      // Tenant A's row naming tenant B's store.
      expect(await attempt([TENANT_A, VOUCHER_A, STORE_B])).toBe("23503");
      // A same-tenant row is fine once, and a repeat of the primary key is refused.
      await client.query(INSERT_E, [TENANT_A, VOUCHER_A, STORE_A]);
      expect(await attempt([TENANT_A, VOUCHER_A, STORE_A])).toBe("23505");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("refuses to delete a voucher or a store that an eligible-store row cites (23503, ON DELETE RESTRICT)", async () => {
    if (skip()) return;
    await seedVoucherA();
    try {
      expect(await tryRun(`DELETE FROM ${V} WHERE id = $1`, [VOUCHER_A])).toBe("23503");
      expect(await tryRun(`DELETE FROM stores WHERE id = $1`, [STORE_A])).toBe("23503");
    } finally {
      await clearVouchers();
    }
  });
});

describe("0091: tenant isolation (AC2, FORCE RLS)", () => {
  it("lets the app role write and read only its own tenant", async () => {
    if (skip()) return;
    try {
      await asApp(guard(), TENANT_A, async (client) => {
        await client.query(INSERT_V, valuesOf(ACTIVE));
        await client.query(INSERT_E, [TENANT_A, VOUCHER_A, STORE_A]);
        expect((await client.query(`SELECT 1 FROM ${V}`)).rowCount).toBe(1);
        expect((await client.query(`SELECT 1 FROM ${E}`)).rowCount).toBe(1);
        // Another tenant's rows are refused by the INSERT policies (42501).
        await client.query("SAVEPOINT other");
        await expect(client.query(INSERT_V, valuesOf(ACTIVE_B))).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other");
        await client.query("SAVEPOINT other_e");
        await expect(client.query(INSERT_E, [TENANT_B, VOUCHER_B, STORE_B])).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other_e");
      });
      await asApp(guard(), TENANT_B, async (client) => {
        await client.query(INSERT_V, valuesOf(ACTIVE_B));
        // Tenant B sees none of tenant A's rows.
        const seen = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${V}`);
        expect(seen.rows).toEqual([{ tenant_id: TENANT_B }]);
        expect((await client.query(`SELECT 1 FROM ${E}`)).rowCount).toBe(0);
        // And cannot cancel tenant A's voucher: it is invisible to UPDATE.
        expect((await client.query(`UPDATE ${V} SET status = 'redeemed' WHERE id = $1`, [VOUCHER_A])).rowCount).toBe(0);
      });
    } finally {
      await clearVouchers();
    }
  });

  it("lets the app role cancel its own voucher by UPDATE but never delete it, and never change or delete an eligible store", async () => {
    if (skip()) return;
    try {
      await asApp(guard(), TENANT_A, async (client) => {
        await client.query(INSERT_V, valuesOf(ACTIVE));
        await client.query(INSERT_E, [TENANT_A, VOUCHER_A, STORE_A]);
        const cancelled = await client.query(
          `UPDATE ${V} SET status = 'cancelled', cancelled_by_user_id = $2, cancelled_at = now()
            WHERE tenant_id = $3 AND id = $1 AND status = 'active'`,
          [VOUCHER_A, ACTOR, TENANT_A],
        );
        expect(cancelled.rowCount).toBe(1);
        // The conditional write wins once: a second cancel updates nothing.
        const again = await client.query(
          `UPDATE ${V} SET status = 'cancelled', cancelled_by_user_id = $2, cancelled_at = now()
            WHERE tenant_id = $3 AND id = $1 AND status = 'active'`,
          [VOUCHER_A, ACTOR, TENANT_A],
        );
        expect(again.rowCount).toBe(0);
        // An UPDATE that would move the row to another tenant is refused (WITH CHECK).
        await client.query("SAVEPOINT move");
        await expect(client.query(`UPDATE ${V} SET tenant_id = $1 WHERE id = $2`, [TENANT_B, VOUCHER_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT move");
        // No DELETE policy on either table; no UPDATE policy on the eligible stores.
        expect((await client.query(`DELETE FROM ${V}`)).rowCount).toBe(0);
        expect((await client.query(`DELETE FROM ${E}`)).rowCount).toBe(0);
        expect((await client.query(`UPDATE ${E} SET store_id = store_id`)).rowCount).toBe(0);
        expect((await client.query(`SELECT status FROM ${V}`)).rows).toEqual([{ status: "cancelled" }]);
      });
    } finally {
      await clearVouchers();
    }
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await seedVoucherA();
    try {
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${V}`)).rowCount).toBe(0);
        expect((await client.query(`SELECT 1 FROM ${E}`)).rowCount).toBe(0);
      });
    } finally {
      await clearVouchers();
    }
  });
});

describe("0091: UP -> DOWN -> UP (AC3)", () => {
  const exists = async (table: string): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table])).rows[0]!.t !== null;
  const OWNER_TABLES = ["tenants", "stores", V, E];

  it("refuses while a voucher exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await seedVoucherA();
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt1107_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists(V)).toBe(true);
      expect(await exists(E)).toBe(true);
      expect((await e.admin.query(`SELECT 1 FROM ${V}`)).rowCount).toBe(1);
      expect((await e.admin.query(`SELECT 1 FROM ${E}`)).rowCount).toBe(1);
    } finally {
      await clearVouchers();
    }
  });

  it("drops both tables once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists(V)).toBe(false);
    expect(await exists(E)).toBe(false);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists(V)).toBe(true);
    expect(await exists(E)).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt1107_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists(V)).toBe(true);
    expect(await exists(E)).toBe(true);
  });
});
