/**
 * RT-1503 (spec 049 S2): `0124_catalog_import` migration test.
 *
 * Validates `packages/db/drizzle/0124_catalog_import.sql` (+ `.down.sql`) on a
 * real PostgreSQL 16, applied on top of every earlier migration with tenants
 * and products already present (the UPGRADE path):
 *   - the three tables match the Drizzle schema; FORCE RLS and the exact policy
 *     set (SELECT + INSERT + UPDATE everywhere, DELETE on the rows only); the
 *     three batch indexes with their predicates;
 *   - batches: one OPEN batch per tenant (draft, validated, pending_approval,
 *     approved); created as a draft; identity and mode fixed; version and
 *     validation generation only forward; closing sets closed_at and clears
 *     expires_at; a closed batch is frozen except rows_purged_at, set once;
 *     a warning never names its own batch; mapping / suggested_mapping are
 *     the contract's ColumnMapping[]; the conditional expiry UPDATE; the
 *     profile reference is pinned to the tenant; DELETE and TRUNCATE refused
 *     for every role;
 *   - rows: PK and composite FK to the batch; identity and cells fixed; the
 *     review decision is whole; DELETE allowed (re-upload, purge);
 *   - mapping profiles: unique per (tenant, name), an upsert keeps the id, the
 *     name never changes, an empty or untrimmed header key is refused;
 *   - two-tenant isolation under FORCE RLS as the app role;
 *   - a role holding exactly the production grants
 *     (docs/operations/sql/catalog-import-domain-grants.sql);
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner under FORCE RLS
 *     with the session tenant GUC pre-set to '' (the empty-GUC cast case), and
 *     the down REFUSES while a batch or a mapping profile exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getTableColumns, getTableName } from "drizzle-orm";
import type { PoolClient } from "pg";

import * as schema from "../../src/schema";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, inRolledBackTx, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0124_catalog_import.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0124_catalog_import.down.sql");
const SQL_DIR = resolve(__dirname, "..", "..", "..", "..", "docs", "operations", "sql");
const DOMAIN_ROLE = "rt1503_domain";

const id = (n: string): string => `01240000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const PROD_A1 = id("0a031");
const PROD_B1 = id("0b031");
const ACTOR = id("0a0a1");
const PROFILE_A = id("0a101");
const PROFILE_B = id("0b101");
const BATCH_A = id("0a201");
const BATCH_A_CLOSED = id("0a202");
const BATCH_B = id("0b201");
const SHA = "a".repeat(64);
const HASH = `sha256:${"b".repeat(64)}`;
const COLUMNS = JSON.stringify([
  { columnNumber: 1, header: "SKU", samples: ["A-1"] },
  { columnNumber: 2, header: "الاسم", samples: ["شاي"] },
]);
const MAPPING = JSON.stringify([
  { columnNumber: 1, target: "sku" },
  { columnNumber: 2, target: "name" },
]);
const COUNTS = JSON.stringify({ ready_create: 1, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 });
const SUMMARY = JSON.stringify({
  brandsCreated: 0,
  productsCreated: 1,
  productsUpdated: 0,
  identifiersAdded: 1,
  productsDeactivated: 0,
  rowsUnchanged: 0,
  rowsExcluded: 0,
});

const TABLES = ["catalog_import_mapping_profiles", "catalog_import_batches", "catalog_import_rows"] as const;
const FUNCTIONS = [
  "catalog_import_mapping_profiles_guard()",
  "catalog_import_batches_guard()",
  "catalog_import_batches_no_delete()",
  "catalog_import_rows_guard()",
];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

// -----------------------------------------------------------------------------
// SQL helpers
// -----------------------------------------------------------------------------

type Q = Pick<PoolClient, "query">;

async function insertProfile(q: Q, profileId: string, tenant: string, name = "Supplier A", entries: object = { SKU: "sku" }): Promise<void> {
  await q.query(
    `INSERT INTO catalog_import_mapping_profiles (id, tenant_id, name, entries, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [profileId, tenant, name, JSON.stringify(entries), ACTOR],
  );
}

/** A CSV draft batch, created as the runtime would at upload. */
async function insertBatch(q: Q, batchId: string, tenant: string, extra: { profile?: string | null; warnings?: object[] } = {}): Promise<void> {
  await q.query(
    `INSERT INTO catalog_import_batches
       (id, tenant_id, mode, file_name, file_size, file_sha256, file_kind, csv_delimiter, data_row_count, column_count,
        parser_version, columns, suggested_mapping, mapping_profile_id, warnings, created_by, expires_at)
     VALUES ($1, $2, 'upsert', 'منتجات.csv', 120, $3, 'csv', 'comma', 2, 2, 'csv-1', $4, $5, $6, $7, $8, now() + interval '7 days')`,
    [batchId, tenant, SHA, COLUMNS, MAPPING, extra.profile ?? null, JSON.stringify(extra.warnings ?? []), ACTOR],
  );
}

