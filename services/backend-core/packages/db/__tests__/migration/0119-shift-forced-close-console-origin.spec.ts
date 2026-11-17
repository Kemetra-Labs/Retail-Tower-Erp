/**
 * 0119 — a Console force close records its origin (Jira RT-1445, slice B1 of
 * RT-1437; [GATED] migration; owner decision 2026-11-17, `closedVia` option (a);
 * contract `console-force-actions.openapi.yaml`).
 *
 * Applies every migration before 0119 against a real Postgres, seeds shifts and
 * two POS force closes made BEFORE the migration (one from another terminal, one
 * from the opening terminal), then applies 0119 AS A NON-SUPERUSER OWNER (the
 * production migration owner is not a superuser, so FORCE RLS applies to it) and
 * proves:
 *   - every existing row survives and reads `closed_via = 'pos'` with its device
 *     (the default covers it; no backfill) and satisfies both CHECKs;
 *   - `closed_from_device_id` is nullable and `closed_via` is NOT NULL, default
 *     'pos', two values only;
 *   - the pairing CHECK in both directions: a console close with no device is
 *     accepted; a console close WITH a device and a pos close WITHOUT one are
 *     refused (23514); a pos close with a device is still accepted;
 *   - the composite FK still pins a POS close's terminal to the shift's tenant
 *     and store (23503), and a NULL device is not checked by it;
 *   - the table stays FORCE RLS, SELECT + INSERT policies only, append-only,
 *     inserted only while the shift is open (the 0070 behaviour is unchanged);
 *   - the file is safe inside its own transaction and sets lock_timeout;
 *   - down REFUSES while a Console close is recorded (as the non-superuser owner,
 *     under FORCE RLS, and with the session GUC pre-set to '' as the migration
 *     owner starts), then rolls back (NOT NULL again, no column) and UP -> DOWN ->
 *     UP round-trips with the POS rows intact.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0119_shift_forced_close_console_origin.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string =>
  readFileSync(resolve(DRIZZLE_DIR, "0119_shift_forced_close_console_origin.down.sql"), "utf8");

const TENANT_A = "0a000000-0000-7000-8000-000000144501";
const TENANT_B = "0a000000-0000-7000-8000-000000144502";
const STORE_A1 = "0a000000-0000-7000-8000-000000144511";
const STORE_A2 = "0a000000-0000-7000-8000-000000144512";
const STORE_B1 = "0a000000-0000-7000-8000-000000144513";
const DEV_A1 = "0a000000-0000-7000-8000-000000144521";
const DEV_A1_SECOND = "0a000000-0000-7000-8000-000000144522";
const DEV_A2 = "0a000000-0000-7000-8000-000000144523";
const DEV_B1 = "0a000000-0000-7000-8000-000000144524";
const CASHIER = "0a000000-0000-7000-8000-000000144531";
const MANAGER = "0a000000-0000-7000-8000-000000144532";

const HASH = createHash("sha256").update("rt1445").digest();
const MIGRATION_OWNER = "rt1445_migration_owner";
const OWNED_TABLES = ["tenants", "stores", "users", "devices", "shifts", "shift_forced_closes"];

let env: PgTestEnv | null = null;
let superuser = "postgres";

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** The SQLSTATE `fn` fails with, or null when it succeeds. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

/** Runs `fn` as the non-superuser app role with `app.current_tenant` = `tenant`, then rolls back. */
async function asApp<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Runs `sql` as the non-superuser migration owner on one connection, with the session GUC pre-set to ''. */
async function asOwner(sql: string): Promise<void> {
  const client = await pg().admin.connect();
  try {
    await client.query(`SET ROLE ${MIGRATION_OWNER}`);
    await client.query(`SELECT set_config('app.current_tenant', '', false)`);
    await client.query(sql);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

const INSERT_COLUMNS = `
  INSERT INTO shift_forced_closes
    (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_by_user_id,
     forced_reason, payload_hash`;

interface Close {
  shift_id: string;
  store_id: string;
  opening_device_id: string;
  closed_from_device_id: string | null;
  closed_via?: string;
}

function insertClose(client: { query: PoolClient["query"] }, row: Close): Promise<unknown> {
  const withVia = row.closed_via !== undefined;
  return client.query(
    `${INSERT_COLUMNS}${withVia ? ", closed_via" : ""}) VALUES ($1, $2, $3, $4, $5, $6, 'left without closing', $7${withVia ? ", $8" : ""})`,
    [row.shift_id, TENANT_A, row.store_id, row.opening_device_id, row.closed_from_device_id, MANAGER, HASH, ...(withVia ? [row.closed_via] : [])],
  );
}

/** An open legacy (audit-ingest) shift: the 0070 FK target needs no cash-up columns, and many may be open on a device. */
async function seedShift(device = DEV_A1, store = STORE_A1): Promise<string> {
  const shiftId = randomUUID();
  await pg().admin.query(
    `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id, opened_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')`,
    [shiftId, TENANT_A, store, CASHIER, device],
  );
  return shiftId;
}

async function becomeOwner(): Promise<void> {
  superuser = (await pg().admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
  await pg().admin.query(`CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pg().admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_OWNER}`);
  for (const table of OWNED_TABLES) await pg().admin.query(`ALTER TABLE ${table} OWNER TO ${MIGRATION_OWNER}`);
}

async function restoreOwner(): Promise<void> {
  const statements = [
    ...OWNED_TABLES.map((table) => `ALTER TABLE ${table} OWNER TO ${superuser}`),
    `REVOKE ALL ON SCHEMA public FROM ${MIGRATION_OWNER}`,
    `DROP ROLE ${MIGRATION_OWNER}`,
  ];
  for (const sql of statements) await pg().admin.query(sql).catch(() => undefined);
}

let preCrossTerminal = "";
let preOwnTerminal = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0119 spec] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(UP_NAME) < 0)
    .sort();
  for (const name of files) await env.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1445-a', 'A'), ($2, 'rt1445-b', 'B')`, [TENANT_A, TENANT_B]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'c@rt1445.example'), ($2, 'm@rt1445.example')`, [CASHIER, MANAGER]);
  const devices: Array<[string, string, string]> = [
    [DEV_A1, TENANT_A, STORE_A1],
    [DEV_A1_SECOND, TENANT_A, STORE_A1],
    [DEV_A2, TENANT_A, STORE_A2],
    [DEV_B1, TENANT_B, STORE_B1],
  ];
  for (const [deviceId, tenant, store] of devices) {
    await a.query(`INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, $5, $4)`, [
      deviceId,
      tenant,
      store,
      createHash("sha256").update(deviceId).digest(),
      `till-${deviceId.slice(-4)}`,
    ]);
  }
  // Two POS force closes recorded before the migration (the 0070 shape: no closed_via column yet).
  preCrossTerminal = await seedShift();
  preOwnTerminal = await seedShift(DEV_A2, STORE_A2);
  await a.query(
    `INSERT INTO shift_forced_closes
       (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_by_user_id, forced_reason, payload_hash)
     VALUES ($1, $3, $4, $5, $6, $2, 'pre one', $7), ($8, $3, $9, $10, $10, $2, 'pre two', $7)`,
    [preCrossTerminal, MANAGER, TENANT_A, STORE_A1, DEV_A1, DEV_A1_SECOND, HASH, preOwnTerminal, STORE_A2, DEV_A2],
  );
  await becomeOwner();
  await asOwner(UP_SQL());
  await ensureAppRole(env);
}, 240_000);

