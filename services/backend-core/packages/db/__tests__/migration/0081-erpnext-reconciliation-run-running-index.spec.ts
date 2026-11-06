/**
 * 0081 - the per-store running stock-run index (Jira RT-185; [GATED] approval:
 * Jira RT-185 comment 15728). Read by the scheduled stock-run sweep's probe
 * (apps/worker/src/erpnext-reconciliation/stock-run-sweep.repository.ts,
 * sweepStore): is a `running` stock run already open for this store?
 *
 * Applies every migration before 0081 against a real Postgres, seeds a run
 * history (many terminal runs, a few running ones) for two tenants, then
 * applies 0081 exactly as the runner does (one `query()` for the file), and
 * proves:
 *   - the file is a single CONCURRENTLY statement with no transaction control,
 *     so the runner never wraps the build in a transaction block;
 *   - the index is valid, partial on status = 'running', with the RT-185 columns;
 *   - before the build the sweep probe cannot use it; after the build the probe
 *     (SQL as in the repository), the RT-688 expiry read and the warehouse-map
 *     retirement's in-flight read use it, run as the app role under RLS with the
 *     tenant GUC set (as runWithTenantContext does), and return the same rows;
 *   - down drops only this index, keeps every run row, and round-trips.
 */
import { readFileSync } from "node:fs";

import type { PoolClient } from "pg";

import { stockRunReportCompleteSql } from "../../src/helpers/stock-reconciliation-run";
import { startEnvBefore } from "../_helpers/migration-before";
import { asApp } from "../_helpers/migration-spec";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import {
  expectSingleConcurrentStatement,
  indexState as readIndexState,
  migrationPath,
} from "../_helpers/concurrent-index-migration";

const MIGRATION_ID = "0081_erpnext_reconciliation_run_running_idx";
const INDEX = "idx_erpnext_reconciliation_run_tenant_store_running";
const HISTORY_INDEX = "idx_erpnext_reconciliation_run_tenant_time";

const TENANT_A = "0a000000-0000-7000-8000-000000185a01";
const TENANT_B = "0b000000-0000-7000-8000-000000185b01";
const STORES = 30;
/** Store `n` (1-based) of a tenant, a deterministic UUID. */
const storeOf = (tenantPrefix: "0a" | "0b", n: number): string =>
  `${tenantPrefix}000000-0000-7000-8000-${String(185_000_000 + n).padStart(12, "0")}`;
const A_RUNNING = storeOf("0a", 1);
const A_STALE = storeOf("0a", 2);
const A_IDLE = storeOf("0a", 3);

const up = migrationPath(MIGRATION_ID, "up");
const down = migrationPath(MIGRATION_ID, "down");
const read = (path: string): string => readFileSync(path, "utf8");

type Query = { readonly name: string; readonly sql: string; readonly params: readonly unknown[] };

/** The sweep probe, as stock-run-sweep.repository.ts sweepStore issues it. */
const sweepProbe = (storeId: string): Query => ({
  name: `sweep probe ${storeId}`,
  sql: `SELECT id FROM erpnext_reconciliation_run
            WHERE tenant_id = $1 AND store_id = $2
              AND kind = 'stock' AND status = 'running'
            ORDER BY started_at
            LIMIT 1`,
  params: [TENANT_A, storeId],
});

/** The RT-688 expiry read, as stock-run-sweep.repository.ts expireStaleRuns issues it. */
const expiryRead: Query = {
  name: "expiry read",
  sql: `SELECT run.id FROM erpnext_reconciliation_run run
            WHERE run.tenant_id = $1
              AND run.kind = 'stock' AND run.status = 'running'
              AND run.started_at < $2
              AND NOT ${stockRunReportCompleteSql("run")}
            ORDER BY run.started_at, run.id`,
  params: [TENANT_A, new Date(Date.now() - 2 * 60 * 60 * 1000)],
};

/** The in-flight read of erpnext-warehouse-map.service.ts failInFlightStockRuns (tenant from RLS only). */
const inFlightRead: Query = {
  name: "warehouse-map in-flight read",
  sql: `SELECT id FROM erpnext_reconciliation_run
        WHERE store_id = $1 AND kind = 'stock' AND status = 'running'
        ORDER BY started_at, id`,
  params: [A_RUNNING],
};

const QUERIES: readonly Query[] = [
  sweepProbe(A_RUNNING),
  sweepProbe(A_STALE),
  sweepProbe(A_IDLE),
  expiryRead,
  inFlightRead,
];

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

async function planOf(client: PoolClient, q: Query): Promise<string> {
  const r = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${q.sql}`, [
    ...q.params,
  ]);
  return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
}

/** Plan and rows of `q` as the app role under tenant A's RLS context (rolled back and released). */
const asTenantA = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => asApp(pg(), TENANT_A, fn);
const planAsTenantA = (q: Query): Promise<string> => asTenantA((c) => planOf(c, q));
const rowsAsTenantA = (q: Query): Promise<string[]> =>
  asTenantA(async (c) => (await c.query<{ id: string }>(q.sql, [...q.params])).rows.map((r) => r.id));

const indexState = (name: string) => readIndexState(pg().admin, name);

async function countRuns(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_reconciliation_run`,
  );
  return r.rows[0]!.n;
}