async function insertRow(q: Q, batchId: string, tenant: string, rowNumber: number): Promise<void> {
  await q.query(
    `INSERT INTO catalog_import_rows (tenant_id, batch_id, row_number, cells) VALUES ($1, $2, $3, $4)`,
    [tenant, batchId, rowNumber, JSON.stringify([`A-${rowNumber}`, null])],
  );
}

/** draft -> validated, the columns validate sets. */
async function validate(q: Q, batchId: string): Promise<void> {
  await q.query(
    `UPDATE catalog_import_batches SET state = 'validated', version = version + 1,
            validation_generation = validation_generation + 1, mapping = $2, counts = $3, preview_hash = $4,
            expires_at = now() + interval '7 days'
      WHERE id = $1`,
    [batchId, MAPPING, COUNTS, HASH],
  );
}

/** validated -> published: closes the batch (closed_at, no expiry) with its stored summary. */
async function publish(q: Q, batchId: string): Promise<void> {
  await q.query(
    `UPDATE catalog_import_batches SET state = 'published', version = version + 1, publish_summary = $2,
            published_at = now(), closed_at = now(), expires_at = NULL
      WHERE id = $1`,
    [batchId, SUMMARY],
  );
}

/** Runs `fn` under a savepoint so the transaction survives an expected error; returns its code or null. */
async function sp(c: Q, fn: () => Promise<unknown>): Promise<string | null> {
  await c.query("SAVEPOINT expect_error");
  const code = await errorCode(fn);
  await c.query(code === null ? "RELEASE SAVEPOINT expect_error" : "ROLLBACK TO SAVEPOINT expect_error");
  return code;
}

/** As the superuser, in a transaction that is always rolled back. */
const admin = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => inRolledBackTx(guard().admin, fn);

async function exists(name: string): Promise<boolean> {
  const r = await guard().admin.query<{ x: string | null }>(`SELECT to_regclass($1)::text AS x`, [name]);
  return r.rows[0]!.x !== null;
}

/** Runs `fn` in its own transaction and COMMITs it; returns the error code or null. */
async function committed(fn: (client: PoolClient) => Promise<unknown>): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
    return null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    client.release();
  }
}

/** Removes every import row as the superuser, with the no-delete trigger off (test cleanup only). */
async function clearImport(): Promise<void> {
  const failed = await committed(async (c) => {
    await c.query("SET LOCAL session_replication_role = replica");
    for (const table of ["catalog_import_rows", "catalog_import_batches", "catalog_import_mapping_profiles"]) {
      await c.query(`DELETE FROM ${table}`);
    }
  });
  if (failed !== null) throw new Error(`cleanup failed: ${failed}`);
}

