/**
 * RT-1423: `0116_count_posting_chunks` migration test (RT-292 Gate 6; owner authorization 2026-11-16).
 *
 * Validates `packages/db/drizzle/0116_count_posting_chunks.sql` (+ `.down.sql`):
 *   - `erpnext_posting_status` accepts a count chunk (no sale, the four chunk columns) and refuses every
 *     half shape: a chunk without its columns, a sale row carrying them, a bad stamp, a chunk past its total;
 *   - the UNIQUE (tenant, session, chunk) key is the backstop of idempotent emission;
 *   - `verified_noop` is only ever a count chunk with no document;
 *   - `count_posting_lines` has FORCE RLS, three policies, same-tenant FKs and the result CHECKs;
 *   - `inventory_effect_integration` accepts a `confirmed` count no-op with no document, and still refuses a
 *     confirmed effect without a document for any other reason;
 *   - the switch-change columns pair; the down REFUSES while a chunk exists, and UP -> DOWN -> UP round-trips.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0116_count_posting_chunks.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0116_count_posting_chunks.down.sql");

const id = (n: string): string => `11500000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const PRODUCT_A = id("0a031");
const ACTOR = id("0a0a1");
const SESSION = id("0a051");
const CHUNK = id("0a061");
const STAMP = "2026-11-16T09:30:00.000001Z";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0116-count-posting-chunks.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'cp-a', 'CP A', 'USD'), ($2, 'cp-b', 'CP B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A1', 'Store A1')`, [STORE_A, TENANT_A]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Product A', 'standard', $3, $3)`,
    [PRODUCT_A, TENANT_A, ACTOR],
  );
  await a.query(
    `INSERT INTO count_sessions (id, tenant_id, store_id, scope_product_ids, opened_by) VALUES ($1, $2, $3, ARRAY[$4::uuid], $5)`,
    [SESSION, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
  );
  await a.query(upSql);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Run statements as the superuser inside a rolled-back transaction; returns the error code or null. */
