/**
 * 0077 — the ordering of a sale's sync status (Jira RT-1061, RT-973 slice 1;
 * [GATED] migration approved under the owner delegation of 2026-11-02).
 *
 * Applies every migration before 0077 against a real Postgres, seeds sales in
 * every `sync_status`, applies 0077 exactly as the runner does (one `query()`
 * for the file), and proves:
 *   - every existing sale survives and reads version 0, whatever its status;
 *   - a new capture (an INSERT that does not name the column) gets 0;
 *   - the column is NOT NULL, and the CHECK (validated) keeps it inside
 *     0..9007199254740991 (a JSON-safe integer);
 *   - the ADD COLUMN did not rewrite the table (same relfilenode);
 *   - down drops the column and the CHECK, keeps every sale and its status,
 *     and round-trips with up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0077_sale_sync_status_version.sql";
const UP_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, UP_NAME), "utf8");
const DOWN_SQL = (): string => readFileSync(resolve(DRIZZLE_DIR, "0077_sale_sync_status_version.down.sql"), "utf8");

const TENANT = "0a000000-0000-7000-8000-000000106101";
const STORE = "0a000000-0000-7000-8000-000000106102";
const ACTOR = "0a000000-0000-7000-8000-000000106103";
const CHECK = "sales_sync_status_version_range";
const STATUSES = ["captured", "synced", "failed-retryable", "failed-needs-repair"] as const;

let env: PgTestEnv | null = null;
const saleIds = new Map<string, string>();

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

/** One sale with `syncStatus`, inserted without naming `sync_status_version`. */
async function seedSale(syncStatus: string, externalId: string): Promise<string> {
  const r = await pg().admin.query<{ id: string }>(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, sync_status)
     VALUES (gen_random_uuid(), $1, $2, 'EGP', 10, now(), current_date, 'pos-0077', $3, repeat('c', 64), $4, $5)
     RETURNING id`,
    [TENANT, STORE, externalId, ACTOR, syncStatus],
  );
  return r.rows[0]!.id;
}

/** The SQLSTATE the statement fails with, or null. */
async function codeOf(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await pg().admin.query(sql, params);
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function column(): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | null> {
  const r = await pg().admin.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'sync_status_version'`,
  );
  return r.rows[0] ?? null;
}

async function validatedCheck(): Promise<boolean> {
  const r = await pg().admin.query(`SELECT 1 FROM pg_constraint WHERE conname = $1 AND convalidated`, [CHECK]);
  return r.rows.length === 1;
}

async function relfilenode(): Promise<string> {
  const r = await pg().admin.query<{ n: string }>(`SELECT relfilenode::text AS n FROM pg_class WHERE oid = 'sales'::regclass`);
  return r.rows[0]!.n;
}

async function statuses(): Promise<Array<{ status: string; version: string | null }>> {
  const r = await pg().admin.query<{ status: string; version: string | null }>(
    `SELECT sync_status AS status,
            (to_jsonb(s) ->> 'sync_status_version') AS version
       FROM sales s WHERE id = ANY($1::uuid[]) ORDER BY sync_status`,
    [[...saleIds.values()]],
  );
  return r.rows;
}

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0077 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt1061-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'a@rt1061.example')`, [ACTOR]);
  for (const status of STATUSES) saleIds.set(status, await seedSale(status, `before-${status}`));
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0077 up", () => {
  it("adds a NOT NULL bigint defaulting to 0, without rewriting the table; the CHECK is validated", async () => {
    if (skip()) return;
    const before = await relfilenode();
    await pg().admin.query(UP_SQL());
    expect(await column()).toEqual({ data_type: "bigint", is_nullable: "NO", column_default: "0" });
    expect(await validatedCheck()).toBe(true);
    expect(await relfilenode()).toBe(before);
  });

  it("every existing sale survives with its status and reads version 0", async () => {
    if (skip()) return;
    expect(await statuses()).toEqual(
      [...STATUSES].sort().map((status) => ({ status, version: "0" })),
    );
  });

  it("a capture that does not name the column gets 0", async () => {
    if (skip()) return;
    const id = await seedSale("captured", "after-up");
    const r = await pg().admin.query<{ v: string }>(`SELECT sync_status_version::text AS v FROM sales WHERE id = $1`, [id]);
    expect(r.rows[0]!.v).toBe("0");
    await pg().admin.query(`DELETE FROM sales WHERE id = $1`, [id]);
  });

  it("a writer's increment in the same UPDATE moves it by one", async () => {
    if (skip()) return;
    const id = saleIds.get("captured")!;
    await pg().admin.query(
      `UPDATE sales SET sync_status = 'synced', sync_status_version = sync_status_version + 1 WHERE id = $1`,
      [id],
    );
    const r = await pg().admin.query<{ v: string; s: string }>(
      `SELECT sync_status_version::text AS v, sync_status AS s FROM sales WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ v: "1", s: "synced" });
    await pg().admin.query(`UPDATE sales SET sync_status = 'captured', sync_status_version = 0 WHERE id = $1`, [id]);
  });

  it.each([
    ["a negative version", -1, "23514"],
    ["a version above 2^53 - 1", "9007199254740992", "23514"],
    ["NULL", null, "23502"],
  ] as const)("refuses %s", async (_label, value, code) => {
    if (skip()) return;
    expect(
      await codeOf(`UPDATE sales SET sync_status_version = $2::bigint WHERE id = $1`, [saleIds.get("synced"), value]),
    ).toBe(code);
  });

  it("accepts the JSON-safe maximum", async () => {
    if (skip()) return;
    const id = saleIds.get("synced")!;
    expect(await codeOf(`UPDATE sales SET sync_status_version = 9007199254740991 WHERE id = $1`, [id])).toBeNull();
    await pg().admin.query(`UPDATE sales SET sync_status_version = 0 WHERE id = $1`, [id]);
  });
});

describe("0077 down", () => {
  it("drops the column and the CHECK, keeps every sale and its status, and round-trips with up", async () => {
    if (skip()) return;
    await pg().admin.query(DOWN_SQL());
    expect(await column()).toBeNull();
    expect(await validatedCheck()).toBe(false);
    expect(await statuses()).toEqual([...STATUSES].sort().map((status) => ({ status, version: null })));

    await pg().admin.query(UP_SQL());
    expect(await column()).toEqual({ data_type: "bigint", is_nullable: "NO", column_default: "0" });
    expect(await validatedCheck()).toBe(true);
    expect(await statuses()).toEqual([...STATUSES].sort().map((status) => ({ status, version: "0" })));
  });
});