/** A role holding exactly the production grants, in a rolled-back transaction under tenant A. */
async function asDomain<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${DOMAIN_ROLE}`);
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * The committed baseline: a profile per tenant; tenant A's open batch BATCH_A
 * (rows 2 and 3) and published BATCH_A_CLOSED (row 2); tenant B's open
 * BATCH_B (row 2).
 */
async function seedBaseline(): Promise<void> {
  const failed = await committed(async (c) => {
    await insertProfile(c, PROFILE_A, TENANT_A);
    await insertProfile(c, PROFILE_B, TENANT_B);
    await insertBatch(c, BATCH_A_CLOSED, TENANT_A, { profile: PROFILE_A });
    await insertRow(c, BATCH_A_CLOSED, TENANT_A, 2);
    await validate(c, BATCH_A_CLOSED);
    await publish(c, BATCH_A_CLOSED);
    await insertBatch(c, BATCH_A, TENANT_A, {
      profile: PROFILE_A,
      warnings: [{ code: "file_previously_published", publishedBatchId: BATCH_A_CLOSED, publishedAt: "2026-11-19T10:00:00Z" }],
    });
    await insertRow(c, BATCH_A, TENANT_A, 2);
    await insertRow(c, BATCH_A, TENANT_A, 3);
    await insertBatch(c, BATCH_B, TENANT_B, { profile: PROFILE_B });
    await insertRow(c, BATCH_B, TENANT_B, 2);
  });
  if (failed !== null) throw new Error(`baseline seed failed: ${failed}`);
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

/**
 * True only when the error says no container runtime is reachable. A file
 * error (a missing SQL fixture read by startPgEnv) or any other setup failure
 * is never mistaken for missing Docker, so MIGRATION_TEST_ALLOW_SKIP cannot
 * turn it into a silent skip.
 */
function isDockerUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; syscall?: unknown; path?: unknown; message?: unknown };
  if (typeof e?.path === "string" || (typeof e?.syscall === "string" && e.syscall !== "connect")) return false;
  return /container runtime|docker/i.test(String(e?.message ?? err));
}

beforeAll(async () => {
  // Read this migration's files first: a missing file fails here, never as "Docker unavailable".
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1" || !isDockerUnavailable(err)) throw err;
    dockerSkipReason = String(err);
    return;
  }
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'imp-a', 'IMP A', 'EGP'), ($2, 'imp-b', 'IMP B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'A1', 'std', $4, $4), ($2, $5, 'B1', 'std', $4, $4)`,
    [PROD_A1, PROD_B1, TENANT_A, ACTOR, TENANT_B],
  );
  await a.query(upSql);
  // GRANT ON ALL TABLES again: the app role must see the new tables too.
  await a.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_test`);
  // A role holding exactly the production grants. Roles are cluster-wide: create it once.
  await a.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DOMAIN_ROLE}') THEN
       CREATE ROLE ${DOMAIN_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await a.query(`GRANT USAGE ON SCHEMA public TO ${DOMAIN_ROLE}`);
  await a.query(`GRANT SELECT ON tenants, tenant_products TO ${DOMAIN_ROLE}`);
  // Exactly the GRANT / REVOKE statements of the deploy script, as psql would run them.
  const statements = readFileSync(resolve(SQL_DIR, "catalog-import-domain-grants.sql"), "utf8")
    .split("\n")
    .filter((line) => /^(GRANT|REVOKE) /.test(line));
  expect(statements.length).toBe(4);
  for (const statement of statements) await a.query(statement.replace(/:"domain_role"/g, `"${DOMAIN_ROLE}"`));
  await seedBaseline();
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

describe("0124_catalog_import — shape", () => {
  it("creates the three tables and the Drizzle schema declares exactly their columns", async () => {
    if (skip()) return;
    const e = guard();
    const drizzle = Object.values(schema).filter((t) => {
      try {
        return (TABLES as readonly string[]).includes(getTableName(t as Parameters<typeof getTableName>[0]));
      } catch {
        return false;
      }
    }) as Parameters<typeof getTableColumns>[0][];
    expect(drizzle.map((t) => getTableName(t)).sort()).toEqual([...TABLES].sort());
    for (const t of drizzle) {
      const name = getTableName(t);
      const declared = Object.values(getTableColumns(t) as Record<string, { name: string; notNull: boolean }>)
        .map((c) => `${c.name}:${c.notNull ? "NO" : "YES"}`)
        .sort();
      const actual = await e.admin.query<{ c: string }>(
        `SELECT column_name || ':' || is_nullable AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY 1`,
        [name],
      );
      expect([name, actual.rows.map((r) => r.c).sort()]).toEqual([name, declared]);
    }
  });

  it("enables and FORCEs RLS with SELECT + INSERT + UPDATE everywhere and DELETE on the rows only", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of TABLES) {
      const rls = await e.admin.query<{ rel: boolean; force: boolean }>(
        `SELECT relrowsecurity AS rel, relforcerowsecurity AS force FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect([table, rls.rows[0]]).toEqual([table, { rel: true, force: true }]);
      const policies = await e.admin.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY cmd`,
        [table],
      );
      const expected = table === "catalog_import_rows" ? ["DELETE", "INSERT", "SELECT", "UPDATE"] : ["INSERT", "SELECT", "UPDATE"];
      expect([table, policies.rows.map((r) => r.cmd)]).toEqual([table, expected]);
    }
  });

  it("creates the one-open-batch, previous-publish and expiry indexes", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'catalog_import_batches' AND indexname LIKE '%x_catalog_import_batches_%'
        ORDER BY indexname`,
    );
    const defs = Object.fromEntries(r.rows.map((x) => [x.indexname, x.indexdef]));
    expect(Object.keys(defs)).toEqual([
      "ix_catalog_import_batches_expiry",
      "ix_catalog_import_batches_tenant_sha_published",
      "ux_catalog_import_batches_one_open",
    ]);
    expect(defs["ux_catalog_import_batches_one_open"]).toMatch(
      /CREATE UNIQUE INDEX .* \(tenant_id\) WHERE \(state = ANY \(ARRAY\['draft'::text, 'validated'::text, 'pending_approval'::text, 'approved'::text\]\)\)/,
    );
    expect(defs["ix_catalog_import_batches_tenant_sha_published"]).toMatch(/\(tenant_id, file_sha256, published_at\)$/);
    expect(defs["ix_catalog_import_batches_expiry"]).toMatch(
      /\(expires_at\) WHERE \(state = ANY \(ARRAY\['draft'::text, 'validated'::text\]\)\)/,
    );
  });
});

// -----------------------------------------------------------------------------
// Batches
// -----------------------------------------------------------------------------

