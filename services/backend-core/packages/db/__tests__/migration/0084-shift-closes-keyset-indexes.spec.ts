/**
 * 0084-0085 - the admin shift-close list keyset indexes (Jira RT-429; [GATED]
 * approval: Jira RT-429 comment 15731). Read by the RT-383 list
 * (GET /api/v1/shift-closes): a tenant's closes newest first in keyset order
 * (closed_at DESC, shift_id DESC), tenant-wide or for one store.
 *
 * Applies every migration before 0084 against a real Postgres, seeds closes
 * over many stores of one tenant plus a second tenant, then applies 0084-0085
 * exactly as the runner does (one `query()` per file), and proves:
 *   - each file is a single CONCURRENTLY statement with no transaction control,
 *     so the runner never wraps the build in a transaction block;
 *   - each index is valid with the RT-429 column list and order;
 *   - before the build the list sorts; after it, as the app role under tenant
 *     RLS, the tenant-wide first page, a cursor page and a single-store page
 *     (unscoped, and a store-scoped user filtering one store) are served by an
 *     RT-429 index with no Sort node, and every page is identical to before;
 *   - the multi-store-scoped list (store_id = ANY($2), no store filter) is NOT
 *     asserted to avoid a Sort: owner-approved as expected (RT-429 comment
 *     15731). Only its pages are compared;
 *   - each down drops only its own index, keeps idx_shift_closes_tenant_store
 *     and every close row, and round-trips with up.
 *
 * LIST_SQL below is the RT-383 list query of
 * apps/api/src/shift-closes/shift-closes.service.ts (CLOSE_FROM, WHERE, ORDER
 * BY and LIMIT copied verbatim; only the select list is reduced, which does not
 * change the plan's shape). The params are bound in the service's slot order,
 * as an unnamed statement, so each EXPLAIN is the custom plan the API gets.
 * The plans are printed (EXPLAIN ANALYZE, BUFFERS) as the RT-429 evidence.
 * Fresh install through the real runner is covered by the migrate CLI spec and
 * the migration registry.
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
import { withTenant } from "../_helpers/migration-sql";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const FIRST_NAME = "0084_shift_closes_tenant_closed_idx.sql";

/** The two RT-429 migrations: [id, index name, expected definition]. */
const MIGRATION_ROWS = [
  [
    "0084_shift_closes_tenant_closed_idx",
    "idx_shift_closes_tenant_closed",
    "(tenant_id, closed_at DESC, shift_id DESC)",
  ],
  [
    "0085_shift_closes_tenant_store_closed_idx",
    "idx_shift_closes_tenant_store_closed",
    "(tenant_id, store_id, closed_at DESC, shift_id DESC)",
  ],
] as const;
const MIGRATIONS = MIGRATION_ROWS.map(([id, index, def]) => ({ id, index, def }));
const TENANT_INDEX = MIGRATION_ROWS[0][1];
const STORE_INDEX = MIGRATION_ROWS[1][1];
/** The 0036 index, kept by the owner's decision. */
const KEPT_INDEX = "idx_shift_closes_tenant_store";

const up = (id: string): string => migrationPath(id, "up");
const down = (id: string): string => migrationPath(id, "down");

const TENANT = "0a000000-0000-7000-8000-000000429001";
const TENANT_2 = "0a000000-0000-7000-8000-000000429002";
const USER = "0a000000-0000-7000-8000-000000429003";
const STORE_COUNT = 20;
const CLOSES = 24_000;
const CLOSES_T2 = 6_000;
/** The API reads limit + 1 rows (50 + 1). */
const LIMIT = 51;
/** A Sort node, plain or incremental (a presorted prefix still sorts the rest). */
const SORT_NODE = /"Node Type":"(Incremental )?Sort"/;

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

const read = (path: string): string => readFileSync(path, "utf8");
const skip = (): boolean => env === null;

async function applyBefore0084(pgEnv: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(FIRST_NAME) < 0)
    .sort();
  for (const name of files) {
    await pgEnv.admin.query(read(resolve(DRIZZLE_DIR, name)));
  }
  await ensureAppRole(pgEnv);
}

