/**
 * RT-1114 (RT-1098 R-4a): `0102_sale_tenders_redemption_idx`, the partial
 * unique index that lets one voucher redemption pay at most one sale tender,
 * built CONCURRENTLY (split out of 0099 on review, PR #519).
 *
 * Applies every migration before 0102 (0099 included) against a real
 * PostgreSQL, applies 0102 exactly as the runner does (one `query()` per file),
 * and proves:
 *   - up and down are each a single CONCURRENTLY statement with no transaction
 *     control, so the runner never wraps the build in a transaction block;
 *   - the index is valid, UNIQUE, partial on `redemption_id IS NOT NULL`, over
 *     (tenant_id, redemption_id);
 *   - the down drops only this index, keeps the 0099 column and FK, is
 *     rerunnable, and round-trips with up.
 * The 23505 behaviour itself is proven in 0099-sale-tender-voucher.spec.ts,
 * which applies 0102 after 0099.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore } from "../_helpers/migration-spec";
import { sqlStatements } from "../_helpers/migration-sql";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const ID = "0102_sale_tenders_redemption_idx";
const INDEX = "uq_sale_tenders_tenant_redemption";
const UP = migrationPath(ID, "up");
const DOWN = migrationPath(ID, "down");

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0102-sale-tenders-redemption-idx.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, `${ID}.sql`);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0102: file shape", () => {
  it("up and down are each one CONCURRENTLY statement with no transaction control", () => {
    expectSingleConcurrentStatement(UP);
    expectSingleConcurrentStatement(DOWN);
    // No IF NOT EXISTS on the build: an invalid leftover must fail loudly, never be skipped.
    expect(sqlStatements(UP)[0]).not.toMatch(/IF NOT EXISTS/);
  });
});

describe("0102: the index", () => {
  it("does not exist before 0102, and is valid, unique, partial and on (tenant_id, redemption_id) after it", async () => {
    if (skip()) return;
    const e = guard();
    expect(await indexState(e.admin, INDEX)).toBeNull();
    await e.admin.query(readFileSync(UP, "utf8"));
    expect(await indexState(e.admin, INDEX)).toEqual({
      valid: true,
      def: `CREATE UNIQUE INDEX ${INDEX} ON public.sale_tenders USING btree (tenant_id, redemption_id) WHERE (redemption_id IS NOT NULL)`,
    });
  });
});

describe("0102: down and round trip", () => {
  it("drops only its index, keeps the 0099 column and FK, is rerunnable, and the up re-adds it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(readFileSync(DOWN, "utf8"));
    await e.admin.query(readFileSync(DOWN, "utf8"));
    expect(await indexState(e.admin, INDEX)).toBeNull();
    const column = await e.admin.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'sale_tenders' AND column_name = 'redemption_id'`,
    );
    expect(column.rowCount).toBe(1);
    const fk = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_tenders_redemption_tenant_store'`);
    expect(fk.rowCount).toBe(1);
    await e.admin.query(readFileSync(UP, "utf8"));
    expect((await indexState(e.admin, INDEX))?.valid).toBe(true);
  });
});
