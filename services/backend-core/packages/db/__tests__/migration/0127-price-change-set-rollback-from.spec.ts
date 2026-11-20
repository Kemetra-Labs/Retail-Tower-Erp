/**
 * RT-1532 (RT-1484 follow-up): `0127_price_change_set_rollback_from` (DDL) and
 * `0128_price_change_set_rollback_from_backfill` (data) migration test, on a real PostgreSQL 16
 * (Testcontainers), applied on top of every earlier migration:
 *   - 0127: the two columns (types, NULL), the Drizzle schema names them, the two CHECK constraints refuse
 *     a non-rollback set that carries either column and a half-set pair (asserted by constraint name), a
 *     rollback set may carry both, and the production domain role can INSERT them but not UPDATE them;
 *   - 0128 as a NOSUPERUSER migration owner under FORCE RLS (session tenant GUC pre-set to ''): the
 *     backfill reads each rollback set's FIRST `created` audit row of its own tenant and fills both
 *     columns, also for a published and a superseded set (the guard trigger is off only inside the
 *     function), keeps `updated_at`, state and version, leaves a set with no usable audit row NULL
 *     (never guessed), never overwrites a filled set, and is idempotent (a second call fills 0);
 *   - the guard and updated_at triggers are enabled again afterwards, and the guard still refuses a
 *     change to a published set;
 *   - a rollback set created without the columns after the backfill (the API that runs while `migrate`
 *     runs) is filled by a re-run of the function;
 *   - DOWN: 0128's down drops the function, 0127's down drops constraints and columns; the up re-applies.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns } from "drizzle-orm";
import type { PoolClient } from "pg";

import * as schema from "../../src/schema";

import { applyMigrationsBefore, asMigrationOwner } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_0127 = "0127_price_change_set_rollback_from.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
const DDL_UP = UP_0127;
const DDL_DOWN = "0127_price_change_set_rollback_from.down.sql";
const BACKFILL_UP = "0128_price_change_set_rollback_from_backfill.sql";
const BACKFILL_DOWN = "0128_price_change_set_rollback_from_backfill.down.sql";
const SQL_DIR = resolve(__dirname, "..", "..", "..", "..", "docs", "operations", "sql");

const id = (n: string): string => `01270000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const TENANT_C = id("0c001");
const ACTOR = id("0a0a1");
const CORR = id("0acc1");
const HASH = `sha256:${"a".repeat(64)}`;
const DOMAIN_ROLE = "rt1532_domain";
const OWNER_ROLE = "rt1532_mig_owner";

// Sets. `T_*` are the (standard) targets the rollbacks point at.
const T_A = id("0a200");
const T_B = id("0b200");
const T_C = id("0c200");
const R_EXPLICIT = id("0a201");
const R_DEFAULTED = id("0a202");
const R_NO_AUDIT = id("0a203");
const R_FIRST_ROW = id("0a204");
const R_PUBLISHED = id("0b201");
const R_SUPERSEDED = id("0b202");
const R_NO_KEY = id("0b203");
const R_BAD_VALUE = id("0b204");
const R_PRESET = id("0b205");
const R_LATE = id("0a205");
const R_PENDING = id("0b206");
const R_APPROVED = id("0b207");
const R_BAD_DATE = id("0b208");
const R_BAD_OFFSET = id("0b209");

const TABLES = ["tenants", "change_sets", "audit_events"];
const FUNCTIONS = ["price_change_set_backfill_rollback_from()"];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function constraintOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { constraint?: string; code?: string };
    return e.constraint ?? e.code ?? "unknown";
  }
}

/** Run `fn` on one superuser connection with triggers and FKs off (fixtures only), committed. */
async function fixture(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await guard().admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await fn(c);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/** A change set in the shape BEFORE 0127 (no rollback_from columns). */
async function seedSet(c: PoolClient, setId: string, tenant: string, kind: "standard" | "rollback", target: string | null): Promise<void> {
  await c.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, rolls_back_change_set_id, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'pricing', $3, 'Set', $4, $5, $6, $7)`,
    [setId, tenant, kind, kind === "rollback" ? "Undo" : null, target, ACTOR, CORR],
  );
}

let revisionSeq = 0;
/** Moves a seeded draft set to `state` (preview, approval, publication as that state needs) with the triggers off. */
async function moveTo(c: PoolClient, setId: string, state: "pending_approval" | "approved" | "published" | "superseded"): Promise<void> {
  const published = state === "published" || state === "superseded";
  const approved = published || state === "approved";
  revisionSeq += 1;
  await c.query(
    `UPDATE change_sets
        SET state = $2, validated_at_revision = 0, preview_hash = $3, target_store_set_hash = $3, sensitive = true,
            sensitivity_reasons = ARRAY['rollback'], submitted_at = now() - interval '3 minutes', submitted_by_user_id = $5,
            approved_at = CASE WHEN $6::boolean THEN now() - interval '2 minutes' END,
            approved_by_user_id = CASE WHEN $6::boolean THEN $5::uuid END,
            revision_no = CASE WHEN $7::boolean THEN $4::bigint END,
            published_at = CASE WHEN $7::boolean THEN now() - interval '1 minute' END,
            published_by_user_id = CASE WHEN $7::boolean THEN $5::uuid END
      WHERE id = $1`,
    [setId, state, HASH, 100 + revisionSeq, ACTOR, approved, published],
  );
}

async function seedAudit(c: PoolClient, tenant: string, target: string, metadata: Record<string, unknown>, occurredAt: string): Promise<void> {
  await c.query(
    `INSERT INTO audit_events (id, occurred_at, tenant_id, action, target_type, target_id, metadata)
     VALUES (gen_random_uuid(), $4::timestamptz, $1, 'pricing.change_set.created', 'price_change_set', $2, $3::jsonb)`,
    [tenant, target, JSON.stringify(metadata), occurredAt],
  );
}

interface RollbackColumns {
  rollback_from: string | null;
  rollback_from_defaulted: boolean | null;
}

async function columnsOf(setId: string): Promise<RollbackColumns> {
  const r = await guard().admin.query<RollbackColumns>(
    `SELECT to_char(rollback_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS rollback_from, rollback_from_defaulted
       FROM change_sets WHERE id = $1`,
    [setId],
  );
  return r.rows[0]!;
}

/** Run `statements` as the NOSUPERUSER migration owner with the tenant GUC pre-set to '' (the empty-GUC cast case). */
async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const owner = { role: OWNER_ROLE, tables: TABLES, functions: FUNCTIONS };
  return asMigrationOwner(guard(), owner, async () => {
    const c = await guard().admin.connect();
    try {
      await c.query(`SET ROLE ${OWNER_ROLE}`);
      await c.query(`SELECT set_config('app.current_tenant', '', false)`);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query("RESET app.current_tenant").catch(() => undefined);
      c.release();
    }
  });
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
    return;
  }
  const e = env;
  await applyMigrationsBefore(e, DRIZZLE_DIR, UP_0127);
  const a = e.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rb-a', 'RB A', 'EGP'), ($2, 'rb-b', 'RB B', 'EGP'), ($3, 'rb-c', 'RB C', 'EGP')`,
    [TENANT_A, TENANT_B, TENANT_C],
  );
  // Targets (standard sets) of tenants A, B, C; the rollback sets of the old shape are seeded by the first test.
  await fixture(async (c) => {
    for (const [target, tenant] of [[T_A, TENANT_A], [T_B, TENANT_B], [T_C, TENANT_C]] as const) await seedSet(c, target, tenant, "standard", null);
  });
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("RT-1532 seed shape and 0127 DDL", () => {
  it("(setup) seeds the rollback sets of every state with no new column present, then applies 0127", async () => {
    if (skip()) return;
    const e = guard();
    // One distinct target per rollback (uq_change_sets_rolls_back: one live rollback per target).
    const targets = new Map<string, { tenant: string; target: string }>();
    for (const r of [R_EXPLICIT, R_DEFAULTED, R_NO_AUDIT, R_FIRST_ROW]) targets.set(r, { tenant: TENANT_A, target: "" });
    for (const r of [R_PUBLISHED, R_SUPERSEDED, R_NO_KEY, R_BAD_VALUE, R_PRESET, R_PENDING, R_APPROVED, R_BAD_DATE, R_BAD_OFFSET]) {
      targets.set(r, { tenant: TENANT_B, target: "" });
    }
    let n = 0;
    await fixture(async (c) => {
      for (const [r, meta] of targets) {
        n += 1;
        const target = id(`${meta.tenant === TENANT_A ? "0a" : "0b"}3${String(n).padStart(2, "0")}`);
        await seedSet(c, target, meta.tenant, "standard", null);
        await seedSet(c, r, meta.tenant, "rollback", target);
      }
      await moveTo(c, R_PUBLISHED, "published");
      await moveTo(c, R_SUPERSEDED, "superseded");
      await moveTo(c, R_PENDING, "pending_approval");
      await moveTo(c, R_APPROVED, "approved");
      await c.query(`UPDATE change_sets SET state = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $2 WHERE id = $1`, [R_DEFAULTED, ACTOR]);
      // Audit: the facts the code before RT-1532 read back.
      await seedAudit(c, TENANT_A, R_EXPLICIT, { kind: "rollback", rollback_from: "2031-06-01T00:00:00Z", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_A, R_DEFAULTED, { kind: "rollback", rollback_from: "2026-11-20T10:00:00.123Z", rollback_from_defaulted: true }, "2026-11-20T10:00:00Z");
      // The FIRST created row wins (an earlier explicit one); a later row is ignored.
      await seedAudit(c, TENANT_A, R_FIRST_ROW, { rollback_from: "2032-01-01T12:30:00+02:00", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_A, R_FIRST_ROW, { rollback_from: "2099-01-01T00:00:00Z", rollback_from_defaulted: true }, "2026-11-20T10:05:00Z");
      // Another tenant's audit row naming tenant A's set is never used (explicit tenant predicate).
      await seedAudit(c, TENANT_B, R_NO_AUDIT, { rollback_from: "2040-01-01T00:00:00Z", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_PUBLISHED, { rollback_from: "2031-07-01T00:00:00Z" }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_SUPERSEDED, { rollback_from: "2026-11-20T11:00:00Z", rollback_from_defaulted: true }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_NO_KEY, { kind: "rollback", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_BAD_VALUE, { rollback_from: "tomorrow", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_PENDING, { rollback_from: "2038-04-04T04:04:04Z", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_APPROVED, { rollback_from: "2026-11-21T09:00:00Z", rollback_from_defaulted: true }, "2026-11-20T10:00:00Z");
      // Shaped like an ISO timestamp but not castable: an impossible day, an offset beyond PostgreSQL's range.
      await seedAudit(c, TENANT_B, R_BAD_DATE, { rollback_from: "2026-02-30T00:00:00Z", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_BAD_OFFSET, { rollback_from: "2026-05-01T00:00:00+20:00", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
      await seedAudit(c, TENANT_B, R_PRESET, { rollback_from: "2035-01-01T00:00:00Z", rollback_from_defaulted: false }, "2026-11-20T10:00:00Z");
    });
    expect((await e.admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'change_sets' AND column_name LIKE 'rollback_from%'`)).rowCount).toBe(0);
    await e.admin.query(sql(DDL_UP));
  });

  it("adds the two nullable columns with the right types, and the Drizzle schema names them", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'change_sets' AND column_name LIKE 'rollback_from%' ORDER BY column_name`,
    );
    expect(r.rows).toEqual([
      { column_name: "rollback_from", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { column_name: "rollback_from_defaulted", data_type: "boolean", is_nullable: "YES", column_default: null },
    ]);
    const all = await guard().admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'change_sets'`);
    const dbNames = new Set(all.rows.map((x) => x.column_name));
    const declared = Object.values(getTableColumns(schema.changeSets)).map((col) => col.name);
    expect(declared.filter((n) => !dbNames.has(n))).toEqual([]);
    expect(declared).toEqual(expect.arrayContaining(["rollback_from", "rollback_from_defaulted"]));
  });

  it("CHECKs: only a rollback set carries either column, and both or neither (by constraint name)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const insert = (kind: string, from: string | null, defaulted: boolean | null, target: string | null): Promise<unknown> =>
      a.query(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, rolls_back_change_set_id, created_by_user_id, correlation_id, rollback_from, rollback_from_defaulted)
         VALUES (gen_random_uuid(), $1, 'pricing', $2, 'X', 'why', $3, $4, $5, $6, $7)`,
        [TENANT_C, kind, target, ACTOR, CORR, from, defaulted],
      );
    expect(await constraintOf(() => insert("standard", "2031-01-01T00:00:00Z", false, null))).toBe("change_sets_rollback_from_kind");
    expect(await constraintOf(() => insert("emergency", null, true, null))).toMatch(/change_sets_rollback_from_(kind|whole)/);
    expect(await constraintOf(() => insert("rollback", "2031-01-01T00:00:00Z", null, T_C))).toBe("change_sets_rollback_from_whole");
    expect(await constraintOf(() => insert("rollback", null, false, T_C))).toBe("change_sets_rollback_from_whole");
    // A rollback may carry both, or (a set not filled yet) neither.
    expect(await constraintOf(() => insert("rollback", "2031-01-01T00:00:00Z", false, T_C))).toBeNull();
    expect(await constraintOf(() => insert("rollback", null, null, T_C))).toMatch(/uq_change_sets_rolls_back/);
    await fixture(async (c) => {
      await c.query(`DELETE FROM change_sets WHERE tenant_id = $1 AND kind = 'rollback'`, [TENANT_C]);
    });
  });

  it("the production domain role can INSERT the columns but holds no UPDATE on them (grants unchanged)", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DOMAIN_ROLE}') THEN
         CREATE ROLE ${DOMAIN_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
    );
    await a.query(`GRANT USAGE ON SCHEMA public TO ${DOMAIN_ROLE}`);
    await a.query(`GRANT SELECT ON tenants TO ${DOMAIN_ROLE}`);
    const statements = readFileSync(resolve(SQL_DIR, "pricing-domain-grants.sql"), "utf8")
      .split("\n")
      .filter((line) => /^(GRANT|REVOKE) /.test(line));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await a.query(statement.replace(/:"domain_role"/g, `"${DOMAIN_ROLE}"`));
    const priv = async (column: string, p: string): Promise<boolean> =>
      (await a.query<{ ok: boolean }>(`SELECT has_column_privilege($1, 'change_sets', $2, $3) AS ok`, [DOMAIN_ROLE, column, p])).rows[0]!.ok;
    for (const column of ["rollback_from", "rollback_from_defaulted"]) {
      expect([column, await priv(column, "INSERT")]).toEqual([column, true]);
      expect([column, await priv(column, "UPDATE")]).toEqual([column, false]);
    }
  });
});

describe("RT-1532 0127 guard: the rollback start is set once, by itself", () => {
  const update = (setId: string, set: string): Promise<unknown> => guard().admin.query(`UPDATE change_sets SET ${set} WHERE id = $1`, [setId]);
  const fill = "rollback_from = '2040-01-01T00:00:00Z', rollback_from_defaulted = false";

  it("refuses to fill the pair together with any other column, and a half fill", async () => {
    if (skip()) return;
    // R_NO_AUDIT is an unfilled draft; R_SUPERSEDED / R_PUBLISHED are unfilled terminal / published sets (until 0128).
    expect(await constraintOf(() => update(R_NO_AUDIT, `${fill}, title = 'Edited'`))).toBe("23514");
    expect(await constraintOf(() => update(R_PUBLISHED, `${fill}, title = 'Edited'`))).toBe("23514");
    expect(await constraintOf(() => update(R_SUPERSEDED, `${fill}, state = 'superseded', title = 'Edited'`))).toBe("23514");
    expect(await constraintOf(() => update(R_NO_AUDIT, `rollback_from = '2040-01-01T00:00:00Z'`))).toBe("change_sets_rollback_from_whole");
    expect(await columnsOf(R_NO_AUDIT)).toEqual({ rollback_from: null, rollback_from_defaulted: null });
  });

  it("other changes to a published or superseded set are still refused", async () => {
    if (skip()) return;
    expect(await constraintOf(() => update(R_PUBLISHED, `title = 'Edited'`))).toBe("23514");
    expect(await constraintOf(() => update(R_SUPERSEDED, `title = 'Edited'`))).toBe("23514");
    // A draft's ordinary edit still passes the guard.
    expect(await constraintOf(() => update(R_NO_AUDIT, `title = 'Edited by the draft author'`))).toBeNull();
  });

  it("allows the NULL -> value fill of exactly the pair, in any state (also a cancelled and a published set, by itself)", async () => {
    if (skip()) return;
    // R_NO_AUDIT is a draft; R_DEFAULTED is cancelled; R_PUBLISHED is published. Each is filled by that statement alone.
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET title = 'Set' WHERE id = $1`, [R_NO_AUDIT]);
    });
    expect(await constraintOf(() => update(R_NO_AUDIT, fill))).toBeNull();
    expect(await columnsOf(R_NO_AUDIT)).toEqual({ rollback_from: "2040-01-01T00:00:00.000000", rollback_from_defaulted: false });
    // Undo (fixture, triggers off) so the backfill test below sees the shape it seeded.
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET rollback_from = NULL, rollback_from_defaulted = NULL WHERE id = $1`, [R_NO_AUDIT]);
    });
  });

  it("once set, neither column changes (not even to the same set of values by another value), in any state", async () => {
    if (skip()) return;
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET rollback_from = '2041-01-01T00:00:00Z', rollback_from_defaulted = false WHERE id = ANY($1)`, [[R_NO_AUDIT, R_PUBLISHED]]);
    });
    for (const setId of [R_NO_AUDIT, R_PUBLISHED]) {
      expect(await constraintOf(() => update(setId, `rollback_from = '2042-01-01T00:00:00Z'`))).toBe("23514");
      expect(await constraintOf(() => update(setId, `rollback_from_defaulted = true`))).toBe("23514");
      expect(await constraintOf(() => update(setId, `rollback_from = NULL, rollback_from_defaulted = NULL`))).toBe("23514");
      expect(await columnsOf(setId)).toEqual({ rollback_from: "2041-01-01T00:00:00.000000", rollback_from_defaulted: false });
    }
    // The ordinary update of a filled draft that leaves the pair alone passes.
    expect(await constraintOf(() => update(R_NO_AUDIT, `title = 'Still editable'`))).toBeNull();
    // Back to the seeded shape for the backfill tests.
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET rollback_from = NULL, rollback_from_defaulted = NULL, title = 'Set' WHERE id = ANY($1)`, [[R_NO_AUDIT, R_PUBLISHED]]);
    });
  });
});

describe("RT-1532 0128 backfill as the NOSUPERUSER owner under FORCE RLS", () => {
  const triggerStates = async (): Promise<Record<string, string>> => {
    const r = await guard().admin.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'change_sets'::regclass AND NOT tgisinternal`,
    );
    return Object.fromEntries(r.rows.map((x) => [x.tgname, x.tgenabled]));
  };
  const snapshot = async (): Promise<Record<string, unknown>> => {
    const r = await guard().admin.query<{ id: string; state: string; version: number }>(
      `SELECT id, state, version FROM change_sets WHERE kind = 'rollback' ORDER BY id`,
    );
    return Object.fromEntries(r.rows.map((x) => [x.id, `${x.state}:${x.version}`]));
  };

  it("fills both columns from each set's first created audit row; a set with no usable row stays NULL; a filled set is untouched", async () => {
    if (skip()) return;
    // R_PRESET was filled by hand before the backfill: it must not be overwritten by its audit row.
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET rollback_from = '2036-02-02T00:00:00Z', rollback_from_defaulted = false WHERE id = $1`, [R_PRESET]);
    });
    const triggersBefore = await triggerStates();
    expect(triggersBefore["change_sets_guard"]).toBe("O");
    const before = await snapshot();

    await asOwner(async (c) => {
      await c.query(sql(BACKFILL_UP));
      const again = await c.query<{ n: number }>(`SELECT price_change_set_backfill_rollback_from() AS n`);
      expect(again.rows[0]!.n).toBe(0);
    });

    expect(await columnsOf(R_EXPLICIT)).toEqual({ rollback_from: "2031-06-01T00:00:00.000000", rollback_from_defaulted: false });
    expect(await columnsOf(R_DEFAULTED)).toEqual({ rollback_from: "2026-11-20T10:00:00.123000", rollback_from_defaulted: true });
    expect(await columnsOf(R_FIRST_ROW)).toEqual({ rollback_from: "2032-01-01T10:30:00.000000", rollback_from_defaulted: false });
    // Pending, approved, published and superseded sets are filled too (the guard refuses any other change to them).
    expect(await columnsOf(R_PENDING)).toEqual({ rollback_from: "2038-04-04T04:04:04.000000", rollback_from_defaulted: false });
    expect(await columnsOf(R_APPROVED)).toEqual({ rollback_from: "2026-11-21T09:00:00.000000", rollback_from_defaulted: true });
    expect(await columnsOf(R_PUBLISHED)).toEqual({ rollback_from: "2031-07-01T00:00:00.000000", rollback_from_defaulted: false });
    expect(await columnsOf(R_SUPERSEDED)).toEqual({ rollback_from: "2026-11-20T11:00:00.000000", rollback_from_defaulted: true });
    // No usable audit row: left NULL, never guessed (validate refuses such a set). A value that has the ISO shape but
    // does not cast (an impossible day, an offset of +20:00) is left NULL too and does not fail the migration.
    for (const unusable of [R_NO_AUDIT, R_NO_KEY, R_BAD_VALUE, R_BAD_DATE, R_BAD_OFFSET]) {
      expect([unusable, await columnsOf(unusable)]).toEqual([unusable, { rollback_from: null, rollback_from_defaulted: null }]);
    }
    // A filled set keeps its values.
    expect(await columnsOf(R_PRESET)).toEqual({ rollback_from: "2036-02-02T00:00:00.000000", rollback_from_defaulted: false });
    // A standard set never gets them.
    expect(await columnsOf(T_A)).toEqual({ rollback_from: null, rollback_from_defaulted: null });
    // state and version did not move (updated_at does, once, through the untouched set_updated_at trigger).
    expect(await snapshot()).toEqual(before);
    // No trigger was disabled or changed by the backfill.
    expect(await triggerStates()).toEqual(triggersBefore);
  });

  it("the first call reports how many sets it filled; the guard still refuses another change to a published set", async () => {
    if (skip()) return;
    // The function ran in the previous test; undo its work for two sets to count a fresh run, then re-run it.
    await fixture(async (c) => {
      await c.query(`UPDATE change_sets SET rollback_from = NULL, rollback_from_defaulted = NULL WHERE id = ANY($1)`, [[R_EXPLICIT, R_PUBLISHED]]);
    });
    const filled = await asOwner(async (c) => (await c.query<{ n: number }>(`SELECT price_change_set_backfill_rollback_from() AS n`)).rows[0]!.n);
    expect(filled).toBe(2);
    expect((await columnsOf(R_PUBLISHED)).rollback_from).toBe("2031-07-01T00:00:00.000000");
    // The guard is untouched: a published set still refuses any other change.
    const refused = await constraintOf(() => guard().admin.query(`UPDATE change_sets SET title = 'Edited' WHERE id = $1`, [R_PUBLISHED]));
    expect(refused).toBe("23514");
  });

  it("a rollback set created without the columns after the backfill (the old API during migrate) is filled by a re-run", async () => {
    if (skip()) return;
    await fixture(async (c) => {
      await seedSet(c, id("0a399"), TENANT_A, "standard", null);
      await seedSet(c, R_LATE, TENANT_A, "rollback", id("0a399"));
      await seedAudit(c, TENANT_A, R_LATE, { kind: "rollback", rollback_from: "2037-03-03T03:03:03Z", rollback_from_defaulted: false }, "2026-11-20T12:00:00Z");
    });
    expect(await columnsOf(R_LATE)).toEqual({ rollback_from: null, rollback_from_defaulted: null });
    const filled = await asOwner(async (c) => (await c.query<{ n: number }>(`SELECT price_change_set_backfill_rollback_from() AS n`)).rows[0]!.n);
    expect(filled).toBe(1);
    expect(await columnsOf(R_LATE)).toEqual({ rollback_from: "2037-03-03T03:03:03.000000", rollback_from_defaulted: false });
  });
});