/**
 * Bulk seed: per tenant, stores with one device each, `n` closed cash-up shifts
 * spread over a year, and their closes. Triggers are bypassed for the bulk load
 * only (session_replication_role = replica: the close guard needs an open shift
 * and the one-open-shift-per-device index would force a device per shift); the
 * rows satisfy every CHECK, and the closes' FK targets exist. closed_at is
 * truncated to the minute so ties exercise the shift_id tie-break.
 */
async function seedTenant(tenantId: string, slug: string, stores: number, n: number): Promise<void> {
  const client = await pg().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [tenantId, slug]);
    await client.query(
      `INSERT INTO stores (id, tenant_id, code, name)
       SELECT gen_random_uuid(), $1, $2 || '-s' || lpad(g::text, 2, '0'), $2 || ' store ' || g
         FROM generate_series(1, $3) g`,
      [tenantId, slug, stores],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, store_id, token_hash)
       SELECT gen_random_uuid(), s.tenant_id, s.id, sha256(convert_to(s.id::text, 'UTF8'))
         FROM stores s WHERE s.tenant_id = $1`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO shifts (shift_id, tenant_id, store_id, opening_cashier_user_id, opening_device_id,
                           opened_at, lifecycle_state, source, currency_code, opening_float,
                           business_date, received_at, recorded_by_user_id, payload_hash)
       SELECT x.shift_id, $1, d.store_id, $2, d.id, x.opened_at, 'closed', 'cash_up', 'EGP', 500.00,
              x.opened_at::date, x.opened_at, $2, sha256(convert_to('open:' || x.shift_id, 'UTF8'))
         FROM (SELECT gen_random_uuid() AS shift_id, g,
                      date_trunc('minute', now() - random() * interval '365 days') AS opened_at
                 FROM generate_series(1, $3) g) x
         JOIN (SELECT id, store_id, row_number() OVER (ORDER BY store_id) - 1 AS k
                 FROM devices WHERE tenant_id = $1) d
           ON d.k = x.g % $4`,
      [tenantId, USER, n, stores],
    );
    // Amounts as the 0050 spec's closes: expected 2755.00, counted 2750.00.
    await client.query(
      `INSERT INTO shift_closes
         (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
          close_kind, opening_float, cash_sales_total, cash_refunds_total, pay_in_total,
          pay_out_total, expected_cash, counted_cash, variance, sale_count, recorded_by_user_id,
          payload_hash)
       SELECT s.shift_id, s.tenant_id, s.store_id, s.opening_device_id, 'EGP',
              s.opened_at + interval '8 hours', $2, 'normal', 500.00, 2450.00, 75.00, 0.00,
              120.00, 2755.00, 2750.00, -5.00, 37, $2,
              sha256(convert_to('close:' || s.shift_id, 'UTF8'))
         FROM shifts s WHERE s.tenant_id = $1`,
      [tenantId, USER],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** The tenant's store ids by code. */
async function storesOf(tenantId: string): Promise<string[]> {
  const r = await pg().admin.query<{ id: string }>(
    `SELECT id FROM stores WHERE tenant_id = $1 ORDER BY code`,
    [tenantId],
  );
  return r.rows.map((row) => row.id);
}

/**
 * RT-383 LIST_SQL (shift-closes.service.ts): $1 tenant, $2 scoped store ids
 * (null = tenant-wide), $3 store filter, $4 closed_from, $5 closed_to, $6 close
 * kind, $7 min |variance|, $8 currency, $9 approval, $10 / $11 keyset
 * (closed_at, shift_id), $12 limit, $13 approval_required, $14
 * approval_missing, $15 approver_check.
 */
const LIST_SQL = `
  SELECT c.shift_id,
         to_char(c.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS closed_at_key
    FROM shift_closes c
    JOIN shifts s
      ON s.shift_id = c.shift_id AND s.tenant_id = c.tenant_id AND s.store_id = c.store_id
    LEFT JOIN shift_close_approver_checks v
      ON v.shift_id = c.shift_id AND v.tenant_id = c.tenant_id
   WHERE c.tenant_id = $1::uuid
     AND ($2::uuid[] IS NULL OR c.store_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR c.store_id = $3::uuid)
     AND ($4::timestamptz IS NULL OR c.closed_at >= $4::timestamptz)
     AND ($5::timestamptz IS NULL OR c.closed_at < $5::timestamptz)
     AND ($6::text IS NULL OR c.close_kind = $6::text)
     AND ($7::numeric IS NULL OR abs(c.variance) >= $7::numeric)
     AND ($8::text IS NULL OR c.currency_code = $8::text)
     AND ($9::text IS NULL
          OR ($9::text = 'approved') = (c.variance_approved_by_user_id IS NOT NULL))
     AND ($13::text IS NULL OR c.approval_required_by_policy = $13::text)
     AND ($14::text IS NULL OR c.approval_missing = $14::text)
     AND ($15::text IS NULL OR CASE WHEN c.variance_approved_by_user_id IS NULL THEN 'not_applicable'
            ELSE COALESCE(v.status, 'unverified') END = $15::text)
     AND ($10::timestamptz IS NULL OR (c.closed_at, c.shift_id) < ($10::timestamptz, $11::uuid))
   ORDER BY c.closed_at DESC, c.shift_id DESC
   LIMIT $12`;

type Keyset = { readonly at: string; readonly id: string };

interface Case {
  readonly name: string;
  readonly scope: readonly string[] | null;
  readonly store: string | null;
  /** The RT-429 indexes allowed to serve it with no Sort; empty = not asserted. */
  readonly served: readonly string[];
}

function paramsOf(c: Case, after: Keyset | null): unknown[] {
  return [
    TENANT,
    c.scope === null ? null : [...c.scope],
    c.store,
    null,
    null,
    null,
    null,
    null,
    null,
    after?.at ?? null,
    after?.id ?? null,
    LIMIT,
    null,
    null,
    null,
  ];
}

async function planOf(client: PoolClient, c: Case, after: Keyset | null): Promise<string> {
  const r = await client.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (FORMAT JSON) ${LIST_SQL}`,
    paramsOf(c, after),
  );
  return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
}

async function analyzedPlanOf(c: Case, after: Keyset | null): Promise<string> {
  return withTenant(pg().app, TENANT, async (client) => {
    const r = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${LIST_SQL}`,
      paramsOf(c, after),
    );
    return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
  });
}

