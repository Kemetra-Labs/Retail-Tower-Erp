/**
 * RT-1350 slice 2: `0107_pending_signups` migration test (authority: the
 * owner's "Yes, start wave 2", 2026-11-13; design RT-1333 v6 section 4).
 *
 * Validates `packages/db/drizzle/0107_pending_signups.sql` (+ `.down.sql`) on a
 * real PostgreSQL (Testcontainers), applied on top of every earlier migration
 * with tenants and users already present (the UPGRADE path):
 *   - both tables start empty (no backfill);
 *   - FORCE RLS and the exact policy set (pending_signups SELECT, INSERT,
 *     UPDATE; user_consents SELECT, INSERT; no DELETE anywhere);
 *   - the CHECKs: status, locale, normalized email, lengths, expiry, the shape
 *     of a completed row; consent source;
 *   - the partial unique indexes: one PENDING signup per email, one token hash;
 *   - the forward-only guard trigger;
 *   - RLS as the NOBYPASSRLS app role: a tenant session reads 0 rows, a
 *     non-platform session cannot INSERT, a platform admin can, consent rows
 *     are append-only;
 *   - the consent link goes NULL when a pending row is purged;
 *   - as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to '';
 *   - UP -> DOWN -> UP, the down dropping ONLY these two tables and the guard.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0107_pending_signups.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0107_pending_signups.down.sql");

const id = (n: string): string => `10700000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const USER_1 = id("0a0a1");
const USER_2 = id("0a0a2");

const P = "pending_signups";
const C = "user_consents";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";
let seq = 0;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const nextId = (): string => id(`1${String(++seq).padStart(4, "0")}`);

async function seedBefore(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'sgn-a', 'Signup A', 'USD'), ($2, 'sgn-b', 'Signup B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'sgn-1@fixture.invalid', NULL), ($2, 'sgn-2@fixture.invalid', NULL)`,
    [USER_1, USER_2],
  );
}

/** A valid pending row; `over` replaces columns. Inserted through the superuser pool. */
async function insertPending(
  email = `owner${seq + 1}@fixture.invalid`,
  over: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    id: nextId(),
    email_normalized: email,
    name: "Owner",
    business_name: "Biz",
    terms_version: "2026-11",
    terms_accepted_at: new Date("2026-11-13T10:00:00Z"),
    ip_hash: "iphash",
    created_at: new Date("2026-11-13T10:00:00Z"),
    expires_at: new Date("2026-11-14T10:00:00Z"),
    ...over,
  };
  const cols = Object.keys(row);
  await guard().admin.query(
    `INSERT INTO ${P} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
  return row["id"] as string;
}

async function insertConsent(over: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: nextId(),
    user_id: USER_1,
    terms_version: "2026-11",
    accepted_at: new Date("2026-11-13T10:00:00Z"),
    ip_hash: "iphash",
    source: "self_signup",
    ...over,
  };
  const cols = Object.keys(row);
  await guard().admin.query(
    `INSERT INTO ${C} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
  return row["id"] as string;
}

/** Run `work` as the app role (optionally with a tenant GUC and/or platform admin); rolls back. */
function asRole<T>(tenant: string | null, platformAdmin: boolean, work: (c: PoolClient) => Promise<T>): Promise<T> {
  return asApp(guard(), tenant, async (client) => {
    if (platformAdmin) await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    return await work(client);
  });
}

async function expectCode(work: Promise<unknown>, code: string): Promise<void> {
  await expect(work).rejects.toMatchObject({ code });
}

const COMPLETE = (idParam: string, tenantParam: string): [string, unknown[]] => [
  `UPDATE ${P} SET status = 'completed', tenant_id = $2, completed_at = now() WHERE id = $1`,
  [idParam, tenantParam],
];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
    await seedBefore(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0107-pending-signups.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0107: ensureAppRole's GRANT ON ALL TABLES only covers tables that exist at grant time.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (skip() || !env) return;
  await env.admin.query(`DELETE FROM ${C}`);
  await env.admin.query(`DELETE FROM ${P}`);
});

