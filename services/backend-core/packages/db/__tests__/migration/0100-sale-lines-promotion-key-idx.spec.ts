/**
 * RT-1336 (RT-286 spec 048 slice S3): `0100_sale_lines_promotion_key_idx`,
 * the composite key of `sale_lines` that 0101's `sale_line_promotions`
 * references, built CONCURRENTLY.
 *
 * Applies every migration before 0100 against a real PostgreSQL 16, seeds two
 * tenants' sales with many lines, applies 0100 exactly as the runner does (one
 * `query()` per file), and proves:
 *   - up and down are each a single CONCURRENTLY statement with no transaction
 *     control, so the runner never wraps the build in a transaction block;
 *   - the index is valid, unique, non-partial and on (id, sale_id, tenant_id,
 *     store_id), so PostgreSQL accepts it as a foreign key target, and a
 *     composite FK onto it refuses a line of another sale, store or tenant;
 *   - existing lines are untouched, and capture keeps inserting lines;
 *   - the down drops only this index and round-trips with up.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, errorCode } from "../_helpers/migration-spec";
import { sqlStatements } from "../_helpers/migration-sql";
import { expectSingleConcurrentStatement, indexState, migrationPath } from "../_helpers/concurrent-index-migration";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const ID = "0100_sale_lines_promotion_key_idx";
const INDEX = "uq_sale_lines_id_sale_tenant_store";
const UP = migrationPath(ID, "up");
const DOWN = migrationPath(ID, "down");

const id = (n: string): string => `01000000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_B = id("0b021");
const SALE_A = id("0a031");
const SALE_A_OTHER = id("0a032");
const SALE_B = id("0b031");
const ACTOR = id("0a0a1");
const LINES_PER_SALE = 2_000;

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function seedSale(saleId: string, tenantId: string, storeId: string, deviceId: string, ext: string): Promise<void> {
  const a = guard().admin;
  await a.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, device_id)
     VALUES ($1, $2, $3, 'EGP', 10, '2026-12-02T10:00:00Z', '2026-12-02', 'pos', $4, repeat('a', 64), $5, $6)`,
    [saleId, tenantId, storeId, ext, ACTOR, deviceId],
  );
  await a.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit)
     SELECT gen_random_uuid(), $1, $2, $3, 'L' || g, 10, 'EGP', 1, 10, 'pcs' FROM generate_series(1, $4) g`,
    [saleId, tenantId, storeId, LINES_PER_SALE],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0100-sale-lines-promotion-key-idx.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, `${ID}.sql`);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'slk-a', 'SLK A', 'EGP'), ($2, 'slk-b', 'SLK B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'A1'), ($2, $4, 'A2', 'A2'), ($3, $5, 'B1', 'B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $3, $4, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A, TENANT_B, STORE_B],
  );
  await seedSale(SALE_A, TENANT_A, STORE_A, DEVICE_A, "ext-a");
  await seedSale(SALE_A_OTHER, TENANT_A, STORE_A, DEVICE_A, "ext-a2");
  await seedSale(SALE_B, TENANT_B, STORE_B, DEVICE_B, "ext-b");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0100: file shape", () => {
  it("up and down are each one CONCURRENTLY statement with no transaction control", () => {
    expectSingleConcurrentStatement(UP);
    expectSingleConcurrentStatement(DOWN);
    // No IF NOT EXISTS on the build: an invalid leftover must fail loudly, never be skipped.
    expect(sqlStatements(UP)[0]).not.toMatch(/IF NOT EXISTS/);
  });
});

describe("0100: the index", () => {
  it("does not exist before 0100, and is valid, unique, non-partial and on (id, sale_id, tenant_id, store_id) after it", async () => {
    if (skip()) return;
    const e = guard();
    expect(await indexState(e.admin, INDEX)).toBeNull();
    await e.admin.query(readFileSync(UP, "utf8"));
    expect(await indexState(e.admin, INDEX)).toEqual({
      valid: true,
      def: `CREATE UNIQUE INDEX ${INDEX} ON public.sale_lines USING btree (id, sale_id, tenant_id, store_id)`,
    });
    const n = await e.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_lines`);
    expect(n.rows[0]!.n).toBe(String(3 * LINES_PER_SALE));
  });

  it("is a foreign key target that refuses a line of another sale, store or tenant", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      // A plain table (a temporary one cannot reference sale_lines), dropped by the rollback.
      await client.query("BEGIN");
      await client.query(
        `CREATE TABLE probe_line_ref (
           sale_line_id UUID, sale_id UUID, tenant_id UUID, store_id UUID,
           FOREIGN KEY (sale_line_id, sale_id, tenant_id, store_id) REFERENCES sale_lines (id, sale_id, tenant_id, store_id))`,
      );
      const line = (
        await client.query<{ id: string }>(`SELECT id FROM sale_lines WHERE sale_id = $1 LIMIT 1`, [SALE_A])
      ).rows[0]!.id;
      const ref = async (sale: string, tenant: string, store: string): Promise<string | null> => {
        await client.query("SAVEPOINT p");
        const code = await errorCode(() =>
          client.query(`INSERT INTO probe_line_ref VALUES ($1, $2, $3, $4)`, [line, sale, tenant, store]),
        );
        await client.query(code === null ? "RELEASE SAVEPOINT p" : "ROLLBACK TO SAVEPOINT p");
        return code;
      };
      expect(await ref(SALE_A, TENANT_A, STORE_A)).toBeNull();
      expect(await ref(SALE_A_OTHER, TENANT_A, STORE_A)).toBe("23503");
      expect(await ref(SALE_A, TENANT_A, STORE_A2)).toBe("23503");
      expect(await ref(SALE_A, TENANT_B, STORE_A)).toBe("23503");
      // Capture keeps writing lines with the index in place.
      await client.query(
        `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit)
         VALUES (gen_random_uuid(), $1, $2, $3, 'new', 5, 'EGP', 1, 5, 'pcs')`,
        [SALE_B, TENANT_B, STORE_B],
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("0100: down and round trip", () => {
  it("drops only its index, keeps every line, and is rerunnable", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(readFileSync(DOWN, "utf8"));
    await e.admin.query(readFileSync(DOWN, "utf8"));
    expect(await indexState(e.admin, INDEX)).toBeNull();
    const n = await e.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_lines`);
    expect(n.rows[0]!.n).toBe(String(3 * LINES_PER_SALE));
    expect(await indexState(e.admin, "sale_lines_pkey")).not.toBeNull();
    await e.admin.query(readFileSync(UP, "utf8"));
    expect((await indexState(e.admin, INDEX))?.valid).toBe(true);
  });
});