async function seed(admin: PgTestEnv["admin"]): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES
       ($1, 'rt185-a', 'A', 'active'), ($2, 'rt185-b', 'B', 'active')`,
    [TENANT_A, TENANT_B],
  );
  for (const [tenant, prefix] of [[TENANT_A, "0a"], [TENANT_B, "0b"]] as const) {
    const ids = Array.from({ length: STORES }, (_, i) => storeOf(prefix, i + 1));
    await admin.query(
      `INSERT INTO stores (id, tenant_id, code, name, is_active)
       SELECT s.id, $2::uuid, 'S' || s.n, 'Store ' || s.n, true
         FROM unnest($1::uuid[]) WITH ORDINALITY AS s(id, n)`,
      [ids, tenant],
    );
    // Terminal history: one run per store per hour, spread over the stores.
    await admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       SELECT gen_random_uuid(), $1::uuid, ($2::uuid[])[1 + g % $3], 'stock', 'scheduled',
              CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'completed' END,
              now() - g * interval '1 hour', now() - g * interval '1 hour' + interval '5 minutes'
         FROM generate_series(1, $4::int) g`,
      [tenant, ids, STORES, tenant === TENANT_A ? 20_000 : 5_000],
    );
  }
  // The few running runs: A store 1 (fresh), A store 2 (past the 2 h TTL), B store 1.
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, started_at)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'scheduled', 'running', now() - interval '10 minutes'),
            (gen_random_uuid(), $1, $3, 'stock', 'on_demand', 'running', now() - interval '3 hours'),
            (gen_random_uuid(), $4, $5, 'stock', 'scheduled', 'running', now() - interval '10 minutes')`,
    [TENANT_A, A_RUNNING, A_STALE, TENANT_B, storeOf("0b", 1)],
  );
  await admin.query("ANALYZE erpnext_reconciliation_run");
}

const plansBefore = new Map<string, string>();
const rowsBefore = new Map<string, string[]>();

beforeAll(async () => {
  env = await startEnvBefore(`${MIGRATION_ID}.sql`, "0081-erpnext-reconciliation-run-running-index.spec");
  if (!env) return;
  await seed(env.admin);
  for (const q of QUERIES) {
    plansBefore.set(q.name, await planAsTenantA(q));
    rowsBefore.set(q.name, await rowsAsTenantA(q));
  }
  // One query() for the file, exactly as the runner sends it. No transaction is
  // open here: the helpers above roll back and release their clients.
  await env.admin.query(read(up));
  await env.admin.query("ANALYZE erpnext_reconciliation_run");
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0081 - single CONCURRENTLY statement", () => {
  it("up and down are one statement with no transaction control", () => {
    [up, down].forEach(expectSingleConcurrentStatement);
  });
});

describe("0081 - the RT-185 running-run index", () => {
  it("is valid, partial on status = 'running', with the RT-185 columns", async () => {
    if (skip()) return;
    expect(await indexState(INDEX)).toEqual({
      valid: true,
      def: `CREATE INDEX ${INDEX} ON public.erpnext_reconciliation_run USING btree (tenant_id, store_id, started_at) WHERE (status = 'running'::text)`,
    });
  });

  it("seeds the expected running rows (the probe finds the running stores only)", () => {
    if (skip()) return;
    expect(rowsBefore.get(sweepProbe(A_RUNNING).name)).toHaveLength(1);
    expect(rowsBefore.get(sweepProbe(A_STALE).name)).toHaveLength(1);
    expect(rowsBefore.get(sweepProbe(A_IDLE).name)).toEqual([]);
    expect(rowsBefore.get(expiryRead.name)).toHaveLength(1);
    expect(rowsBefore.get(inFlightRead.name)).toHaveLength(1);
  });

  it.each(QUERIES.map((q) => [q.name, q] as const))(
    "%s: before the build cannot use the index; after it uses it, as the app role under RLS",
    async (_name, q) => {
      if (skip()) return;
      expect(plansBefore.get(q.name)).not.toContain(`"Index Name":"${INDEX}"`);
      expect(await planAsTenantA(q)).toContain(`"Index Name":"${INDEX}"`);
    },
  );

  it.each(QUERIES.map((q) => [q.name, q] as const))(
    "%s: returns the same rows after the build as before",
    async (_name, q) => {
      if (skip()) return;
      expect(await rowsAsTenantA(q)).toEqual(rowsBefore.get(q.name));
    },
  );
});

describe("0081 - down -> up round-trip", () => {
  it("down drops only this index, keeps every run row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await countRuns();
    await pg().admin.query(read(down));
    expect(await indexState(INDEX)).toBeNull();
    // The 0020 history index is untouched by the down.
    expect((await indexState(HISTORY_INDEX))?.valid).toBe(true);
    expect(await countRuns()).toBe(before);
    await pg().admin.query(read(up));
    expect((await indexState(INDEX))?.valid).toBe(true);
  });
});