describe("0107: files exist and the upgrade creates no rows", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });

  it("both tables are empty after the migration (no backfill)", async () => {
    if (skip()) return;
    const a = guard().admin;
    // afterEach clears them, so read the state a fresh migration leaves via a rolled-back count.
    const r = await a.query<{ n: string }>(`SELECT (SELECT count(*) FROM ${P})::text AS n`);
    expect(r.rows[0]!.n).toBe("0");
    const c = await a.query<{ n: string }>(`SELECT (SELECT count(*) FROM ${C})::text AS n`);
    expect(c.rows[0]!.n).toBe("0");
  });
});

describe("0107: RLS posture", () => {
  it.each([P, C])("%s has RLS enabled + forced", async (table) => {
    if (skip()) return;
    const t = await guard().admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]);
    expect(t.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("has exactly the platform policies: pending_signups SELECT/INSERT/UPDATE, user_consents SELECT/INSERT, no DELETE", async () => {
    if (skip()) return;
    const pol = await guard().admin.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies WHERE tablename IN ($1, $2)`,
      [P, C],
    );
    const byTable = (t: string): string[] =>
      pol.rows.filter((r) => r.tablename === t).map((r) => r.cmd).sort();
    expect(byTable(P)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(byTable(C)).toEqual(["INSERT", "SELECT"]);
  });

  it("no policy mentions a tenant", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
        WHERE tablename IN ($1, $2)
          AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%app.current_tenant%'`,
      [P, C],
    );
    expect(r.rows[0]!.n).toBe("0");
  });
});

describe("0107: pending_signups constraints", () => {
  it("accepts a valid row, with the defaults", async () => {
    if (skip()) return;
    const rowId = await insertPending();
    const r = await guard().admin.query<{ status: string; token_hash: string | null; tenant_id: string | null }>(
      `SELECT status, token_hash, tenant_id FROM ${P} WHERE id = $1`,
      [rowId],
    );
    expect(r.rows[0]).toEqual({ status: "pending", token_hash: null, tenant_id: null });
  });

  it("status and locale are closed sets (23514)", async () => {
    if (skip()) return;
    await expectCode(insertPending("a1@fixture.invalid", { status: "deleted" }), "23514");
    await expectCode(insertPending("a2@fixture.invalid", { locale: "fr" }), "23514");
    await insertPending("a3@fixture.invalid", { locale: "ar" });
  });

  it("the email must be stored normalized and within 254 characters (23514)", async () => {
    if (skip()) return;
    await expectCode(insertPending("Upper@Fixture.invalid"), "23514");
    await expectCode(insertPending(" padded@fixture.invalid "), "23514");
    await expectCode(insertPending(`${"x".repeat(250)}@e.co`), "23514");
  });

  it("name, business name, terms version, ip hash and token hash are bounded (23514)", async () => {
    if (skip()) return;
    await expectCode(insertPending("b1@fixture.invalid", { name: "" }), "23514");
    await expectCode(insertPending("b2@fixture.invalid", { name: "n".repeat(121) }), "23514");
    await expectCode(insertPending("b3@fixture.invalid", { business_name: "" }), "23514");
    await expectCode(insertPending("b4@fixture.invalid", { terms_version: "v".repeat(65) }), "23514");
    await expectCode(insertPending("b5@fixture.invalid", { ip_hash: "" }), "23514");
    await expectCode(insertPending("b6@fixture.invalid", { token_hash: "t".repeat(129) }), "23514");
  });

  it("the expiry is after the creation (23514)", async () => {
    if (skip()) return;
    await expectCode(
      insertPending("c1@fixture.invalid", { expires_at: new Date("2026-11-13T10:00:00Z") }),
      "23514",
    );
  });

  it("a completed row carries the tenant and the time; pending and expired carry neither (23514)", async () => {
    if (skip()) return;
    await expectCode(insertPending("d1@fixture.invalid", { status: "completed" }), "23514");
    await expectCode(
      insertPending("d2@fixture.invalid", { status: "completed", tenant_id: TENANT_A }),
      "23514",
    );
    await expectCode(insertPending("d3@fixture.invalid", { tenant_id: TENANT_A }), "23514");
    await expectCode(
      insertPending("d4@fixture.invalid", { status: "expired", completed_at: new Date() }),
      "23514",
    );
    await insertPending("d5@fixture.invalid", { status: "completed", tenant_id: TENANT_A, completed_at: new Date() });
  });

  it("the completed tenant must exist (23503)", async () => {
    if (skip()) return;
    await expectCode(
      insertPending("e1@fixture.invalid", { status: "completed", tenant_id: id("0d999"), completed_at: new Date() }),
      "23503",
    );
  });
});