describe("0124_catalog_import — batches", () => {
  it("allows one open batch per tenant; a closed batch frees the slot; other tenants are independent", async () => {
    if (skip()) return;
    await admin(async (c) => {
      // BATCH_A is open (draft): a second upload is the 409 import_batch_open.
      expect(await sp(c, () => insertBatch(c, id("0a2f1"), TENANT_A))).toBe("23505");
      // Validated still counts as open.
      await validate(c, BATCH_A);
      expect(await sp(c, () => insertBatch(c, id("0a2f1"), TENANT_A))).toBe("23505");
      // The reserved approval states count as open too.
      await c.query(`UPDATE catalog_import_batches SET state = 'pending_approval', expires_at = NULL WHERE id = $1`, [BATCH_A]);
      expect(await sp(c, () => insertBatch(c, id("0a2f1"), TENANT_A))).toBe("23505");
      await c.query(`UPDATE catalog_import_batches SET state = 'approved' WHERE id = $1`, [BATCH_A]);
      expect(await sp(c, () => insertBatch(c, id("0a2f1"), TENANT_A))).toBe("23505");
      // Cancelled: closed, so a new upload is accepted.
      await c.query(
        `UPDATE catalog_import_batches SET state = 'cancelled', preview_hash = NULL, closed_at = now() WHERE id = $1`,
        [BATCH_A],
      );
      expect(await sp(c, () => insertBatch(c, id("0a2f1"), TENANT_A))).toBeNull();
    });
  });

  it("creates a batch only as a draft at version 1, never validated, rows not purged", async () => {
    if (skip()) return;
    await admin(async (c) => {
      await c.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [BATCH_A]);
      const insert = (state: string, version: number, generation: number, purged: string | null): Promise<unknown> =>
        c.query(
          `INSERT INTO catalog_import_batches (id, tenant_id, state, version, validation_generation, rows_purged_at, mode, file_size,
             file_sha256, file_kind, csv_delimiter, data_row_count, column_count, parser_version, columns, created_by, expires_at,
             preview_hash, counts, mapping, closed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'create', 1, $7, 'csv', 'comma', 2, 2, 'p', $8, $9,
                   CASE WHEN $3 IN ('draft', 'validated') THEN now() END, CASE WHEN $3 = 'validated' THEN $10 END,
                   CASE WHEN $3 = 'validated' THEN $11::jsonb END, $12, CASE WHEN $3 = 'cancelled' THEN now() END)`,
          [id("0a2f3"), TENANT_A, state, version, generation, purged, SHA, COLUMNS, ACTOR, HASH, COUNTS, MAPPING],
        );
      expect(await sp(c, () => insert("validated", 1, 1, null))).toBe("23514");
      expect(await sp(c, () => insert("cancelled", 1, 0, null))).toBe("23514");
      expect(await sp(c, () => insert("draft", 2, 0, null))).toBe("23514");
      expect(await sp(c, () => insert("draft", 1, 1, null))).toBe("23514");
      expect(await sp(c, () => insert("cancelled", 1, 0, "2026-11-19T00:00:00Z"))).toBe("23514");
      expect(await sp(c, () => insert("draft", 1, 0, null))).toBeNull();
    });
  });

  it("keeps identity and mode fixed and moves version and validation generation only forward", async () => {
    if (skip()) return;
    await admin(async (c) => {
      for (const set of ["mode = 'create'", `tenant_id = '${TENANT_B}'`, "created_at = now() - interval '1 day'", "version = 0",
        "validation_generation = -1"]) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_batches SET ${set} WHERE id = $1`, [BATCH_A]))]).toEqual([
          set,
          "23514",
        ]);
      }
      await validate(c, BATCH_A);
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET validation_generation = 0 WHERE id = $1`, [BATCH_A]))).toBe("23514");
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET version = 1 WHERE id = $1`, [BATCH_A]))).toBe("23514");
    });
  });

  it("holds the lifecycle columns together: preview, closing, expiry and the publish summary", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const bad = [
        // A draft has no preview hash; a validated batch must have one.
        "preview_hash = 'sha256:" + "c".repeat(64) + "'",
        "state = 'validated', version = version + 1, validation_generation = 1, mapping = '[{\"columnNumber\":1,\"target\":\"sku\"}]'",
        // Closing needs closed_at and clears expires_at.
        "state = 'cancelled'",
        "state = 'cancelled', closed_at = now()",
        "state = 'expired', expires_at = NULL",
        // An open draft always expires.
        "expires_at = NULL",
        // Published only with published_at, the summary and a validation.
        "state = 'published', closed_at = now(), expires_at = NULL, published_at = now(), publish_summary = '{}'",
        // rows_purged_at only once closed.
        "rows_purged_at = now()",
      ];
      for (const set of bad) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_batches SET ${set} WHERE id = $1`, [BATCH_A]))]).toEqual([
          set,
          "23514",
        ]);
      }
      await validate(c, BATCH_A);
      const missing = await sp(c, () =>
        c.query(`UPDATE catalog_import_batches SET state = 'published', closed_at = now(), expires_at = NULL, published_at = now() WHERE id = $1`, [
          BATCH_A,
        ]),
      );
      expect(missing).toBe("23514");
      expect(await sp(c, () => publish(c, BATCH_A))).toBeNull();
    });
  });

  it("freezes a closed batch except rows_purged_at, which is set once", async () => {
    if (skip()) return;
    await admin(async (c) => {
      for (const set of ["file_name = 'other.csv'", "state = 'cancelled'", "warnings = '[{\"code\": \"x\"}]'", "version = version + 1"]) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_batches SET ${set} WHERE id = $1`, [BATCH_A_CLOSED]))]).toEqual([
          set,
          "23514",
        ]);
      }
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET rows_purged_at = now() WHERE id = $1`, [BATCH_A_CLOSED]))).toBeNull();
      expect(
        await sp(c, () =>
          c.query(`UPDATE catalog_import_batches SET rows_purged_at = now() + interval '1 minute' WHERE id = $1`, [BATCH_A_CLOSED]),
        ),
      ).toBe("23514");
    });
  });

  it("expires only through the conditional UPDATE bound to the version and the expiry instant", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const expire = `UPDATE catalog_import_batches SET state = 'expired', version = version + 1, expires_at = NULL, closed_at = now()
                       WHERE id = $1 AND state IN ('draft', 'validated') AND version = $2 AND expires_at <= now()`;
      // Not yet due.
      expect((await c.query(expire, [BATCH_A, 1])).rowCount).toBe(0);
      await c.query(`UPDATE catalog_import_batches SET expires_at = now() - interval '1 second' WHERE id = $1`, [BATCH_A]);
      // Changed since it was read (stale version).
      expect((await c.query(expire, [BATCH_A, 7])).rowCount).toBe(0);
      expect((await c.query(expire, [BATCH_A, 1])).rowCount).toBe(1);
      const r = await c.query<{ state: string; expires_at: Date | null; closed_at: Date | null }>(
        `SELECT state, expires_at, closed_at FROM catalog_import_batches WHERE id = $1`,
        [BATCH_A],
      );
      expect(r.rows[0]).toMatchObject({ state: "expired", expires_at: null });
      expect(r.rows[0]!.closed_at).not.toBeNull();
      // The sweep's partial index no longer holds the closed batch.
      const due = await c.query(`SELECT 1 FROM catalog_import_batches WHERE state IN ('draft', 'validated') AND expires_at <= now()`);
      expect(due.rowCount).toBe(0);
    });
  });

  it("stores warnings that never name the batch itself", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const self = JSON.stringify([{ code: "file_previously_published", publishedBatchId: BATCH_A, publishedAt: "2026-11-19T10:00:00Z" }]);
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET warnings = $2 WHERE id = $1`, [BATCH_A, self]))).toBe("23514");
      await c.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [BATCH_A]);
      const created = await sp(c, () =>
        insertBatch(c, id("0a2f4"), TENANT_A, {
          warnings: [{ code: "file_previously_published", publishedBatchId: id("0a2f4"), publishedAt: "2026-11-19T10:00:00Z" }],
        }),
      );
      expect(created).toBe("23514");
    });
  });

  it("stores mapping and suggested_mapping as the contract's ColumnMapping[]", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const bad = [
        "[]",
        '{"sku": 1}',
        '[{"columnNumber": 0, "target": "sku"}]',
        '[{"columnNumber": 51, "target": "sku"}]',
        '[{"columnNumber": 1.5, "target": "sku"}]',
        '[{"columnNumber": "1", "target": "sku"}]',
        '[{"columnNumber": 1, "target": "price_list"}]',
        '[{"target": "sku"}]',
        '[{"columnNumber": 1}]',
        // Non-object elements, also when a lax path would unwrap them.
        "[[]]",
        '[[{"columnNumber": 1, "target": "sku"}]]',
        "[1]",
        '["sku"]',
      ];
      for (const value of bad) {
        expect([value, await sp(c, () => c.query(`UPDATE catalog_import_batches SET mapping = $2 WHERE id = $1`, [BATCH_A, value]))]).toEqual([
          value,
          "23514",
        ]);
      }
      for (const value of bad.slice(1)) {
        expect([
          value,
          await sp(c, () => c.query(`UPDATE catalog_import_batches SET suggested_mapping = $2 WHERE id = $1`, [BATCH_A, value])),
        ]).toEqual([value, "23514"]);
      }
      const ok = '[{"columnNumber": 1, "target": "ignore"}, {"columnNumber": 2, "target": "barcode"}]';
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET mapping = $2, suggested_mapping = $2 WHERE id = $1`, [BATCH_A, ok]))).toBeNull();
      // A re-upload sets the mapping back to none.
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET mapping = NULL WHERE id = $1`, [BATCH_A]))).toBeNull();
    });
  });

  it("pins the mapping profile reference to the batch's tenant", async () => {
    if (skip()) return;
    await admin(async (c) => {
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET mapping_profile_id = $2 WHERE id = $1`, [BATCH_A, PROFILE_B]))).toBe(
        "23503",
      );
      expect(await sp(c, () => c.query(`UPDATE catalog_import_batches SET mapping_profile_id = NULL WHERE id = $1`, [BATCH_A]))).toBeNull();
    });
  });

  it("refuses DELETE and TRUNCATE of a batch for every role; the app role has no DELETE policy", async () => {
    if (skip()) return;
    const e = guard();
    await admin(async (c) => {
      expect(await sp(c, () => c.query(`DELETE FROM catalog_import_batches WHERE id = $1`, [BATCH_A_CLOSED]))).toBe("42501");
      expect(await sp(c, () => c.query(`TRUNCATE catalog_import_batches CASCADE`))).toBe("42501");
    });
    const deleted = await asApp(e, TENANT_A, (c) => c.query(`DELETE FROM catalog_import_batches`));
    expect(deleted.rowCount).toBe(0);
    const left = await e.admin.query(`SELECT 1 FROM catalog_import_batches`);
    expect(left.rowCount).toBe(3);
  });
});

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