const plan = (c: Case, after: Keyset | null): Promise<string> =>
  withTenant(pg().app, TENANT, (client) => planOf(client, c, after));

const page = (c: Case, after: Keyset | null): Promise<string[]> =>
  withTenant(pg().app, TENANT, async (client) => {
    const r = await client.query<{ shift_id: string }>(LIST_SQL, paramsOf(c, after));
    return r.rows.map((row) => row.shift_id);
  });

/** The keyset of the 20th row of a case's first page, as the API cursor carries it. */
const keysetAfter = (c: Case): Promise<Keyset> =>
  withTenant(pg().app, TENANT, async (client) => {
    const r = await client.query<{ shift_id: string; closed_at_key: string }>(
      LIST_SQL,
      paramsOf(c, null),
    );
    const row = r.rows[19]!;
    return { at: row.closed_at_key, id: row.shift_id };
  });

const indexState = (name: string) => readIndexState(pg().admin, name);

async function countCloses(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM shift_closes`);
  return r.rows[0]!.n;
}

let cases: Case[] = [];
const keysets = new Map<string, Keyset>();
const pagesBefore = new Map<string, string[]>();
const plansBefore = new Map<string, string>();

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0084-shift-closes-keyset-indexes.spec] Docker NOT AVAILABLE - skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyBefore0084(env);
  await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt429@example.test')`, [USER]);
  // Rows existing BEFORE the build (the upgrade path).
  await seedTenant(TENANT, "rt429", STORE_COUNT, CLOSES);
  await seedTenant(TENANT_2, "rt429-t2", 1, CLOSES_T2);
  await env.admin.query("ANALYZE shift_closes");
  await env.admin.query("ANALYZE shifts");

  const stores = await storesOf(TENANT);
  const scoped = stores.slice(0, 3);
  cases = [
    { name: "tenant-wide", scope: null, store: null, served: [TENANT_INDEX] },
    { name: "single-store", scope: null, store: stores[0]!, served: [STORE_INDEX, TENANT_INDEX] },
    {
      name: "scoped single-store",
      scope: scoped,
      store: scoped[1]!,
      served: [STORE_INDEX, TENANT_INDEX],
    },
    // Owner-approved (RT-429 comment 15731): may still sort; plan not asserted.
    { name: "multi-store-scoped", scope: scoped, store: null, served: [] },
  ];
  for (const c of cases) {
    keysets.set(c.name, await keysetAfter(c));
    plansBefore.set(c.name, await plan(c, null));
    pagesBefore.set(`${c.name}:first`, await page(c, null));
    pagesBefore.set(`${c.name}:cursor`, await page(c, keysets.get(c.name)!));
  }
  // One query() per file, exactly as the runner sends it.
  for (const m of MIGRATIONS) await env.admin.query(read(up(m.id)));
  await env.admin.query("ANALYZE shift_closes");
}, 300_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0084-0085 - single CONCURRENTLY statements", () => {
  it.each(MIGRATIONS.map((m) => [m.id]))(
    "%s up and down are one statement with no transaction control",
    (id) => {
      [up(id), down(id)].forEach(expectSingleConcurrentStatement);
    },
  );
});

