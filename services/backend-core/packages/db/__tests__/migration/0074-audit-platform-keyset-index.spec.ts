/**
 * 0074 - the platform-scope audit keyset index (Jira RT-808; [GATED] approval:
 * Jira RT-808 comment 13356). Read by listPlatformAuditEvents (RT-431): the
 * tenant-less audit rows (tenant_id IS NULL) newest first in keyset order
 * (occurred_at DESC, id DESC), under the platform-admin context.
 *
 * Applies every migration before 0074 against a real Postgres, seeds a
 * tenant-less bucket plus a tenant's rows, then applies 0074 exactly as the
 * runner does (one `query()` for the file), and proves:
 *   - the file is a single CONCURRENTLY statement with no transaction control,
 *     so the runner never wraps the build in a transaction block;
 *   - the index is valid, partial on tenant_id IS NULL, with the RT-808 columns;
 *   - before the build the platform read needs a Sort; after it the first page
 *     and a keyset page are served by the index with no Sort, under RLS as the
 *     platform admin, and the pages returned are identical;
 *   - down drops only this index, keeps every audit row, and round-trips.
 *
 * The seeded volume here is small; the 400k-row EXPLAIN (ANALYZE, BUFFERS)
 * numbers are in the RT-808 PR. Fresh install through the real runner is
 * covered by the migrate CLI spec and the migration registry.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  expectSingleConcurrentStatement,
  indexState as readIndexState,
  migrationPath,
} from "../_helpers/concurrent-index-migration";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const MIGRATION_ID = "0074_audit_events_platform_keyset_idx";
const FIRST_NAME = `${MIGRATION_ID}.sql`;
const INDEX = "audit_events_platform_time_idx";
const TENANT_INDEX = "audit_events_tenant_time_idx";

const TENANT = "0a000000-0000-7000-8000-000000808001";
const NIL_TENANT = "00000000-0000-0000-0000-000000000000";
const PAGE = 51;
/** A Sort node, plain or incremental (a presorted prefix still sorts the rest). */
const SORT_NODE = /"Node Type":"(Incremental )?Sort"/;

const up = migrationPath(MIGRATION_ID, "up");
const down = migrationPath(MIGRATION_ID, "down");

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");
const skip = (): boolean => env === null;