describe("0124_catalog_import — rows", () => {
  it("pins a row to its batch's tenant and keeps one row per batch and row number", async () => {
    if (skip()) return;
    await admin(async (c) => {
      expect(await sp(c, () => insertRow(c, BATCH_A, TENANT_B, 5))).toBe("23503");
      expect(await sp(c, () => insertRow(c, BATCH_A, TENANT_A, 2))).toBe("23505");
      expect(await sp(c, () => insertRow(c, BATCH_A, TENANT_A, 1))).toBe("23514");
      expect(await sp(c, () => insertRow(c, BATCH_A, TENANT_A, 4))).toBeNull();
    });
  });

  it("keeps identity and cells fixed and holds the outcome and the review decision whole", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const where = `WHERE batch_id = '${BATCH_A}' AND row_number = 2`;
      for (const set of ["cells = '[\"x\"]'", "row_number = 9", `batch_id = '${BATCH_B}'`]) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_rows SET ${set} ${where}`))]).toEqual([set, "23514"]);
      }
      const bad = [
        "status = 'needs_review'", // no outcome
        "status = 'nope', outcome = '{}'",
        "review_reason = 'ambiguous'", // not validated
        "status = 'needs_review', outcome = '{}', review_reason = 'other'",
        "status = 'ready_update', outcome = '{}', resolution = 'update_product', resolved_by = gen_random_uuid(), resolved_at = now()",
        "status = 'excluded', outcome = '{}', resolution = 'exclude', resolved_at = now()",
        "status = 'excluded', outcome = '{}', resolution = 'exclude', resolved_by = gen_random_uuid(), resolved_at = now(), " +
          `resolution_product_id = '${PROD_A1}'`,
      ];
      for (const set of bad) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_rows SET ${set} ${where}`))]).toEqual([set, "23514"]);
      }
      // Another tenant's product is never a decision's product.
      const crossTenant =
        "status = 'ready_update', outcome = '{}', review_reason = 'ambiguous', resolution = 'update_product', " +
        `resolved_by = gen_random_uuid(), resolved_at = now(), resolution_product_id = '${PROD_B1}'`;
      expect(await sp(c, () => c.query(`UPDATE catalog_import_rows SET ${crossTenant} ${where}`))).toBe("23503");
      const decided = crossTenant.replace(PROD_B1, PROD_A1);
      expect(await sp(c, () => c.query(`UPDATE catalog_import_rows SET ${decided}, product_id = '${PROD_A1}' ${where}`))).toBeNull();
      // `clear`: back to the validated status, the review reason kept.
      const cleared = await sp(c, () =>
        c.query(
          `UPDATE catalog_import_rows SET status = 'needs_review', resolution = NULL, resolution_product_id = NULL, resolved_by = NULL,
                  resolved_at = NULL ${where}`,
        ),
      );
      expect(cleared).toBeNull();
    });
  });

  it("allows DELETE of a tenant's own rows (re-upload, purge) and of nobody else's", async () => {
    if (skip()) return;
    const e = guard();
    const other = await asApp(e, TENANT_B, (c) => c.query(`DELETE FROM catalog_import_rows WHERE batch_id = $1`, [BATCH_A]));
    expect(other.rowCount).toBe(0);
    const own = await asApp(e, TENANT_A, async (c) => {
      const r = await c.query(`DELETE FROM catalog_import_rows WHERE batch_id = $1`, [BATCH_A]);
      // The batch header stays.
      const batch = await c.query(`SELECT 1 FROM catalog_import_batches WHERE id = $1`, [BATCH_A]);
      expect(batch.rowCount).toBe(1);
      return r;
    });
    expect(own.rowCount).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Mapping profiles
// -----------------------------------------------------------------------------

describe("0124_catalog_import — mapping profiles", () => {
  it("saves under an existing name as an upsert that keeps the id", async () => {
    if (skip()) return;
    await admin(async (c) => {
      const upsert = await c.query<{ id: string; entries: Record<string, string> }>(
        `INSERT INTO catalog_import_mapping_profiles (id, tenant_id, name, entries, created_by, updated_by)
         VALUES ($1, $2, 'Supplier A', $3, $4, $4)
         ON CONFLICT (tenant_id, name) DO UPDATE SET entries = EXCLUDED.entries, updated_by = EXCLUDED.updated_by
         RETURNING id, entries`,
        [id("0a1f1"), TENANT_A, JSON.stringify({ Barcode: "barcode", Notes: "ignore" }), ACTOR],
      );
      expect(upsert.rows[0]).toEqual({ id: PROFILE_A, entries: { Barcode: "barcode", Notes: "ignore" } });
      // The same name in another tenant is another profile.
      expect(await sp(c, () => insertProfile(c, id("0b1f1"), TENANT_B, "Supplier A2"))).toBeNull();
      expect(await sp(c, () => insertProfile(c, id("0a1f2"), TENANT_A, "Supplier A"))).toBe("23505");
    });
  });

  it("never renames or re-keys a profile and refuses an empty or untrimmed header or an unknown target", async () => {
    if (skip()) return;
    await admin(async (c) => {
      for (const set of ["name = 'Renamed'", `id = '${id("0a1f3")}'`, `tenant_id = '${TENANT_B}'`]) {
        expect([set, await sp(c, () => c.query(`UPDATE catalog_import_mapping_profiles SET ${set} WHERE id = $1`, [PROFILE_A]))]).toEqual([
          set,
          "23514",
        ]);
      }
      for (const entries of [{}, { "": "sku" }, { " SKU": "sku" }, { "SKU ": "sku" }, { SKU: "price_list" }, { SKU: 1 }, { SKU: [] }, { SKU: ["sku"] }, { SKU: { t: "sku" } }]) {
        const code = await sp(c, () => insertProfile(c, id("0a1f4"), TENANT_A, "Bad", entries));
        expect([entries, code]).toEqual([entries, "23514"]);
      }
      expect(await sp(c, () => insertProfile(c, id("0a1f4"), TENANT_A, "  ", { SKU: "sku" }))).toBe("23514");
      expect(await sp(c, () => insertProfile(c, id("0a1f4"), TENANT_A, "عربي", { "رقم الصنف": "sku", "  x y": "name" }))).toBe("23514");
      expect(await sp(c, () => insertProfile(c, id("0a1f4"), TENANT_A, "عربي", { "رقم الصنف": "sku", "x y": "name" }))).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// Isolation and production grants
// -----------------------------------------------------------------------------

describe("0124_catalog_import — isolation and production grants", () => {
  it("shows each tenant only its own rows and nothing without a tenant (empty GUC)", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of TABLES) {
      const a = await asApp(e, TENANT_A, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, a.rows.map((r) => r.t)]).toEqual([table, [TENANT_A]]);
      const b = await asApp(e, TENANT_B, (c) => c.query<{ t: string }>(`SELECT DISTINCT tenant_id::text AS t FROM ${table}`));
      expect([table, b.rows.map((r) => r.t)]).toEqual([table, [TENANT_B]]);
      const none = await asApp(e, "", (c) => c.query(`SELECT 1 FROM ${table}`));
      expect([table, none.rowCount]).toEqual([table, 0]);
    }
  });

  it("refuses a write into another tenant and never updates another tenant's batch", async () => {
    if (skip()) return;
    const e = guard();
    expect(await asApp(e, TENANT_A, (c) => errorCode(() => insertProfile(c, id("0b1f2"), TENANT_B, "X")))).toBe("42501");
    const updated = await asApp(e, TENANT_A, (c) =>
      c.query(`UPDATE catalog_import_batches SET file_name = 'x.csv' WHERE id = $1`, [BATCH_B]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("runs a whole upload, map, validate, review, publish and purge as a role holding exactly the production grants", async () => {
    if (skip()) return;
    const failed = await asDomain((c) =>
      errorCode(async () => {
        await c.query(
          `INSERT INTO catalog_import_mapping_profiles (id, tenant_id, name, entries, created_by, updated_by)
           VALUES ($1, $2, 'Supplier A', $3, $4, $4)
           ON CONFLICT (tenant_id, name) DO UPDATE SET entries = EXCLUDED.entries, updated_by = EXCLUDED.updated_by`,
          [id("0a1f5"), TENANT_A, JSON.stringify({ SKU: "sku" }), ACTOR],
        );
        // The open batch is cancelled, then a new upload.
        await c.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [
          BATCH_A,
        ]);
        await insertBatch(c, id("0a2f5"), TENANT_A, { profile: PROFILE_A });
        await insertRow(c, id("0a2f5"), TENANT_A, 2);
        // A re-upload replaces the rows.
        await c.query(`DELETE FROM catalog_import_rows WHERE batch_id = $1`, [id("0a2f5")]);
        await insertRow(c, id("0a2f5"), TENANT_A, 2);
        await c.query(`UPDATE catalog_import_batches SET mapping = $2, version = version + 1 WHERE id = $1`, [id("0a2f5"), MAPPING]);
        await validate(c, id("0a2f5"));
        const reviewed = await c.query(
          `UPDATE catalog_import_rows SET status = 'ready_create', outcome = '{}', resolution = 'create_new', resolved_by = $2,
                  resolved_at = now() WHERE batch_id = $1`,
          [id("0a2f5"), ACTOR],
        );
        if (reviewed.rowCount !== 1) throw new Error(`review decision updated ${reviewed.rowCount} row(s)`);
        await publish(c, id("0a2f5"));
        const provenance = await c.query(`UPDATE catalog_import_rows SET product_id = $2 WHERE batch_id = $1`, [id("0a2f5"), PROD_A1]);
        if (provenance.rowCount !== 1) throw new Error(`provenance updated ${provenance.rowCount} row(s)`);
        const saved = await c.query<{ resolution: string; product_id: string; state: string }>(
          `SELECT r.resolution, r.product_id, b.state FROM catalog_import_rows r
             JOIN catalog_import_batches b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id WHERE r.batch_id = $1`,
          [id("0a2f5")],
        );
        expect(saved.rows).toEqual([{ resolution: "create_new", product_id: PROD_A1, state: "published" }]);
        // The purge: rows of a closed batch go, the header records it.
        await c.query(`DELETE FROM catalog_import_rows WHERE batch_id = $1`, [BATCH_A]);
        await c.query(`UPDATE catalog_import_batches SET rows_purged_at = now() WHERE id = $1`, [BATCH_A]);
      }),
    );
    expect(failed).toBeNull();
    // No DELETE on the batches or the profiles, and no TRUNCATE anywhere.
    for (const statement of [
      `DELETE FROM catalog_import_batches WHERE id = '${BATCH_A}'`,
      `DELETE FROM catalog_import_mapping_profiles WHERE id = '${PROFILE_A}'`,
      `TRUNCATE catalog_import_rows`,
    ]) {
      expect([statement, await asDomain((c) => errorCode(() => c.query(statement)))]).toEqual([statement, "42501"]);
    }
  });
});

// -----------------------------------------------------------------------------
// Rollback
// -----------------------------------------------------------------------------

describe("0124_catalog_import — down migration", () => {
  const OWNER_TABLES = [...TABLES, "tenants"];

  async function runFileWithEmptyGuc(path: string, role: string): Promise<string | null> {
    const client = await guard().admin.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      await client.query(`SELECT set_config('app.current_tenant', '', false)`);
      return await errorCode(() => client.query(readFileSync(path, "utf8")));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("RESET app.current_tenant").catch(() => undefined);
      client.release();
    }
  }

  it("REFUSES while a batch or a mapping profile exists, also as a NOSUPERUSER owner under FORCE RLS", async () => {
    if (skip()) return;
    const e = guard();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    const owner = { role: "rt1503_refuse_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      // A batch alone (no profile, no row) blocks it.
      await clearImport();
      expect(await committed((c) => insertBatch(c, BATCH_A, TENANT_A))).toBeNull();
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
      // A mapping profile alone still blocks it.
      await clearImport();
      expect(await committed((c) => insertProfile(c, PROFILE_A, TENANT_A))).toBeNull();
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBe("P0001");
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
  });

  it("drops the tables and functions once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await clearImport();
    const owner = { role: "rt1503_down_owner", tables: OWNER_TABLES, functions: FUNCTIONS };
    await asMigrationOwner(e, owner, async () => {
      expect(await runFileWithEmptyGuc(DOWN_PATH, owner.role)).toBeNull();
    });
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, false]);
    const fns = await e.admin.query(`SELECT 1 FROM pg_proc WHERE proname = ANY($1)`, [FUNCTIONS.map((f) => f.replace(/\(.*\)$/, ""))]);
    expect(fns.rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    for (const table of TABLES) expect([table, await exists(table)]).toEqual([table, true]);
    const policies = await e.admin.query(`SELECT 1 FROM pg_policies WHERE tablename = ANY($1)`, [[...TABLES]]);
    expect(policies.rowCount).toBe(10);
  });
});
