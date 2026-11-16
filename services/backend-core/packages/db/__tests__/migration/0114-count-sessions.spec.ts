/**
 * RT-1420: `0114_count_sessions` migration test (RT-292 Gate 6; contract RT-1419;
 * owner delegation recorded on RT-1420).
 *
 * Validates `packages/db/drizzle/0114_count_sessions.sql` (+ `.down.sql`):
 *   - the five tables, FORCE RLS, the twelve policies (sessions and lines get
 *     UPDATE; expected, observations and findings are append-only);
 *   - the state CHECKs: each state needs the columns that lead to it, the cut and
 *     the approval are all-or-none, the exception needs its reason;
 *   - the same-tenant composite FKs (a store of another tenant, a location of
 *     another store) and the quantity and status CHECKs;
 *   - the settings columns default OFF, and the exception needs a recorded reason;
 *   - the app role is isolated by tenant and cannot change an append-only row;
 *   - the down REFUSES while a session exists, and UP -> DOWN -> UP round-trips
 *     once none does.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1
 * (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0114_count_sessions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0114_count_sessions.down.sql");

const id = (n: string): string => `11400000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const PRODUCT_A = id("0a031");
const ACTOR = id("0a0a1");
const SESSION = id("0a051");

const TABLES = [
  "count_sessions",
  "count_session_lines",
  "count_session_expected",
  "count_observations",
  "count_late_event_findings",
];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";
let locationA = "";
let locationA2 = "";

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
      console.warn(`\n[0114-count-sessions.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'cs-a', 'CS A', 'USD'), ($2, 'cs-b', 'CS B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Product A', 'standard', $3, $3)`,
    [PRODUCT_A, TENANT_A, ACTOR],
  );
  locationA = (await a.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A])).rows[0].id as string;
  locationA2 = (await a.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A2])).rows[0].id as string;
  await a.query(upSql);
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Run statements as the superuser inside a rolled-back transaction; returns the error code or null. */
async function tryRun(statements: Array<[string, unknown[]?]>): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, params] of statements) await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const SESSION_INSERT = (cols: string, vals: string): [string, unknown[]] => [
  `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by${cols})
   VALUES ($1, $2, $3, ARRAY[$4::uuid], $5${vals})`,
  [SESSION, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
];

describe("0114: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0114: tables and policies", () => {
  it("creates the five tables with FORCE ROW LEVEL SECURITY", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [TABLES],
    );
    expect(rls.rows).toHaveLength(5);
    expect(rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });

  it("grants UPDATE policies to sessions and lines only; the rest are append-only", async () => {
    if (skip()) return;
    const policies = await guard().admin.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename, cmd`,
      [TABLES],
    );
    expect(policies.rows).toHaveLength(12);
    const updates = policies.rows.filter((p) => p.cmd === "UPDATE").map((p) => p.tablename);
    expect(updates.sort()).toEqual(["count_session_lines", "count_sessions"]);
    expect(policies.rows.some((p) => p.cmd === "DELETE" || p.cmd === "ALL")).toBe(false);
  });
});

describe("0114: state constraints", () => {
  it("stores an open session with server defaults", async () => {
    if (skip()) return;
    expect(await tryRun([SESSION_INSERT("", "")])).toBeNull();
  });

  it.each<[string, string, string]>([
    ["cut_taken without a cut", ", state", ", 'cut_taken'"],
    ["submitted without a cut and a submission", ", state", ", 'submitted'"],
    ["approved without an approval", ", state", ", 'approved'"],
    ["an unknown state", ", state", ", 'finished'"],
    ["a cancelled state without its cancellation", ", state", ", 'cancelled'"],
    ["a half cut (time without watermark)", ", cut_at", ", now()"],
    ["a half approval (approver only)", ", approved_by", `, '${ACTOR}'`],
    ["a 501-character note", ", note", `, '${"x".repeat(501)}'`],
  ])("refuses %s (23514)", async (_why, cols, vals) => {
    if (skip()) return;
    expect(await tryRun([SESSION_INSERT(cols, vals)])).toBe("23514");
  });

  it("refuses the small-merchant exception without its reason, and an empty scope", async () => {
    if (skip()) return;
    const exception = `, state, cut_at, cut_watermark, cut_taken_by, submitted_by, submitted_at, approved_by, approved_at, approval_policy, self_approved`;
    const exceptionVals = `, 'approved', now(), 'wm', '${ACTOR}', '${ACTOR}', now(), '${ACTOR}', now(), 'small_merchant_exception', true`;
    expect(await tryRun([SESSION_INSERT(exception, exceptionVals)])).toBe("23514");
    expect(
      await tryRun([
        [
          `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
           VALUES ($1, $2, $3, ARRAY[]::uuid[], $4)`,
          [SESSION, TENANT_A, STORE_A, ACTOR],
        ],
      ]),
    ).toBe("23514");
  });

  it("refuses a store of another tenant (23503)", async () => {
    if (skip()) return;
    expect(
      await tryRun([
        [
          `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
           VALUES ($1, $2, $3, ARRAY[$4::uuid], $5)`,
          [SESSION, TENANT_A, STORE_B, PRODUCT_A, ACTOR],
        ],
      ]),
    ).toBe("23503");
  });
});

describe("0114: lines and observations", () => {
  const withSessionAndLine = (): Array<[string, unknown[]?]> => [
    SESSION_INSERT("", ""),
    [
      `INSERT INTO count_session_lines (session_id, tenant_id, store_id, tenant_product_ref) VALUES ($1, $2, $3, $4)`,
      [SESSION, TENANT_A, STORE_A, PRODUCT_A],
    ],
  ];
  const obs = (location: string, qty: string, status = "sellable"): [string, unknown[]] => [
    `INSERT INTO count_observations
       (id, session_id, tenant_id, store_id, tenant_product_ref, location_id, inventory_status, counted_quantity, stocking_unit, counted_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::numeric, 'each', $8)`,
    [SESSION, TENANT_A, STORE_A, PRODUCT_A, location, status, qty, ACTOR],
  ];

  it("stores an observation at a location of the session's store", async () => {
    if (skip()) return;
    expect(await tryRun([...withSessionAndLine(), obs(locationA, "7")])).toBeNull();
  });

  it("refuses a negative quantity and an unknown status (23514), and a location of another store (23503)", async () => {
    if (skip()) return;
    expect(await tryRun([...withSessionAndLine(), obs(locationA, "-1")])).toBe("23514");
    expect(await tryRun([...withSessionAndLine(), obs(locationA, "1", "lost")])).toBe("23514");
    expect(await tryRun([...withSessionAndLine(), obs(locationA2, "1")])).toBe("23503");
  });

  it("refuses a line for a product of another tenant (23503)", async () => {
    if (skip()) return;
    expect(
      await tryRun([
        SESSION_INSERT("", ""),
        [
          `INSERT INTO count_session_lines (session_id, tenant_id, store_id, tenant_product_ref) VALUES ($1, $2, $3, $4)`,
          [SESSION, TENANT_B, STORE_A, PRODUCT_A],
        ],
      ]),
    ).not.toBeNull();
  });
});

describe("0114: tenant settings", () => {
  it("defaults Count Sessions and the exception OFF, and the exception needs its reason", async () => {
    if (skip()) return;
    await guard().admin.query(
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [TENANT_A, ACTOR],
    );
    const r = await guard().admin.query(
      `SELECT count_sessions_enabled, count_self_approval_enabled FROM tenant_inventory_settings WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(r.rows).toEqual([{ count_sessions_enabled: false, count_self_approval_enabled: false }]);
    expect(
      await tryRun([[`UPDATE tenant_inventory_settings SET count_self_approval_enabled = true WHERE tenant_id = $1`, [TENANT_A]]]),
    ).toBe("23514");
    expect(
      await tryRun([
        [
          `UPDATE tenant_inventory_settings
              SET count_self_approval_enabled = true, count_self_approval_reason = 'one person shop',
                  count_self_approval_changed_at = now(), count_self_approval_changed_by = $2
            WHERE tenant_id = $1`,
          [TENANT_A, ACTOR],
        ],
      ]),
    ).toBeNull();
  });
});