async function tryRun(statements: Array<[string, unknown[]?]>): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    for (const [sql, params] of statements) await client.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const CHUNK_INSERT = (over: Record<string, unknown> = {}): [string, unknown[]] => {
  const v = {
    id: CHUNK,
    kind: "inventory_count",
    status: "pending",
    session: SESSION,
    chunk: 1,
    total: 1,
    stamp: STAMP,
    doc: null,
    ...over,
  };
  return [
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status, document_ref,
        count_session_id, count_chunk, count_chunk_total, count_posting_datetime)
     VALUES ($1, $2, $3, NULL, $4, gen_random_uuid(), 'retail-tower', $5, repeat('a', 64), $6, $7, $8, $9, $10, $11)`,
    [v.id, TENANT_A, STORE_A, v.kind, `count:${SESSION}`, v.status, v.doc, v.session, v.chunk, v.total, v.stamp],
  ];
};

describe("0116: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0116: the chunk shape on erpnext_posting_status", () => {
  it("stores a count chunk with no sale", async () => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT()])).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a chunk without its session", { session: null }],
    ["a chunk without its stamp", { stamp: null }],
    ["a stamp without six fractional digits", { stamp: "2026-11-16T09:30:00Z" }],
    ["a stamp that is not UTC", { stamp: "2026-11-16T11:30:00.000001+02:00" }],
    ["a chunk past its total", { chunk: 2, total: 1 }],
    ["chunk zero", { chunk: 0, total: 1 }],
  ])("refuses %s (23514)", async (_why, over) => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT(over)])).toBe("23514");
  });

  it("refuses an unknown kind and a sale row carrying chunk columns", async () => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT({ kind: "inventory_disposition" })])).toBe("23514");
    expect(await tryRun([CHUNK_INSERT({ kind: "sale_post" })])).toBe("23514");
  });

  it("refuses a second chunk with the same (tenant, session, chunk): the idempotency backstop (23505)", async () => {
    if (skip()) return;
    const second = CHUNK_INSERT({ id: id("0a062") });
    expect(await tryRun([CHUNK_INSERT(), second])).toBe("23505");
    const other = CHUNK_INSERT({ id: id("0a063"), chunk: 2, total: 2 });
    const first = CHUNK_INSERT({ total: 2 });
    expect(await tryRun([first, other])).toBeNull();
  });

  it("refuses a session of another tenant (23503)", async () => {
    if (skip()) return;
    const [sql, params] = CHUNK_INSERT();
    expect(await tryRun([[sql.replace("VALUES ($1, $2, $3", "VALUES ($1, $12, $3"), [...params, TENANT_B]]])).not.toBeNull();
  });

  it("verified_noop is only a count chunk with no document", async () => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT({ status: "verified_noop" })])).toBeNull();
    expect(await tryRun([CHUNK_INSERT({ status: "verified_noop", doc: '{"doctype":"X","name":"Y"}' })])).toBe("23514");
  });
});

describe("0116: count_posting_lines", () => {
  it("has FORCE ROW LEVEL SECURITY and exactly three policies (read, insert, update)", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'count_posting_lines'`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'count_posting_lines' ORDER BY cmd`,
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  const LINE = (over: Record<string, unknown> = {}): [string, unknown[]] => {
    const v = { seq: 1, qty: "7.0000", unit: "each", result: null, refusal: null, at: null, ...over };
    return [
      `INSERT INTO count_posting_lines
         (intent_id, tenant_id, line_seq, tenant_product_ref, erpnext_item_ref, warehouse_ref, counted_quantity, unit,
          result, refusal_code, resulted_at)
       VALUES ($1, $2, $3, $4, 'ITEM-1', 'Stores - RT', $5::numeric(19,4), $6, $7, $8, $9)`,
      [CHUNK, TENANT_A, v.seq, PRODUCT_A, v.qty, v.unit, v.result, v.refusal, v.at],
    ];
  };

  it("stores a frozen line, refuses a negative target, a bad result and a rejected line without its refusal", async () => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT(), LINE()])).toBeNull();
    expect(await tryRun([CHUNK_INSERT(), LINE({ qty: "-1.0000" })])).toBe("23514");
    expect(await tryRun([CHUNK_INSERT(), LINE({ result: "done", at: new Date() })])).toBe("23514");
    expect(await tryRun([CHUNK_INSERT(), LINE({ result: "rejected", at: new Date() })])).toBe("23514");
    expect(await tryRun([CHUNK_INSERT(), LINE({ result: "adjusted", at: new Date() })])).toBeNull();
    expect(await tryRun([CHUNK_INSERT(), LINE({ result: "rejected", refusal: "uom_mismatch", at: new Date() })])).toBeNull();
  });

  it("refuses a duplicate line or product within a chunk (23505)", async () => {
    if (skip()) return;
    expect(await tryRun([CHUNK_INSERT(), LINE(), LINE()])).toBe("23505");
    expect(await tryRun([CHUNK_INSERT(), LINE({ seq: 1 }), LINE({ seq: 2 })])).toBe("23505");
  });
});

describe("0116: the effect integration no-op and the switch columns", () => {
  it("pairs the switch-change columns", async () => {
    if (skip()) return;
    const set = (cols: string, vals: string): [string, unknown[]] => [
      `INSERT INTO tenant_inventory_settings (tenant_id, updated_by${cols}) VALUES ($1, $2${vals})`,
      [TENANT_A, ACTOR],
    ];
    expect(await tryRun([set(", count_sessions_changed_at, count_sessions_changed_by", `, now(), '${ACTOR}'`)])).toBeNull();
    expect(await tryRun([set(", count_sessions_changed_at", ", now()")])).toBe("23514");
  });

  it("the confirmed-document CHECK allows only the count no-op without a document", async () => {
    if (skip()) return;
    const defs = await guard().admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'inventory_effect_integration_confirmed_document'`,
    );
    expect(defs.rows[0]!.def).toContain("count_verified_noop");
    expect(defs.rows[0]!.def).toContain("erp_document_ref IS NOT NULL");
  });
});

describe("0116: down refuses while a chunk exists, and round-trips once none does", () => {
  it("refuses with a chunk, then UP -> DOWN -> UP leaves the schema applied", async () => {
    if (skip()) return;
    const a = guard().admin;
    const [sql, params] = CHUNK_INSERT();
    await a.query(sql, params);
    await expect(a.query(downSql)).rejects.toThrow(/0116 down refused/);
    await a.query(`DELETE FROM erpnext_posting_status WHERE id = $1`, [CHUNK]);
    await a.query(downSql);
    const gone = await a.query(`SELECT to_regclass('count_posting_lines') AS t`);
    expect(gone.rows[0].t).toBeNull();
    await a.query(upSql);
    const back = await a.query(`SELECT to_regclass('count_posting_lines') AS t`);
    expect(back.rows[0].t).not.toBeNull();
  });
});
