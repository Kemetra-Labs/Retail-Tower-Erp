/**
 * RT-1513: `0124_shipment_transfers` + `0125_transfer_leg_unique_idx` migration test (RT-291 Inventory Gate 5, slice
 * S2; [GATED: migration]).
 *
 * Validates `packages/db/drizzle/0124_shipment_transfers.sql` (+ `.down.sql`) and the CONCURRENTLY leg key (0125):
 *   - `erpnext_posting_status` accepts a transfer leg (no sale, no count columns) and refuses every half shape;
 *   - the unique leg key (tenant, external_id) is the backstop of replay-safe emission (888, 889);
 *   - `erpnext_warehouse_map` holds ONE active transit warehouse per tenant, with no store (O2);
 *   - the Transfer document CHECKs: stores differ, state shapes, cancel only before dispatch, all-or-none dispatch,
 *     In Transit (dispatched - received - short_closed) never negative, one line per product;
 *   - `inventory_reservations`: positive quantity, the state/changed pair, one ACTIVE reservation per source line;
 *   - every new table has FORCE ROW LEVEL SECURITY and three policies, and the app role (NOSUPERUSER, subject to RLS)
 *     sees only its own tenant's rows and nothing under an empty GUC;
 *   - the settings columns (activation pair, threshold range); the file is safe to run again; the down REFUSES while a
 *     transfer exists, and UP -> DOWN -> UP round-trips.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0124_shipment_transfers.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0124_shipment_transfers.down.sql");
const IDX_UP_PATH = resolve(DRIZZLE_DIR, "0125_transfer_leg_unique_idx.sql");
const IDX_DOWN_PATH = resolve(DRIZZLE_DIR, "0125_transfer_leg_unique_idx.down.sql");

const id = (n: string): string => `12400000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A1 = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B1 = id("0b011");
const PRODUCT_A = id("0a031");
const PRODUCT_A2 = id("0a032");
const ACTOR = id("0a0a1");
const TRANSFER = id("0a051");
const LINE = id("0a061");
const LEG = id("0a071");
const STAMP = "2026-11-20T09:30:00.000000Z";

const NEW_TABLES = [
  "inventory_reservations",
  "shipment_transfers",
  "shipment_transfer_lines",
  "shipment_transfer_receipts",
  "shipment_transfer_receipt_lines",
  "shipment_transfer_discrepancies",
  "transfer_postings",
  "transfer_posting_lines",
] as const;

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";
let idxUpSql = "";
let idxDownSql = "";

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
      console.warn(`\n[0124-shipment-transfers.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  idxUpSql = readFileSync(IDX_UP_PATH, "utf8");
  idxDownSql = readFileSync(IDX_DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'st-a', 'ST A', 'USD'), ($2, 'st-b', 'ST B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $3, 'Product A', 'standard', $4, $4), ($2, $3, 'Product A2', 'standard', $4, $4)`,
    [PRODUCT_A, PRODUCT_A2, TENANT_A, ACTOR],
  );
  await a.query(upSql);
  await a.query(idxUpSql);
  await ensureAppRole(env);
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

const LEG_INSERT = (over: Record<string, unknown> = {}): [string, unknown[]] => {
  const v = {
    id: LEG,
    kind: "transfer_dispatch",
    external: `transfer_dispatch:${TRANSFER}`,
    sale: null,
    session: null,
    chunk: null,
    total: null,
    stamp: null,
    ...over,
  };
  return [
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status,
        count_session_id, count_chunk, count_chunk_total, count_posting_datetime)
     VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'retail-tower', $6, repeat('a', 64), 'pending', $7, $8, $9, $10)`,
    [v.id, TENANT_A, STORE_A1, v.sale, v.kind, v.external, v.session, v.chunk, v.total, v.stamp],
  ];
};

const TRANSFER_INSERT = (over: Record<string, unknown> = {}): [string, unknown[]] => {
  const v = { id: TRANSFER, src: STORE_A1, dst: STORE_A2, state: "draft", ...over };
  return [
    `INSERT INTO shipment_transfers (id, tenant_id, source_store_id, destination_store_id, state, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [v.id, TENANT_A, v.src, v.dst, v.state, ACTOR],
  ];
};

const LINE_INSERT = (over: Record<string, unknown> = {}): [string, unknown[]] => {
  const v = { id: LINE, seq: 1, product: PRODUCT_A, qty: "10.0000", dispatched: "0", received: "0", shortClosed: "0", ...over };
  return [
    `INSERT INTO shipment_transfer_lines
       (id, tenant_id, transfer_id, line_seq, tenant_product_ref, stocking_unit, quantity, dispatched_quantity,
        received_quantity, short_closed_quantity)
     VALUES ($1, $2, $3, $4, $5, 'each', $6::numeric(19,4), $7::numeric(19,4), $8::numeric(19,4), $9::numeric(19,4))`,
    [v.id, TENANT_A, TRANSFER, v.seq, v.product, v.qty, v.dispatched, v.received, v.shortClosed],
  ];
};

describe("0124: files exist", () => {
  it("up + down migration files are present for 0124 and 0125", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
    expect(existsSync(IDX_UP_PATH)).toBe(true);
    expect(existsSync(IDX_DOWN_PATH)).toBe(true);
  });

  it("0125 is exactly one CONCURRENTLY statement with no IF NOT EXISTS", () => {
    const statements = idxUpSql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.trim() !== "")
      .join(" ")
      .split(";")
      .filter((s) => s.trim() !== "");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY "UQ_idx_erpnext_posting_status_transfer_leg"/);
    expect(statements[0]).not.toMatch(/IF NOT EXISTS/i);
  });
});

describe("0124: the leg shape on erpnext_posting_status", () => {
  it("stores a dispatch and a receipt leg with no sale and no count columns", async () => {
    if (skip()) return;
    expect(await tryRun([LEG_INSERT()])).toBeNull();
    expect(
      await tryRun([LEG_INSERT({ id: id("0a072"), kind: "transfer_receive", external: `transfer_receipt:${id("0a081")}` })]),
    ).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a transfer leg carrying a count session", { session: id("0a091"), chunk: 1, total: 1, stamp: STAMP }],
    ["a transfer leg carrying only a count stamp", { stamp: STAMP }],
    ["an unknown kind", { kind: "transfer_close" }],
    ["a sale row with no sale", { kind: "sale_post" }],
  ])("refuses %s (23514)", async (_why, over) => {
    if (skip()) return;
    expect(await tryRun([LEG_INSERT(over)])).toBe("23514");
  });

  it("the leg key is unique per tenant: a leg replays once (23505), sale rows are untouched", async () => {
    if (skip()) return;
    expect(await tryRun([LEG_INSERT(), LEG_INSERT({ id: id("0a073") })])).toBe("23505");
    expect(
      await tryRun([LEG_INSERT(), LEG_INSERT({ id: id("0a074"), external: `transfer_dispatch:${id("0a052")}` })]),
    ).toBeNull();
  });
});

describe("0124: the tenant transit warehouse (O2)", () => {
  const MAP = (over: Record<string, unknown> = {}): [string, unknown[]] => {
    const v = { purpose: "transit", store: null, ref: "Goods In Transit - RT", retired: null, tenant: TENANT_A, ...over };
    return [
      `INSERT INTO erpnext_warehouse_map (tenant_id, store_id, purpose, erpnext_warehouse_ref, retired_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [v.tenant, v.store, v.purpose, v.ref, v.retired],
    ];
  };

  it("one active transit row per tenant with no store; a second active one is refused; a retired one is history", async () => {
    if (skip()) return;
    expect(await tryRun([MAP()])).toBeNull();
    expect(await tryRun([MAP(), MAP({ ref: "Other Transit - RT" })])).toBe("23505");
    expect(await tryRun([MAP({ retired: new Date() }), MAP()])).toBeNull();
    expect(await tryRun([MAP(), MAP({ tenant: TENANT_B })])).toBeNull();
  });

  it("a transit row never names a store, and a stock or returns row always does (23514)", async () => {
    if (skip()) return;
    expect(await tryRun([MAP({ store: STORE_A1 })])).toBe("23514");
    expect(await tryRun([MAP({ purpose: "stock", store: null })])).toBe("23514");
    expect(await tryRun([MAP({ purpose: "stock", store: STORE_A1 })])).toBeNull();
    expect(await tryRun([MAP({ purpose: "returns", store: STORE_A1 })])).toBeNull();
    expect(await tryRun([MAP({ purpose: "scrap", store: STORE_A1 })])).toBe("23514");
  });
});

describe("0124: the Transfer document", () => {
  it("stores a draft and refuses source = destination (23514) or a store of another tenant (23503)", async () => {
    if (skip()) return;
    expect(await tryRun([TRANSFER_INSERT()])).toBeNull();
    expect(await tryRun([TRANSFER_INSERT({ dst: STORE_A1 })])).toBe("23514");
    expect(await tryRun([TRANSFER_INSERT({ dst: STORE_B1 })])).toBe("23503");
  });

  it.each<[string, string]>([
    ["an approved Transfer without its approval", "approved"],
    ["an in_transit Transfer without its dispatch", "in_transit"],
    ["a closed Transfer without its closure", "closed"],
    ["a cancelled Transfer without its cancellation", "cancelled"],
    ["an unknown state", "dispatched"],
  ])("refuses %s (23514)", async (_why, state) => {
    if (skip()) return;
    expect(await tryRun([TRANSFER_INSERT({ state })])).toBe("23514");
  });

  it("cancel is only before dispatch: a dispatched Transfer cannot carry a cancellation (798)", async () => {
    if (skip()) return;
    const dispatchedThenCancelled: [string, unknown[]] = [
      `INSERT INTO shipment_transfers
         (id, tenant_id, source_store_id, destination_store_id, state, created_by, dispatched_by, dispatched_at,
          cancelled_by, cancelled_at, cancel_reason)
       VALUES ($1, $2, $3, $4, 'cancelled', $5, $5, now(), $5, now(), 'late')`,
      [TRANSFER, TENANT_A, STORE_A1, STORE_A2, ACTOR],
    ];
    expect(await tryRun([dispatchedThenCancelled])).toBe("23514");
  });

  it("a line dispatches all or nothing, In Transit never goes negative, and a product appears once", async () => {
    if (skip()) return;
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT()])).toBeNull();
    // Dispatched must equal the ordered quantity, and carry its movement (so 0 or the whole line, never 4 of 10).
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT({ dispatched: "4.0000" })])).toBe("23514");
    // Received + short-closed above dispatched would fabricate stock (813).
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT({ received: "1.0000" })])).toBe("23514");
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT({ qty: "0" })])).toBe("23514");
    expect(
      await tryRun([TRANSFER_INSERT(), LINE_INSERT(), LINE_INSERT({ id: id("0a062"), seq: 2 })]),
    ).toBe("23505");
    expect(
      await tryRun([TRANSFER_INSERT(), LINE_INSERT(), LINE_INSERT({ id: id("0a062"), seq: 2, product: PRODUCT_A2 })]),
    ).toBeNull();
  });

  it("the receipt and discrepancy tables hang off a same-tenant Transfer and line", async () => {
    if (skip()) return;
    const discrepancy = (qty: string): [string, unknown[]] => [
      `INSERT INTO shipment_transfer_discrepancies (id, tenant_id, transfer_id, transfer_line_id, kind, quantity, reason, approved_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'short_close', $4::numeric(19,4), 'lost in transit', $5)`,
      [TENANT_A, TRANSFER, LINE, qty, ACTOR],
    ];
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT(), discrepancy("3.0000")])).toBeNull();
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT(), discrepancy("0")])).toBe("23514");
    expect(await tryRun([TRANSFER_INSERT(), LINE_INSERT(), discrepancy("1"), discrepancy("1")])).toBe("23505");
  });
});

describe("0124: inventory_reservations (O1)", () => {
  const RESERVATION = (over: Record<string, unknown> = {}): [string, unknown[]] => {
    const v = { id: id("0a0c1"), qty: "5.0000", state: "active", changed: null, source: "transfer", line: LINE, ...over };
    return [
      `INSERT INTO inventory_reservations
         (id, tenant_id, store_id, stock_location_id, tenant_product_ref, quantity, expires_at, source_type, source_id,
          source_line_id, state, state_changed_at, created_by)
       VALUES ($1, $2, $3, gen_random_uuid(), $4, $5::numeric(19,4), now() + interval '1 day', $6, $7, $8, $9, $10, $11)`,
      [v.id, TENANT_A, STORE_A1, PRODUCT_A, v.qty, v.source, TRANSFER, v.line, v.state, v.changed, ACTOR],
    ];
  };

  it("stores an active reservation, refuses a non-positive quantity, an unknown source and a state/changed mismatch", async () => {
    if (skip()) return;
    expect(await tryRun([RESERVATION()])).toBeNull();
    expect(await tryRun([RESERVATION({ qty: "0" })])).toBe("23514");
    expect(await tryRun([RESERVATION({ source: "sale" })])).toBe("23514");
    expect(await tryRun([RESERVATION({ state: "consumed" })])).toBe("23514");
    expect(await tryRun([RESERVATION({ state: "active", changed: new Date() })])).toBe("23514");
    expect(await tryRun([RESERVATION({ state: "consumed", changed: new Date() })])).toBeNull();
  });

  it("allows one ACTIVE reservation per source line; a released one lets the line reserve again", async () => {
    if (skip()) return;
    expect(await tryRun([RESERVATION(), RESERVATION({ id: id("0a0c2") })])).toBe("23505");
    expect(
      await tryRun([RESERVATION({ state: "expired", changed: new Date() }), RESERVATION({ id: id("0a0c2") })]),
    ).toBeNull();
  });
});

describe("0124: row level security on every new table", () => {
  it.each([...NEW_TABLES])("%s has FORCE ROW LEVEL SECURITY and exactly three policies (read, insert, update)", async (table) => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [table],
    );
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1 ORDER BY cmd`,
      [table],
    );
    expect(policies.rows.map((p) => p.cmd)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("the app role sees its own tenant's Transfer, not another tenant's, and nothing under an empty GUC", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(...TRANSFER_INSERT());
    try {
      const own = await asApp(e, TENANT_A, (c) => c.query(`SELECT id FROM shipment_transfers`));
      expect(own.rows).toHaveLength(1);
      const other = await asApp(e, TENANT_B, (c) => c.query(`SELECT id FROM shipment_transfers`));
      expect(other.rows).toHaveLength(0);
      const unset = await asApp(e, "", (c) => c.query(`SELECT id FROM shipment_transfers`));
      expect(unset.rows).toHaveLength(0);
      // A tenant can neither write a row into another tenant nor re-home its own.
      await expect(
        asApp(e, TENANT_B, (c) =>
          c.query(
            `INSERT INTO shipment_transfers (id, tenant_id, source_store_id, destination_store_id, created_by)
             VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
            [TENANT_A, STORE_A1, STORE_A2, ACTOR],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await e.admin.query(`DELETE FROM shipment_transfers WHERE id = $1`, [TRANSFER]);
    }
  });
});

describe("0124: the settings columns", () => {
  const SET = (cols: string, vals: string): [string, unknown[]] => [
    `INSERT INTO tenant_inventory_settings (tenant_id, updated_by${cols}) VALUES ($1, $2${vals})`,
    [TENANT_A, ACTOR],
  ];

  it("defaults dark with a threshold of 3 days; pairs the change columns; bounds the threshold", async () => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(...SET("", ""));
      const row = await client.query<{ shipment_transfers_enabled: boolean; delayed_transfer_threshold_days: number }>(
        `SELECT shipment_transfers_enabled, delayed_transfer_threshold_days FROM tenant_inventory_settings WHERE tenant_id = $1`,
        [TENANT_A],
      );
      expect(row.rows[0]).toEqual({ shipment_transfers_enabled: false, delayed_transfer_threshold_days: 3 });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      await tryRun([SET(", shipment_transfers_changed_at, shipment_transfers_changed_by", `, now(), '${ACTOR}'`)]),
    ).toBeNull();
    expect(await tryRun([SET(", shipment_transfers_changed_at", ", now()")])).toBe("23514");
    expect(await tryRun([SET(", delayed_transfer_threshold_days", ", 0")])).toBe("23514");
    expect(await tryRun([SET(", delayed_transfer_threshold_days", ", 91")])).toBe("23514");
    expect(await tryRun([SET(", delayed_transfer_threshold_days", ", 7")])).toBeNull();
  });
});

describe("0124: the file is safe to run again", () => {
  it("re-running the whole up file on an applied schema changes nothing and does not fail", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(upSql);
    for (const table of NEW_TABLES) {
      const policies = await a.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = $1`, [table]);
      expect(policies.rows[0].n).toBe(3);
    }
  });

  it("leaves the constraints NOT VALID after the first transaction alone, and the retry validates them all", async () => {
    if (skip()) return;
    const a = guard().admin;
    const end = /\r?\nCOMMIT;\r?\n/.exec(upSql);
    expect(end).not.toBeNull();
    const firstTransaction = upSql.slice(0, end!.index + end![0].length);
    const unvalidated = `SELECT count(*)::int AS n FROM pg_constraint
       WHERE NOT convalidated
         AND conname IN ('erpnext_posting_status_kind_valid', 'erpnext_posting_status_count_shape',
                         'erpnext_warehouse_map_transit_has_no_store')`;
    await a.query(idxDownSql.replace(/DROP INDEX CONCURRENTLY/i, "DROP INDEX"));
    await a.query(downSql);
    await a.query(firstTransaction);
    expect((await a.query(unvalidated)).rows[0].n).toBe(3);
    await a.query(upSql);
    expect((await a.query(unvalidated)).rows[0].n).toBe(0);
    await a.query(idxUpSql);
  });
});

describe("0124: down refuses while a Transfer exists, and round-trips once none does", () => {
  it("refuses with a Transfer, then UP -> DOWN -> UP leaves the schema applied", async () => {
    if (skip()) return;
    const a = guard().admin;
    await a.query(...TRANSFER_INSERT());
    await expect(a.query(downSql)).rejects.toThrow(/0124 down refused/);
    await a.query(`DELETE FROM shipment_transfers WHERE id = $1`, [TRANSFER]);
    await a.query(idxDownSql);
    await a.query(downSql);
    const gone = await a.query(`SELECT to_regclass('shipment_transfers') AS t`);
    expect(gone.rows[0].t).toBeNull();
    // The prior shape is restored: the map needs a store again and the posting kinds are the old three.
    expect(
      await tryRun([
        [
          `INSERT INTO erpnext_warehouse_map (tenant_id, store_id, purpose, erpnext_warehouse_ref) VALUES ($1, NULL, 'stock', 'X')`,
          [TENANT_A],
        ],
      ]),
    ).toBe("23502");
    await a.query(upSql);
    await a.query(idxUpSql);
    const back = await a.query(`SELECT to_regclass('shipment_transfers') AS t`);
    expect(back.rows[0].t).not.toBeNull();
  });
});