afterAll(async () => {
  if (env) {
    await restoreOwner();
    await stopPgEnv(env);
  }
}, 60_000);

describe("0119 up (as a non-superuser owner, session GUC pre-set to '')", () => {
  it("keeps every existing row as a POS close, with its device, and both CHECKs hold for it", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ shift_id: string; closed_via: string; closed_from_device_id: string | null }>(
      `SELECT shift_id, closed_via, closed_from_device_id FROM shift_forced_closes ORDER BY forced_reason`,
    );
    expect(r.rows).toEqual([
      { shift_id: preCrossTerminal, closed_via: "pos", closed_from_device_id: DEV_A1_SECOND },
      { shift_id: preOwnTerminal, closed_via: "pos", closed_from_device_id: DEV_A2 },
    ]);
    const checks = await pg().admin.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('shift_forced_closes_closed_via_values', 'shift_forced_closes_closed_via_device') ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: "shift_forced_closes_closed_via_device", convalidated: true },
      { conname: "shift_forced_closes_closed_via_values", convalidated: true },
    ]);
  });

  it("makes the device nullable and closed_via NOT NULL with default 'pos'", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'shift_forced_closes' AND column_name IN ('closed_from_device_id', 'closed_via') ORDER BY column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "closed_from_device_id", is_nullable: "YES", column_default: null },
      { column_name: "closed_via", is_nullable: "NO", column_default: "'pos'::text" },
    ]);
  });

  it("keeps FORCED RLS, SELECT + INSERT policies only and the composite FK", async () => {
    if (skip()) return;
    const rls = await pg().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'shift_forced_closes'`);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await pg().admin.query<{ cmd: string }>(`SELECT cmd FROM pg_policies WHERE tablename = 'shift_forced_closes' ORDER BY cmd`);
    expect(policies.rows.map((row) => row.cmd)).toEqual(["INSERT", "SELECT"]);
    const fk = await pg().admin.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_shift_forced_closes_closed_from_device'`);
    expect(fk.rowCount).toBe(1);
  });
});