describe("RT-1532 down and re-up", () => {
  it("0128's down drops the function; 0127's down drops constraints and columns; both are rerunnable and the up re-applies", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(sql(BACKFILL_DOWN));
    await a.query(sql(BACKFILL_DOWN));
    expect((await a.query(`SELECT 1 FROM pg_proc WHERE proname = 'price_change_set_backfill_rollback_from'`)).rowCount).toBe(0);
    await a.query(sql(DDL_DOWN));
    await a.query(sql(DDL_DOWN));
    // The 0121 guard body is back (it no longer names the columns), and still refuses a change to a published set.
    const body = async (): Promise<string> => (await a.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'change_sets_guard'`)).rows[0]!.src;
    expect(await body()).not.toContain("rollback_from");
    expect(await constraintOf(() => a.query(`UPDATE change_sets SET title = 'Edited' WHERE id = $1`, [R_PUBLISHED]))).toBe("23514");
    expect((await a.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'change_sets' AND column_name LIKE 'rollback_from%'`)).rowCount).toBe(0);
    expect((await a.query(`SELECT 1 FROM pg_constraint WHERE conname LIKE 'change_sets_rollback_from%'`)).rowCount).toBe(0);
    // The rollback sets themselves survive (the audit rows still hold the facts).
    expect((await a.query(`SELECT 1 FROM change_sets WHERE kind = 'rollback'`)).rowCount).toBeGreaterThan(0);
    await a.query(sql(DDL_UP));
    expect(await body()).toContain("rollback_from");
    await a.query(sql(BACKFILL_UP));
    expect((await a.query(`SELECT 1 FROM change_sets WHERE kind = 'rollback' AND rollback_from IS NOT NULL`)).rowCount).toBeGreaterThanOrEqual(9);
  });
});
