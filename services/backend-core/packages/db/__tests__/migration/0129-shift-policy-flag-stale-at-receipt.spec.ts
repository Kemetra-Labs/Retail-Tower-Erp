/**
 * RT-592 (RT-387 follow-up): `0129_shift_policy_flag_stale_at_receipt` ([GATED: migration]) on a real
 * PostgreSQL 16 (Testcontainers), applied on top of every earlier migration.
 *
 * The open's accept-and-flag findings live in `shifts.frozen_policy_flags`, guarded by the 0050 CHECK
 * `shifts_frozen_policy_flags_valid`. The new fourth flag must be storable, or the open would fail
 * with 23514 instead of being recorded and flagged. This proves:
 *   - BEFORE 0129: the new flag is refused by that constraint (so the migration is what makes it storable);
 *   - UP: the new flag is accepted alone and with the other three, in any order; the 0050 rules are
 *     unchanged (an unknown flag, a duplicate of any flag and a NULL element are still refused, NULL
 *     and `{}` are still fine); an existing row keeps its flags; the constraint is NOT VALID, as 0050
 *     added it (no table scan);
 *   - DOWN, as a NOSUPERUSER migration owner under FORCE RLS: refuses while a shift carries the new
 *     flag (the guard must see the row, so the read runs under app.is_platform_admin), and after the
 *     flag is stripped it restores the three-flag CHECK; the up re-applies cleanly.
 *
 * Fixtures are inserted on one superuser connection with `session_replication_role = replica`
 * (foreign keys and triggers off; CHECK constraints still apply), so no tenant, store or user rows are needed.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asMigrationOwner, startPgEnvOrSkip } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP = "0129_shift_policy_flag_stale_at_receipt.sql";
const DOWN = "0129_shift_policy_flag_stale_at_receipt.down.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");

const CONSTRAINT = "shifts_frozen_policy_flags_valid";
const NEW_FLAG = "policy_revision_stale_at_receipt";
const OWNER_ROLE = "rt592_mig_owner";

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

/** An open cash-up shift carrying `flags` (a system / none frozen policy), on its own device. */
async function insertShift(flags: Array<string | null> | null): Promise<string> {
  const shiftId = randomUUID();
  const hash = createHash("sha256").update(`open:${shiftId}`).digest();
  await fixture((c) =>
    c.query(
      `INSERT INTO shifts
         (shift_id, tenant_id, store_id, opening_device_id, opening_cashier_user_id, opened_at, source,
          currency_code, opening_float, business_date, received_at, recorded_by_user_id, payload_hash,
          frozen_policy_source, frozen_policy_mode, frozen_policy_flags)
       VALUES ($1, $2, $3, $4, $5, '2026-11-20T08:00:00Z', 'cash_up', 'EGP', 500.00, '2026-11-20',
               '2026-11-20T08:00:02Z', $5, $6, 'system', 'none', $7::text[])`,
      [shiftId, randomUUID(), randomUUID(), randomUUID(), randomUUID(), hash, flags],
    ),
  );
  return shiftId;
}

async function flagsOf(shiftId: string): Promise<string[] | null> {
  const r = await pg().admin.query<{ flags: string[] | null }>(
    `SELECT frozen_policy_flags AS flags FROM shifts WHERE shift_id = $1`,
    [shiftId],
  );
  return r.rows[0]?.flags ?? null;
}