describe("shift_forced_closes — the closed_via / device pairing", () => {
  it.each<[string, () => Promise<Close>, string | null]>([
    ["a console close with no device", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: null, closed_via: "console" }), null],
    ["a pos close from another terminal (the column default)", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: DEV_A1_SECOND }), null],
    ["a pos close from the opening terminal, explicit", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: DEV_A1, closed_via: "pos" }), null],
    ["a console close that names a device", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: DEV_A1_SECOND, closed_via: "console" }), "23514"],
    ["a pos close with no device", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: null, closed_via: "pos" }), "23514"],
    ["a close with no device and the default origin (pos)", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: null }), "23514"],
    ["an unknown origin", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: null, closed_via: "api" }), "23514"],
    ["a pos close from a terminal of another store (the FK still pins it)", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: DEV_A2 }), "23503"],
    ["a pos close from a terminal of another tenant", async () => ({ shift_id: await seedShift(), store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: DEV_B1 }), "23503"],
  ])("%s → %s", async (_label, makeRow, code) => {
    if (skip()) return;
    const row = await makeRow();
    expect(await asApp(TENANT_A, (c) => errorCode(() => insertClose(c, row)))).toBe(code);
  });

  it("a console close is invisible to and unwritable by another tenant (FORCED RLS), and append-only", async () => {
    if (skip()) return;
    const shiftId = await seedShift();
    const row: Close = { shift_id: shiftId, store_id: STORE_A1, opening_device_id: DEV_A1, closed_from_device_id: null, closed_via: "console" };
    const code = await asApp(TENANT_B, (c) => errorCode(() => insertClose(c, row)));
    expect(code).toBe("42501");
    const seen = await asApp(TENANT_A, async (c) => {
      await insertClose(c, row);
      const own = (await c.query(`SELECT closed_via FROM shift_forced_closes WHERE shift_id = $1`, [shiftId])).rowCount;
      // No UPDATE policy: the row is not updatable (refused, or zero rows under RLS), never changed.
      await errorCode(() => c.query(`UPDATE shift_forced_closes SET closed_via = 'pos' WHERE shift_id = $1`, [shiftId]));
      const after = (await c.query<{ closed_via: string }>(`SELECT closed_via FROM shift_forced_closes WHERE shift_id = $1`, [shiftId])).rows[0];
      return { own, after };
    });
    expect(seen.own).toBe(1);
    expect(seen.after).toEqual({ closed_via: "console" });
  });
});

describe("0119 down", () => {
  it("refuses while a Console close is recorded, as the non-superuser owner under FORCE RLS", async () => {
    if (skip()) return;
    const shiftId = await seedShift();
    await pg().admin.query(
      `INSERT INTO shift_forced_closes
         (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_via, closed_by_user_id, forced_reason, payload_hash)
       VALUES ($1, $2, $3, $4, NULL, 'console', $5, 'console one', $6)`,
      [shiftId, TENANT_A, STORE_A1, DEV_A1, MANAGER, HASH],
    );
    const err = await errorCode(() => asOwner(DOWN_SQL()));
    expect(err).toBe("P0001");
    const col = await pg().admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'shift_forced_closes' AND column_name = 'closed_via'`);
    expect(col.rowCount).toBe(1);
    // Break-glass: the table is append-only, so the Console row is removed with the trigger off.
    await pg().admin.query(`ALTER TABLE shift_forced_closes DISABLE TRIGGER shift_forced_closes_append_only_row`);
    await pg().admin.query(`DELETE FROM shift_forced_closes WHERE closed_via = 'console'`);
    await pg().admin.query(`ALTER TABLE shift_forced_closes ENABLE TRIGGER shift_forced_closes_append_only_row`);
  });

  it("rolls back (device NOT NULL again, no closed_via, POS rows intact) and UP -> DOWN -> UP round-trips", async () => {
    if (skip()) return;
    await asOwner(DOWN_SQL());
    const cols = await pg().admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'shift_forced_closes' AND column_name IN ('closed_from_device_id', 'closed_via')`,
    );
    expect(cols.rows).toEqual([{ column_name: "closed_from_device_id", is_nullable: "NO" }]);
    const kept = await pg().admin.query(`SELECT 1 FROM shift_forced_closes WHERE shift_id = ANY($1::uuid[])`, [[preCrossTerminal, preOwnTerminal]]);
    expect(kept.rowCount).toBe(2);
    await asOwner(UP_SQL());
    const again = await pg().admin.query<{ closed_via: string }>(`SELECT DISTINCT closed_via FROM shift_forced_closes`);
    expect(again.rows).toEqual([{ closed_via: "pos" }]);
  });

  it("the up file runs in one transaction with a lock timeout", () => {
    const sql = UP_SQL();
    expect(sql).toMatch(/BEGIN;[\s\S]*SET LOCAL lock_timeout = '2s';[\s\S]*COMMIT;/);
    expect(sql).not.toMatch(/\bUPDATE\b[^;]*shift_forced_closes/i); // no backfill: the default covers every row
  });
});
