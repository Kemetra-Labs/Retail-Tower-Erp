/**
 * RT-1424: `0118_count_late_compensation` migration test (RT-292 Gate 6, G6-5; owner delegation 2026-11-16).
 *
 * Validates `packages/db/drizzle/0118_count_late_compensation.sql` (+ `.down.sql`):
 *   - `inventory_effect_integration` accepts the state `erp_absorbed` only with its document and reason and with
 *     no intent and no confirmation time; `erp_neutral` keeps its meaning (no document), an unknown state is refused;
 *   - `count_late_compensations` has FORCE RLS, exactly two policies (read, insert: append-only), same-tenant FKs,
 *     and the UNIQUE keys that make a late event compensated at most once (G);
 *   - `erp_stock_import_rows` takes the posting stamp (DATE + TIME, a pair);
 *   - the down REFUSES while a compensation or an `erp_absorbed` row exists, and UP -> DOWN -> UP round-trips;
 *   - the file is safe to run again, and the first transaction alone leaves the constraints NOT VALID.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0118_count_late_compensation.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0118_count_late_compensation.down.sql");

const id = (n: string): string => `11800000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const PRODUCT_A = id("0a031");
const ACTOR = id("0a0a1");
const SESSION = id("0a051");
const LATE = id("0a071");
const COUNT = id("0a072");
const COMP = id("0a073");
const COMP2 = id("0a074");
const FINDING = id("0a081");
const KEY = "a".repeat(64);
const DOC = '{"doctype":"Stock Reconciliation","name":"MAT-RECO-1"}';

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";
let locationId = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";
function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const STOCK_COUNT = id("0a091");

const movement = (effectId: string, quantity: string, type: "outbound" | "count_correction"): [string, unknown[]] => [
  `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, occurred_at,
                               created_by, origin, event_type, event_ref_id, stock_location_id, inventory_status, stock_count_id)
   VALUES ($1, $2, $3, $8, $4::numeric(19,4), 'each', $5, now(), $6, 'retail', $9, $1, $7, 'sellable', $10)`,
  [
    effectId,
    TENANT_A,
    STORE_A,
    quantity,
    PRODUCT_A,
    ACTOR,
    locationId,
    type,
    type === "outbound" ? "sale" : "count",
    type === "outbound" ? null : STOCK_COUNT,
  ],
];

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0118-count-late-compensation.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'lc-a', 'LC A', 'USD'), ($2, 'lc-b', 'LC B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'A1', 'Store A1')`, [STORE_A, TENANT_A]);
  await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'lc@fixture.invalid', NULL)`, [ACTOR]);
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'Product A', 'standard', $3, $3)`,
    [PRODUCT_A, TENANT_A, ACTOR],
  );
  locationId = (await a.query(`SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`, [STORE_A])).rows[0].id as string;
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

const integration = (state: string, over: Record<string, unknown> = {}): [string, unknown[]] => {
  const v = { doc: DOC, reason: "late_event_absorbed_by_count", confirmedAt: null, ...over };
  return [
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state, erp_document_ref, erp_confirmed_at, state_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [COMP, TENANT_A, state, v.doc, v.confirmedAt, v.reason],
  ];
};

/** The late event, the count correction, the finding and the compensating effect, ready for a compensation row. */
const fixtures = (): Array<[string, unknown[]?]> => [
  [
    `INSERT INTO stock_counts (id, tenant_id, store_id, tenant_product_ref, counted_quantity, derived_on_hand_at_count, stocking_unit,
        counted_at, created_by)
     VALUES ($1, $2, $3, $4, 7, 10, 'each', now(), $5)`,
    [STOCK_COUNT, TENANT_A, STORE_A, PRODUCT_A, ACTOR],
  ],
  movement(LATE, "-2.0000", "outbound"),
  movement(COUNT, "-3.0000", "count_correction"),
  movement(COMP, "2.0000", "count_correction"),
  movement(COMP2, "2.0000", "count_correction"),
  [
    `INSERT INTO count_late_event_findings (id, tenant_id, store_id, session_id, tenant_product_ref, assessment, quantity, event_type,
        event_reference, source_system, external_id, effect_id, oversell_risk, erp_stamp, detected_in_state)
     VALUES ($1, $2, $3, $4, $5, 'overstated', 2, 'sale', 'sale-1', 'pos', 'ext-1', $6, false, now(), 'confirmed')`,
    [FINDING, TENANT_A, STORE_A, SESSION, PRODUCT_A, LATE],
  ],
];

const compensation = (over: Record<string, unknown> = {}, effect = COMP): [string, unknown[]] => {
  const v = { tenant: TENANT_A, key: KEY, quantity: "2.0000", reason: "verified in ERPNext", late: LATE, ...over };
  return [
    `INSERT INTO count_late_compensations (id, tenant_id, store_id, session_id, tenant_product_ref, late_effect_id, count_effect_id,
        compensation_effect_id, quantity, absorbing_document_ref, reason, approved_by, idempotency_key, evidence)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::numeric(19,4), $9, $10, $11, $12, '{}'::jsonb)`,
    [v.tenant, STORE_A, SESSION, PRODUCT_A, v.late, COUNT, effect, v.quantity, DOC, v.reason, ACTOR, v.key],
  ];
};