describe("0107: pending_signups indexes", () => {
  it("allows one PENDING signup per normalized email (23505), but not across other statuses", async () => {
    if (skip()) return;
    await insertPending("same@fixture.invalid");
    await expectCode(insertPending("same@fixture.invalid"), "23505");
    // An expired or completed row for the same address does not block a new pending one, nor each other.
    await insertPending("other@fixture.invalid", { status: "expired" });
    await insertPending("other@fixture.invalid", { status: "expired" });
    await insertPending("other@fixture.invalid", { status: "completed", tenant_id: TENANT_A, completed_at: new Date() });
    await insertPending("other@fixture.invalid");
  });

  it("a token hash is unique when set, and any number of rows may leave it NULL (23505)", async () => {
    if (skip()) return;
    await insertPending("t1@fixture.invalid");
    await insertPending("t2@fixture.invalid");
    await insertPending("t3@fixture.invalid", { token_hash: "hash-1" });
    await expectCode(insertPending("t4@fixture.invalid", { token_hash: "hash-1" }), "23505");
  });

  it("the lookup and purge indexes exist", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
      [P],
    );
    const names = r.rows.map((x) => x.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "pending_signups_email_idx",
        "pending_signups_expires_at_idx",
        "pending_signups_email_pending_uniq",
        "pending_signups_token_hash_uniq",
      ]),
    );
  });
});

describe("0107: the forward-only guard trigger", () => {
  it("pending -> completed is allowed once, with the tenant and the time", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rowId = await insertPending();
    const [sql, params] = COMPLETE(rowId, TENANT_A);
    await a.query(sql, params);
    const r = await a.query<{ status: string; tenant_id: string }>(`SELECT status, tenant_id FROM ${P} WHERE id = $1`, [rowId]);
    expect(r.rows[0]).toEqual({ status: "completed", tenant_id: TENANT_A });
  });

  it("a completed or expired signup is never changed again (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const done = await insertPending("done@fixture.invalid");
    await a.query(...COMPLETE(done, TENANT_A));
    await expectCode(a.query(`UPDATE ${P} SET token_hash = 'x' WHERE id = $1`, [done]), "23514");
    await expectCode(a.query(`UPDATE ${P} SET tenant_id = $2 WHERE id = $1`, [done, TENANT_B]), "23514");
    const gone = await insertPending("gone@fixture.invalid");
    await a.query(`UPDATE ${P} SET status = 'expired' WHERE id = $1`, [gone]);
    await expectCode(a.query(`UPDATE ${P} SET status = 'pending' WHERE id = $1`, [gone]), "23514");
    await expectCode(a.query(...COMPLETE(gone, TENANT_A)), "23514");
  });

  it("the identity and consent columns never change (23514)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rowId = await insertPending();
    for (const set of [
      "email_normalized = 'moved@fixture.invalid'",
      "name = 'Other'",
      "business_name = 'Other'",
      "locale = 'en'",
      "terms_version = 'other'",
      "terms_accepted_at = now()",
      "ip_hash = 'other'",
      "created_at = now() - interval '1 day'",
      `id = '${nextId()}'`,
    ]) {
      await expectCode(a.query(`UPDATE ${P} SET ${set} WHERE id = $1`, [rowId]), "23514");
    }
  });

  it("while pending, the token hash and the expiry may move (a fresh link)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const rowId = await insertPending();
    await a.query(
      `UPDATE ${P} SET token_hash = 'fresh', expires_at = expires_at + interval '1 hour' WHERE id = $1`,
      [rowId],
    );
    const r = await a.query<{ token_hash: string }>(`SELECT token_hash FROM ${P} WHERE id = $1`, [rowId]);
    expect(r.rows[0]!.token_hash).toBe("fresh");
  });
});