async function applyBefore0074(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(FIRST_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

/** Run `fn` as the app role in the platform-admin context (no tenant), then roll back. */
async function asPlatformAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pg().app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [NIL_TENANT]);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

type Query = { readonly sql: string; readonly params: readonly unknown[] };

/** The listPlatformAuditEvents read (RT-431): first page, or the page after a keyset position. */
function platformQuery(after: { readonly at: string; readonly id: string } | null): Query {
  return {
    sql: `SELECT e.id, e.occurred_at FROM audit_events e
           WHERE e.tenant_id IS NULL
             AND ($1::timestamptz IS NULL OR (
                   (e.occurred_at, e.id) < ($1::timestamptz, $2::uuid)
                   AND e.occurred_at < $1::timestamptz + interval '1 millisecond'))
           ORDER BY e.occurred_at DESC, e.id DESC
           LIMIT ${PAGE}`,
    params: [after?.at ?? null, after?.id ?? null],
  };
}

async function planOf(client: PoolClient, q: Query): Promise<string> {
  const r = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${q.sql}`, [
    ...q.params,
  ]);
  return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
}

const platformPlan = (after: { at: string; id: string } | null): Promise<string> =>
  asPlatformAdmin((c) => planOf(c, platformQuery(after)));

const platformPage = (after: { at: string; id: string } | null): Promise<string[]> =>
  asPlatformAdmin(async (c) => {
    const q = platformQuery(after);
    const r = await c.query<{ id: string }>(q.sql, [...q.params]);
    return r.rows.map((row) => row.id);
  });

/** The keyset position of the 20th row of the first platform page. */
async function keysetAfter(): Promise<{ at: string; id: string }> {
  return asPlatformAdmin(async (c) => {
    const q = platformQuery(null);
    const r = await c.query<{ id: string; at: string }>(
      `SELECT id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM (${q.sql}) p OFFSET 19 LIMIT 1`,
      [...q.params],
    );
    return r.rows[0]!;
  });
}

const indexState = (name: string) => readIndexState(pg().admin, name);

async function countAuditRows(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
  return r.rows[0]!.n;
}

let keyset: { at: string; id: string };
let firstBefore: string[] = [];
let keysetBefore: string[] = [];
let plansBefore: string[] = [];

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0074-audit-platform-keyset-index.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0074(env);
  await env.admin.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, 'RT-808 tenant', 'rt808-tenant')`,
    [TENANT],
  );
  // Rows existing BEFORE the build (the upgrade path): a tenant-less bucket
  // spread over 90 days, plus one tenant's rows sharing the table.
  await env.admin.query(
    `INSERT INTO audit_events (id, occurred_at, actor_label, tenant_id, action)
     SELECT gen_random_uuid(), now() - (random() * interval '90 days'), 'platform', NULL,
            'auth.platform_sign_in'
       FROM generate_series(1, 30000)`,
  );
  await env.admin.query(
    `INSERT INTO audit_events (id, occurred_at, actor_label, tenant_id, action)
     SELECT gen_random_uuid(), now() - (random() * interval '90 days'), 'user', $1::uuid,
            'stores.update'
       FROM generate_series(1, 10000)`,
    [TENANT],
  );
  await env.admin.query("ANALYZE audit_events");

  keyset = await keysetAfter();
  firstBefore = await platformPage(null);
  keysetBefore = await platformPage(keyset);
  plansBefore = [await platformPlan(null), await platformPlan(keyset)];
  // One query() for the file, exactly as the runner sends it.
  await env.admin.query(read(up));
  await env.admin.query("ANALYZE audit_events");
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0074 - single CONCURRENTLY statement", () => {
  it("up and down are one statement with no transaction control", () => {
    [up, down].forEach(expectSingleConcurrentStatement);
  });
});

describe("0074 - the RT-808 platform keyset index", () => {
  it("is valid, partial on tenant_id IS NULL, with the keyset columns", async () => {
    if (skip()) return;
    expect(await indexState(INDEX)).toEqual({
      valid: true,
      def: `CREATE INDEX ${INDEX} ON public.audit_events USING btree (occurred_at DESC, id DESC) WHERE (tenant_id IS NULL)`,
    });
  });

  it.each([[0], [1]])(
    "before the build the platform read (page %i) cannot use the index and sorts",
    (i) => {
      if (skip()) return;
      expect(plansBefore[i]).not.toContain(`"Index Name":"${INDEX}"`);
      expect(plansBefore[i]).toMatch(SORT_NODE);
    },
  );

  it("after the build the first page and a keyset page are index-ordered with no Sort", async () => {
    if (skip()) return;
    for (const after of [null, keyset]) {
      const plan = await platformPlan(after);
      expect(plan).toContain(`"Index Name":"${INDEX}"`);
      expect(plan).not.toMatch(SORT_NODE);
    }
  });

  it("the platform read returns the same pages after the build as before", async () => {
    if (skip()) return;
    const first = await platformPage(null);
    expect(first).toHaveLength(PAGE);
    expect(first).toEqual(firstBefore);
    expect(await platformPage(keyset)).toEqual(keysetBefore);
  });
});

describe("0074 - down -> up round-trip", () => {
  it("down drops only this index, keeps every audit row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await countAuditRows();
    await pg().admin.query(read(down));
    expect(await indexState(INDEX)).toBeNull();
    // The 0000 tenant index is untouched by the down.
    expect((await indexState(TENANT_INDEX))?.valid).toBe(true);
    expect(await countAuditRows()).toBe(before);
    await pg().admin.query(read(up));
    expect((await indexState(INDEX))?.valid).toBe(true);
  });
});