async function constraintState(): Promise<{ def: string; validated: boolean }> {
  const r = await pg().admin.query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
       FROM pg_constraint WHERE conname = $1 AND conrelid = 'public.shifts'::regclass`,
    [CONSTRAINT],
  );
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!;
}

/** Run a migration file as the NOSUPERUSER owner of shifts, tenant GUC pre-set to '' (the empty-GUC cast case). */
async function runAsOwner(file: string): Promise<{ code: string | null; message: string }> {
  const owner = { role: OWNER_ROLE, tables: ["shifts"], functions: [] };
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

let preExisting = "";

beforeAll(async () => {
  const started = await startPgEnvOrSkip(startPgEnv, process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1");
  if (started.env === null) {
    // eslint-disable-next-line no-console
    console.warn(`\n[0129-shift-policy-flag-stale-at-receipt.spec] Docker NOT AVAILABLE — skipping: ${started.skipReason}\n`);
    return;
  }
  env = started.env;
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP);
  preExisting = await insertShift(["policy_revision_superseded", "policy_value_mismatch"]);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0129 — before the migration", () => {
  it("refuses the new flag with the 0050 constraint (23514)", async () => {
    if (skip()) return;
    expect(await violated(() => insertShift([NEW_FLAG]))).toBe(CONSTRAINT);
  });
});

describe("0129 — up", () => {
  beforeAll(async () => {
    if (skip()) return;
    await pg().admin.query(sql(UP));
  });

  it.each([
    ["alone", [NEW_FLAG]],
    ["after the three others", ["policy_revision_unknown", "policy_revision_superseded", "policy_value_mismatch", NEW_FLAG]],
    ["before the others (the constraint does not order)", [NEW_FLAG, "policy_value_mismatch"]],
  ])("accepts the new flag %s", async (_label, flags) => {
    if (skip()) return;
    const id = await insertShift(flags);
    expect(await flagsOf(id)).toEqual(flags);
  });

  it.each([
    ["none (NULL)", null],
    ["no flags ({})", []],
    ["each old flag", ["policy_revision_unknown", "policy_revision_superseded", "policy_value_mismatch"]],
  ])("still accepts %s", async (_label, flags) => {
    if (skip()) return;
    expect(await flagsOf(await insertShift(flags))).toEqual(flags);
  });

  it.each([
    ["an unknown flag", ["policy_something_else"]],
    ["the new flag twice", [NEW_FLAG, NEW_FLAG]],
    ["an old flag twice", ["policy_revision_unknown", "policy_revision_unknown"]],
    ["a NULL element", [NEW_FLAG, null]],
  ])("still refuses %s", async (_label, flags) => {
    if (skip()) return;
    expect(await violated(() => insertShift(flags))).toBe(CONSTRAINT);
  });

  it("keeps the flags of a shift recorded before the migration", async () => {
    if (skip()) return;
    expect(await flagsOf(preExisting)).toEqual(["policy_revision_superseded", "policy_value_mismatch"]);
  });

  it("re-adds the constraint NOT VALID, as 0050 did (no table scan under the lock)", async () => {
    if (skip()) return;
    const state = await constraintState();
    expect(state.validated).toBe(false);
    expect(state.def).toContain(NEW_FLAG);
  });
});

describe("0129 — down, as the NOSUPERUSER migration owner under FORCE RLS", () => {
  it("refuses while a shift carries the new flag, and changes nothing", async () => {
    if (skip()) return;
    const refused = await runAsOwner(DOWN);
    expect(refused.code).toBe("P0001");
    expect(refused.message).toContain("0129 down refused");
    expect((await constraintState()).def).toContain(NEW_FLAG);
  });

  it("restores the three-flag constraint once the flag is stripped, and the up re-applies", async () => {
    if (skip()) return;
    await fixture((c) =>
      c.query(
        `UPDATE shifts SET frozen_policy_flags = array_remove(frozen_policy_flags, $1::text)
          WHERE frozen_policy_flags @> ARRAY[$1::text]`,
        [NEW_FLAG],
      ),
    );
    expect((await runAsOwner(DOWN)).code).toBeNull();
    const restored = await constraintState();
    expect(restored.def).not.toContain(NEW_FLAG);
    expect(restored.validated).toBe(false);
    expect(await violated(() => insertShift([NEW_FLAG]))).toBe(CONSTRAINT);
    expect(await flagsOf(await insertShift(["policy_value_mismatch"]))).toEqual(["policy_value_mismatch"]);

    await pg().admin.query(sql(UP));
    expect(await flagsOf(await insertShift([NEW_FLAG]))).toEqual([NEW_FLAG]);
  });
});
