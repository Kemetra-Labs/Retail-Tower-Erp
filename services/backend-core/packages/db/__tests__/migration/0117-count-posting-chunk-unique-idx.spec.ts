/**
 * RT-1423: `0117_count_posting_chunk_unique_idx` — the unique chunk key, a dedicated single-statement
 * CONCURRENTLY migration. Proves the file shape (one CONCURRENTLY statement, no transaction), the index is valid,
 * unique and partial, a second chunk with the same (tenant, session, chunk) is refused (the idempotency backstop),
 * a sale row stays out of it, and the down removes it and the up restores it.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore } from "../_helpers/migration-spec";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const ID = "0117_count_posting_chunk_unique_idx";
const INDEX = "UQ_idx_erpnext_posting_status_count_chunk";
const UP = migrationPath(ID, "up");
const DOWN = migrationPath(ID, "down");

const id = (n: string): string => `11700000-0000-7000-8000-0000000${n}`;
const TENANT = id("0a001");
const STORE = id("0a011");
const PRODUCT = id("0a031");
const ACTOR = id("0a0a1");
const SESSION = id("0a051");

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const CHUNK = (n: number, rowId: string): [string, unknown[]] => [
  `INSERT INTO erpnext_posting_status
     (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status,
      count_session_id, count_chunk, count_chunk_total, count_posting_datetime)
   VALUES ($1, $2, $3, NULL, 'inventory_count', gen_random_uuid(), 'retail-tower', $4, repeat('a', 64), 'pending',
           $5, $6, 2, '2026-11-16T09:30:00.000001Z')`,
  [rowId, TENANT, STORE, `count:${SESSION}:${n}`, SESSION, n],
];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, `${ID}.sql`);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0117-count-posting-chunk-unique-idx.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  const { readFileSync } = await import("node:fs");
  upSql = readFileSync(UP, "utf8");
  downSql = readFileSync(DOWN, "utf8");
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'ci-a', 'CI A', 'USD')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A1', 'Store A1')`, [STORE, TENANT]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'Product A', 'standard', $3, $3)`,
    [PRODUCT, TENANT, ACTOR],
  );
  await a.query(
    `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by) VALUES ($1, $2, $3, ARRAY[$4::uuid], $5)`,
    [SESSION, TENANT, STORE, PRODUCT, ACTOR],
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0117: file shape", () => {
  it("up and down exist and are each one CONCURRENTLY statement outside a transaction", () => {
    expect(existsSync(UP)).toBe(true);
    expect(existsSync(DOWN)).toBe(true);
    [UP, DOWN].forEach(expectSingleConcurrentStatement);
  });
});

describe("0117: the unique chunk key", () => {
  it("is absent before the up and valid, unique and partial after it", async () => {
    if (skip()) return;
    const a = guard().admin;
    expect(await indexState(a, INDEX)).toBeNull();
    await a.query(upSql);
    const state = await indexState(a, INDEX);
    expect(state?.valid).toBe(true);
    expect(state?.def).toMatch(/UNIQUE/);
    expect(state?.def).toMatch(/\(tenant_id, count_session_id, count_chunk\)/);
    expect(state?.def).toMatch(/WHERE \(?count_session_id IS NOT NULL\)?/);
  });

  it("refuses a second chunk with the same (tenant, session, chunk) and allows the next number (23505)", async () => {
    if (skip()) return;
    const a = guard().admin;
    const [s1, p1] = CHUNK(1, id("0a061"));
    await a.query(s1, p1);
    const [s2, p2] = CHUNK(1, id("0a062"));
    await expect(a.query(s2, p2)).rejects.toMatchObject({ code: "23505" });
    const [s3, p3] = CHUNK(2, id("0a063"));
    await a.query(s3, p3);
    await a.query(`DELETE FROM erpnext_posting_status WHERE count_session_id = $1`, [SESSION]);
  });

  it("the down removes the index and the up restores it", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(downSql);
    expect(await indexState(a, INDEX)).toBeNull();
    await a.query(upSql);
    expect((await indexState(a, INDEX))?.valid).toBe(true);
  });
});