describe("0084-0085 - the two RT-429 indexes", () => {
  it.each(MIGRATIONS.map((m) => [m.index, m.def]))(
    "%s is valid with its RT-429 definition",
    async (index, def) => {
      if (skip()) return;
      expect(await indexState(index)).toEqual({
        valid: true,
        def: `CREATE INDEX ${index} ON public.shift_closes USING btree ${def}`,
      });
    },
  );

  it("keeps the 0036 idx_shift_closes_tenant_store", async () => {
    if (skip()) return;
    expect((await indexState(KEPT_INDEX))?.valid).toBe(true);
  });

  it.each(["tenant-wide", "single-store", "scoped single-store"])(
    "before the build the %s list sorts and uses no RT-429 index",
    (name) => {
      if (skip()) return;
      const before = plansBefore.get(name)!;
      for (const m of MIGRATIONS) expect(before).not.toContain(`"Index Name":"${m.index}"`);
      expect(before).toMatch(SORT_NODE);
    },
  );

  it.each(["tenant-wide", "single-store", "scoped single-store"])(
    "after the build the %s list (first page and cursor page) is index-ordered with no Sort, as the app role under RLS",
    async (name) => {
      if (skip()) return;
      const c = cases.find((x) => x.name === name)!;
      for (const after of [null, keysets.get(name)!]) {
        const p = await plan(c, after);
        expect(c.served.some((index) => p.includes(`"Index Name":"${index}"`))).toBe(true);
        expect(p).not.toMatch(SORT_NODE);
      }
    },
  );

  it.each(["tenant-wide", "single-store", "scoped single-store", "multi-store-scoped"])(
    "the %s list returns the same pages after the build as before",
    async (name) => {
      if (skip()) return;
      const c = cases.find((x) => x.name === name)!;
      const first = await page(c, null);
      expect(first).toHaveLength(LIMIT);
      expect(first).toEqual(pagesBefore.get(`${name}:first`));
      expect(await page(c, keysets.get(name)!)).toEqual(pagesBefore.get(`${name}:cursor`));
    },
  );

  it("prints the EXPLAIN (ANALYZE, BUFFERS) evidence for every case (RT-429)", async () => {
    if (skip()) return;
    const out: string[] = [];
    for (const c of cases) {
      for (const after of [null, keysets.get(c.name)!]) {
        const label = `${c.name} ${after === null ? "first page" : "cursor page"}`;
        out.push(`--- RT-429 EXPLAIN: ${label} ---\n${await analyzedPlanOf(c, after)}`);
      }
    }
    // eslint-disable-next-line no-console
    console.info(`\n${out.join("\n\n")}\n`);
    expect(out).toHaveLength(cases.length * 2);
  });
});

describe("0084-0085 - down -> up round-trip", () => {
  it("each down drops only its own index, keeps every close row, and up re-applies cleanly", async () => {
    if (skip()) return;
    const before = await countCloses();
    for (const [i, m] of [...MIGRATIONS].reverse().entries()) {
      await pg().admin.query(read(down(m.id)));
      expect(await indexState(m.index)).toBeNull();
      for (const earlier of MIGRATIONS.slice(0, MIGRATIONS.length - 1 - i)) {
        expect((await indexState(earlier.index))?.valid).toBe(true);
      }
    }
    expect((await indexState(KEPT_INDEX))?.valid).toBe(true);
    expect(await countCloses()).toBe(before);
    for (const m of MIGRATIONS) await pg().admin.query(read(up(m.id)));
    for (const m of MIGRATIONS) expect((await indexState(m.index))?.valid).toBe(true);
  });
});