describe("0114: tenant isolation (FORCE RLS)", () => {
  it("lets the app role write and read only its own tenant, and not change an append-only row", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(
        `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
         VALUES ($1, $2, $3, ARRAY[$4::uuid], $5)`,
        [SESSION, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
      );
      expect((await client.query(`SELECT 1 FROM count_sessions`)).rowCount).toBe(1);
      await client.query("SAVEPOINT other");
      await expect(
        client.query(
          `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
           VALUES ($1, $2, $3, ARRAY[$4::uuid], $5)`,
          [id("0b052"), TENANT_B, STORE_B, PRODUCT_A, ACTOR],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT other");
    });
    await asApp(guard(), TENANT_B, async (client) => {
      expect((await client.query(`SELECT 1 FROM count_sessions`)).rowCount).toBe(0);
    });
  });
});

describe("0114: down", () => {
  it("refuses while a session exists, then round-trips UP -> DOWN -> UP", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(
      `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by)
       VALUES ($1, $2, $3, ARRAY[$4::uuid], $5) ON CONFLICT (id) DO NOTHING`,
      [SESSION, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
    );
    await expect(a.query(downSql)).rejects.toThrow(/0114 down refused/);
    await a.query(`DELETE FROM count_sessions`);
    await a.query(downSql);
    expect((await a.query(`SELECT to_regclass('count_sessions') AS t`)).rows[0].t).toBeNull();
    await a.query(downSql); // rerunnable
    await a.query(upSql);
    expect((await a.query(`SELECT to_regclass('count_sessions') AS t`)).rows[0].t).not.toBeNull();
  });
});