describe("0107: user_consents", () => {
  it("accepts a valid row; the source is a closed set; the user is required and must exist", async () => {
    if (skip()) return;
    await insertConsent();
    await expectCode(insertConsent({ source: "import" }), "23514");
    await expectCode(insertConsent({ user_id: null }), "23502");
    await expectCode(insertConsent({ user_id: id("0d999") }), "23503");
    await expectCode(insertConsent({ terms_version: "" }), "23514");
    await expectCode(insertConsent({ ip_hash: "" }), "23514");
  });

  it("the signup link is provenance only: it must exist, and goes NULL when the pending row is purged", async () => {
    if (skip()) return;
    const a = guard().admin;
    await expectCode(insertConsent({ pending_signup_id: id("0d998") }), "23503");
    const signup = await insertPending();
    const consent = await insertConsent({ pending_signup_id: signup });
    await a.query(`DELETE FROM ${P} WHERE id = $1`, [signup]);
    const r = await a.query<{ pending_signup_id: string | null }>(`SELECT pending_signup_id FROM ${C} WHERE id = $1`, [consent]);
    expect(r.rows).toEqual([{ pending_signup_id: null }]);
  });

  it("a user with consent records cannot be deleted (23503)", async () => {
    if (skip()) return;
    await insertConsent({ user_id: USER_2 });
    await expectCode(guard().admin.query(`DELETE FROM users WHERE id = $1`, [USER_2]), "23503");
  });
});

describe("0107: RLS as the app role", () => {
  it("a tenant session reads 0 rows of both tables, even its own tenant's signup", async () => {
    if (skip()) return;
    const signup = await insertPending();
    await guard().admin.query(...COMPLETE(signup, TENANT_A));
    await insertConsent({ pending_signup_id: signup });
    for (const tenant of [TENANT_A, TENANT_B]) {
      const p = await asRole(tenant, false, (c) => c.query(`SELECT id FROM ${P}`));
      expect(p.rows).toEqual([]);
      const k = await asRole(tenant, false, (c) => c.query(`SELECT id FROM ${C}`));
      expect(k.rows).toEqual([]);
    }
  });

  it("an unset or empty GUC reads nothing and never throws (no 22P02)", async () => {
    if (skip()) return;
    await insertPending();
    await insertConsent();
    for (const tenant of [null, ""]) {
      expect((await asRole(tenant, false, (c) => c.query(`SELECT id FROM ${P}`))).rows).toEqual([]);
      expect((await asRole(tenant, false, (c) => c.query(`SELECT id FROM ${C}`))).rows).toEqual([]);
    }
  });

  it("a tenant session cannot insert into either table (RLS 42501)", async () => {
    if (skip()) return;
    await expectCode(
      asRole(TENANT_A, false, (c) =>
        c.query(
          `INSERT INTO ${P} (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
           VALUES ($1, 'x@fixture.invalid', 'n', 'b', 'v', now(), 'h', now() + interval '1 day')`,
          [nextId()],
        ),
      ),
      "42501",
    );
    await expectCode(
      asRole(TENANT_A, false, (c) =>
        c.query(
          `INSERT INTO ${C} (id, user_id, terms_version, accepted_at, ip_hash, source)
           VALUES ($1, $2, 'v', now(), 'h', 'self_signup')`,
          [nextId(), USER_1],
        ),
      ),
      "42501",
    );
  });

  it("a session with no tenant and no platform flag cannot insert either (RLS 42501)", async () => {
    if (skip()) return;
    await expectCode(
      asRole(null, false, (c) =>
        c.query(
          `INSERT INTO ${P} (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
           VALUES ($1, 'y@fixture.invalid', 'n', 'b', 'v', now(), 'h', now() + interval '1 day')`,
          [nextId()],
        ),
      ),
      "42501",
    );
  });

  it("a platform admin can insert, read and update a pending signup with no tenant context", async () => {
    if (skip()) return;
    const signupId = nextId();
    const r = await asRole(null, true, async (c) => {
      await c.query(
        `INSERT INTO ${P} (id, email_normalized, name, business_name, terms_version, terms_accepted_at, ip_hash, expires_at)
         VALUES ($1, 'z@fixture.invalid', 'n', 'b', 'v', now(), 'h', now() + interval '1 day')`,
        [signupId],
      );
      const upd = await c.query(`UPDATE ${P} SET token_hash = 'h1' WHERE id = $1`, [signupId]);
      const sel = await c.query(`SELECT id, token_hash FROM ${P}`);
      return { updated: upd.rowCount, rows: sel.rows };
    });
    expect(r).toEqual({ updated: 1, rows: [{ id: signupId, token_hash: "h1" }] });
  });

  it("a platform admin can complete a signup and record the consent in one transaction", async () => {
    if (skip()) return;
    const signup = await insertPending();
    const consentId = nextId();
    const done = await asRole(TENANT_A, true, async (c) => {
      const upd = await c.query(...COMPLETE(signup, TENANT_A));
      await c.query(
        `INSERT INTO ${C} (id, user_id, terms_version, accepted_at, ip_hash, source, pending_signup_id)
         VALUES ($1, $2, 'v', now(), 'h', 'self_signup', $3)`,
        [consentId, USER_1, signup],
      );
      return upd.rowCount;
    });
    expect(done).toBe(1);
  });

  it("a non-platform session cannot update a pending signup: the update matches no row", async () => {
    if (skip()) return;
    const signup = await insertPending();
    const r = await asRole(TENANT_A, false, (c) =>
      c.query(`UPDATE ${P} SET token_hash = 'stolen' WHERE id = $1`, [signup]),
    );
    expect(r.rowCount).toBe(0);
    const stored = await guard().admin.query<{ token_hash: string | null }>(`SELECT token_hash FROM ${P} WHERE id = $1`, [signup]);
    expect(stored.rows[0]!.token_hash).toBeNull();
  });

  it("consent records are append-only: not even a platform admin can update or delete one", async () => {
    if (skip()) return;
    const consent = await insertConsent();
    const upd = await asRole(null, true, (c) => c.query(`UPDATE ${C} SET terms_version = 'rewritten' WHERE id = $1`, [consent]));
    expect(upd.rowCount).toBe(0);
    const del = await asRole(null, true, (c) => c.query(`DELETE FROM ${C} WHERE id = $1`, [consent]));
    expect(del.rowCount).toBe(0);
  });

  it("no session can delete a pending signup yet (no DELETE policy)", async () => {
    if (skip()) return;
    const signup = await insertPending();
    const r = await asRole(null, true, (c) => c.query(`DELETE FROM ${P} WHERE id = $1`, [signup]));
    expect(r.rowCount).toBe(0);
  });
});