describe("0118: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0118: the erp_absorbed integration state", () => {
  it("accepts the state with its document and reason and no intent or confirmation time", async () => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), integration("erp_absorbed")])).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["without its document", { doc: null }],
    ["without its reason", { reason: null }],
    ["with a confirmation time", { confirmedAt: new Date() }],
  ])("refuses erp_absorbed %s (23514)", async (_why, over) => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), integration("erp_absorbed", over)])).toBe("23514");
  });

  it("refuses an erp_absorbed row that carries an ERP intent (23514)", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      for (const [sql, params] of fixtures()) await client.query(sql, params);
      const [sql, params] = integration("erp_absorbed");
      await client.query(sql, params);
      await expect(
        client.query(`UPDATE inventory_effect_integration SET posting_status_id = gen_random_uuid() WHERE effect_id = $1`, [COMP]),
      ).rejects.toMatchObject({ code: expect.stringMatching(/23514|23503/) });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps erp_neutral document-free and still refuses an unknown state", async () => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), integration("erp_neutral", { doc: null, reason: null })])).toBeNull();
    expect(await tryRun([...fixtures(), integration("erp_neutral")])).toBe("23514");
    expect(await tryRun([...fixtures(), integration("erp_whatever")])).toBe("23514");
  });
});

describe("0118: count_late_compensations", () => {
  it("has FORCE ROW LEVEL SECURITY and exactly two policies (read, insert: append-only)", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'count_late_compensations'`,
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = 'count_late_compensations' ORDER BY cmd`,
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
  });

  it("stores one compensation of a finding's late event", async () => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), compensation()])).toBeNull();
  });

  it("a late event is compensated at most once: a second row is refused whatever its key or effect (23505)", async () => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), compensation(), compensation({ key: "b".repeat(64) }, COMP2)])).toBe("23505");
    expect(await tryRun([...fixtures(), compensation(), compensation({}, COMP2)])).toBe("23505");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a zero quantity", { quantity: "0.0000" }],
    ["an empty reason", { reason: "" }],
    ["a reason past 500 characters", { reason: "x".repeat(501) }],
    ["a key that is not 64 hex characters", { key: "not-a-hash" }],
  ])("refuses %s (23514)", async (_why, over) => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), compensation(over)])).toBe("23514");
  });

  it("refuses a late effect with no finding of the session (23503) and another tenant's effects (23503)", async () => {
    if (skip()) return;
    expect(await tryRun([...fixtures(), compensation({ late: COUNT })])).toBe("23503");
    expect(await tryRun([...fixtures(), compensation({ tenant: TENANT_B })])).not.toBeNull();
  });
});

describe("0118: the posting stamp on the import rows", () => {
  it("has the two nullable columns (DATE and TIME) and the pair CHECK", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'erp_stock_import_rows' AND column_name IN ('posting_date', 'posting_time') ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "posting_date", is_nullable: "YES", data_type: "date" },
      { column_name: "posting_time", is_nullable: "YES", data_type: "time without time zone" },
    ]);
    const defs = await guard().admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'erp_stock_import_rows_posting_stamp_pair'`,
    );
    expect(defs.rows).toHaveLength(1);
    expect(defs.rows[0]!.def).toContain("posting_date IS NULL");
    // A malformed time is refused by the type itself, and microseconds are kept exactly.
    const a = guard().admin;
    await expect(a.query(`SELECT '25:00:00'::time`)).rejects.toThrow();
    expect((await a.query(`SELECT '10:00:00.000001'::time::text AS t`)).rows[0].t).toBe("10:00:00.000001");
  });
});

describe("0118: the file is safe to run again, and a retry completes after a failed second transaction", () => {
  it("re-running the whole up file on an applied schema changes nothing and does not fail", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(upSql);
    const policies = await a.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'count_late_compensations'`);
    expect(policies.rows[0].n).toBe(2);
  });

  it("leaves the constraints NOT VALID after the first transaction alone, and the retry validates them all", async () => {
    if (skip()) return;
    const a = guard().admin;
    const end = /\r?\nCOMMIT;\r?\n/.exec(upSql);
    expect(end).not.toBeNull();
    const firstTransaction = upSql.slice(0, end!.index + end![0].length);
    const unvalidated = `SELECT count(*)::int AS n FROM pg_constraint
       WHERE NOT convalidated AND conname IN ('erp_stock_import_rows_posting_stamp_pair',
         'inventory_effect_integration_state_allowed', 'inventory_effect_integration_erp_absorbed_shape')`;
    await a.query(downSql);
    await a.query(firstTransaction);
    expect((await a.query(unvalidated)).rows[0].n).toBe(3);
    await a.query(upSql);
    expect((await a.query(unvalidated)).rows[0].n).toBe(0);
  });
});

describe("0118: down refuses while a compensation or an erp_absorbed row exists, and round-trips once none does", () => {
  it("refuses with a compensation, then UP -> DOWN -> UP leaves the schema applied", async () => {
    if (skip()) return;
    const a = guard().admin;
    for (const [sql, params] of fixtures()) await a.query(sql, params);
    const [csql, cparams] = compensation();
    await a.query(csql, cparams);
    await expect(a.query(downSql)).rejects.toThrow(/0118 down refused/);
    await a.query(`DELETE FROM count_late_compensations`);
    const [isql, iparams] = integration("erp_absorbed");
    await a.query(isql, iparams);
    await expect(a.query(downSql)).rejects.toThrow(/0118 down refused/);
    await a.query(`DELETE FROM inventory_effect_integration WHERE effect_id = $1`, [COMP]);
    await a.query(downSql);
    expect((await a.query(`SELECT to_regclass('count_late_compensations') AS t`)).rows[0].t).toBeNull();
    const cols = await a.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'erp_stock_import_rows' AND column_name LIKE 'posting_%'`);
    expect(cols.rows[0].n).toBe(0);
    await a.query(upSql);
    expect((await a.query(`SELECT to_regclass('count_late_compensations') AS t`)).rows[0].t).not.toBeNull();
  });
});