describe("0107: down and up again", () => {
  it("reads nothing as a NOSUPERUSER owner under FORCE RLS with the GUC pre-set to ''", async () => {
    if (skip()) return;
    const e = guard();
    await insertPending();
    await asMigrationOwner(e, { role: "mig_owner_0107", tables: [P, C], functions: ["pending_signups_guard()"] }, async () => {
      const client = await e.admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mig_owner_0107");
        await client.query("SELECT set_config('app.current_tenant', '', true)");
        const r = await client.query(`SELECT (SELECT count(*) FROM ${P})::int AS p, (SELECT count(*) FROM ${C})::int AS c`);
        expect(r.rows[0]).toEqual({ p: 0, c: 0 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });

  it("the down drops only these two tables and the guard, and the up re-applies cleanly", async () => {
    if (skip()) return;
    const a = guard().admin;
    const count = async (): Promise<number> =>
      Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n);
    const before = await count();
    await a.query(downSql);
    const gone = await a.query(`SELECT to_regclass($1) AS p, to_regclass($2) AS c, to_regproc('pending_signups_guard') AS f`, [P, C]);
    expect(gone.rows[0]).toEqual({ p: null, c: null, f: null });
    expect(await count()).toBe(before - 2);
    expect(await errorCode(() => a.query(upSql))).toBeNull();
    await ensureAppRole(guard());
    const back = await a.query(`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ($1, $2) ORDER BY relname`, [P, C]);
    expect(back.rows).toEqual([
      { relname: C, relforcerowsecurity: true },
      { relname: P, relforcerowsecurity: true },
    ]);
  });
});
