/**
 * RT-451 S6: `0095_posting_resolution_tracking` migration test ([GATED]
 * migration; owner approval RT-451 comment 16535, RT-1283 comment 16534 item 4).
 *
 * Applies every migration before 0095 against a real Postgres, seeds a pending
 * intent with a frozen resolution line, applies 0095 exactly as the runner does
 * (one `query()` for the file), and proves:
 *   - the existing line survives with the four new columns NULL, and the four
 *     CHECKs are validated;
 *   - the CHECKs accept the shapes the freeze writes (an untracked line, a
 *     tracked line with its Batch, the two row-3 holds) and refuse every
 *     inconsistent one;
 *   - down refuses while a tracked line is frozen, also as a NOSUPERUSER
 *     migration owner under FORCE RLS, where a bare SELECT would see no rows;
 *   - UP -> DOWN -> UP round-trips once none is, also run by that owner.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0095_posting_resolution_tracking.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0095_posting_resolution_tracking.down.sql");

const id = (n: string): string => `09500000-0000-7000-8000-0000000${n}`;
const TENANT = id("0a001");
const STORE = id("0a011");
const ACTOR = id("0a021");
const SALE = id("0a031");
const LINE = id("0a041");
const INTENT = id("0a051");
const IDENTITY = id("0a061");
const CHECKS = [
  "erpnext_posting_resolution_batch_ref_length",
  "erpnext_posting_resolution_hold_cause_valid",
  "erpnext_posting_resolution_tracking_consistent",
  "erpnext_posting_resolution_tracking_mode_valid",
];
const COLUMNS = ["erp_hold_cause", "erpnext_batch_ref", "tracking_identity_id", "tracking_mode"];

let env: PgTestEnv | null = null;
const skip = (): boolean => env === null;
function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

/** Tracking columns of one resolution line. */
interface Tracking {
  readonly mode: string | null;
  readonly identity: string | null;
  readonly batch: string | null;
  readonly hold: string | null;
}

/** Insert resolution line `version` with `t`; returns the SQLSTATE or null. */
async function insertLine(version: number, t: Tracking): Promise<string | null> {
  try {
    await pg().admin.query(
      `INSERT INTO erpnext_posting_resolution
         (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
          warehouse_ref, warehouse_map_id, resolved_by,
          tracking_mode, tracking_identity_id, erpnext_batch_ref, erp_hold_cause)
       VALUES ($1, $2, $3, $4, 'ITEM-1', gen_random_uuid(), 'WH-1', gen_random_uuid(), 'system',
               $5, $6, $7, $8)`,
      [TENANT, INTENT, version, LINE, t.mode, t.identity, t.batch, t.hold],
    );
    return null;
  } catch (err: unknown) {
    return (err as { code?: string }).code ?? String(err);
  }
}

async function validatedChecks(): Promise<string[]> {
  const r = await pg().admin.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) AND convalidated ORDER BY conname`,
    [CHECKS],
  );
  return r.rows.map((row) => row.conname);
}

async function columns(): Promise<string[]> {
  const r = await pg().admin.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'erpnext_posting_resolution'
        AND column_name = ANY($1::text[]) ORDER BY column_name`,
    [COLUMNS],
  );
  return r.rows.map((row) => row.column_name);
}

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0095 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt451-s6-mig', 'T')`, [TENANT]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S', 'S')`, [STORE, TENANT]);
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'a@rt451-s6.example')`, [ACTOR]);
  await a.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 10, now(), current_date, 'pos-0095', 'sale-0095', repeat('c', 64), $4)`,
    [SALE, TENANT, STORE, ACTOR],
  );
  await a.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit)
     VALUES ($1, $2, $3, $4, 'L', 10, 'EGP', 1, 10, 'pcs')`,
    [LINE, SALE, TENANT, STORE],
  );
  await a.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id,
        payload_hash, status, current_resolution_version)
     VALUES ($1, $2, $3, $4, 'sale_post', $4, 'pos-0095', 'sale-0095', repeat('a', 64), 'pending', 1)`,
    [INTENT, TENANT, STORE, SALE],
  );
  await a.query(
    `INSERT INTO erpnext_posting_resolution
       (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id,
        warehouse_ref, warehouse_map_id, resolved_by)
     VALUES ($1, $2, 1, $3, 'ITEM-1', gen_random_uuid(), 'WH-1', gen_random_uuid(), 'system')`,
    [TENANT, INTENT, LINE],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Each accepted line takes its own resolution version (the PK is intent, version, line). */
let nextVersion = 100;

const NONE: Tracking = { mode: null, identity: null, batch: null, hold: null };

describe("0095 up", () => {
  it("adds the four nullable columns; the existing line survives unfrozen; all four CHECKs are validated", async () => {
    if (skip()) return;
    expect(await columns()).toEqual([]);
    await pg().admin.query(readFileSync(UP_PATH, "utf8"));
    expect(await columns()).toEqual(COLUMNS);
    const r = await pg().admin.query(
      `SELECT tracking_mode, tracking_identity_id, erpnext_batch_ref, erp_hold_cause
         FROM erpnext_posting_resolution WHERE intent_id = $1`,
      [INTENT],
    );
    expect(r.rows).toEqual([
      { tracking_mode: null, tracking_identity_id: null, erpnext_batch_ref: null, erp_hold_cause: null },
    ]);
    expect(await validatedChecks()).toEqual(CHECKS);
  });

  it.each<[string, Tracking]>([
    ["an untracked line", { ...NONE, mode: "none" }],
    ["a switched-off batch line (no identity)", { ...NONE, mode: "batch" }],
    ["a serial line (no identity)", { ...NONE, mode: "serial" }],
    ["a tracked line with its Batch", { mode: "batch", identity: IDENTITY, batch: "BATCH-0001", hold: null }],
    ["row 3, no edge-map row", { mode: "batch", identity: IDENTITY, batch: null, hold: "edge_map_missing" }],
    ["row 3, expired, with its Batch", { mode: "batch", identity: IDENTITY, batch: "BATCH-0001", hold: "expired" }],
    ["row 3, expired, no edge-map row", { mode: "batch", identity: IDENTITY, batch: null, hold: "expired" }],
    ["a 140-character Batch", { mode: "batch", identity: IDENTITY, batch: "B".repeat(140), hold: null }],
  ])("accepts %s", async (_label, t) => {
    if (skip()) return;
    nextVersion += 1;
    expect(await insertLine(nextVersion, t)).toBeNull();
  });

  it.each<[string, Tracking]>([
    ["an unknown mode", { ...NONE, mode: "lot" }],
    ["an identity on an untracked line", { mode: "none", identity: IDENTITY, batch: "BATCH-0001", hold: null }],
    ["an identity on a serial line", { mode: "serial", identity: IDENTITY, batch: "SN-1", hold: null }],
    ["a Batch without an identity", { mode: "batch", identity: null, batch: "BATCH-0001", hold: null }],
    ["a hold without an identity", { mode: "batch", identity: null, batch: null, hold: "expired" }],
    ["an identity with neither a Batch nor a hold", { mode: "batch", identity: IDENTITY, batch: null, hold: null }],
    ["edge_map_missing with a Batch", { mode: "batch", identity: IDENTITY, batch: "BATCH-0001", hold: "edge_map_missing" }],
    ["an unknown hold cause", { mode: "batch", identity: IDENTITY, batch: null, hold: "recalled" }],
    ["an empty Batch", { mode: "batch", identity: IDENTITY, batch: "", hold: null }],
    ["a 141-character Batch", { mode: "batch", identity: IDENTITY, batch: "B".repeat(141), hold: null }],
  ])("refuses %s (23514)", async (_label, t) => {
    if (skip()) return;
    expect(await insertLine(2, t)).toBe("23514");
  });
});

describe("0095: UP -> DOWN -> UP", () => {
  const OWNER_TABLES = ["tenants", "erpnext_posting_resolution"];

  it("refuses while a tracked line is frozen, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = pg();
    expect(await insertLine(50, { mode: "batch", identity: IDENTITY, batch: "BATCH-0001", hold: null })).toBeNull();
    expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
    const owner = { role: "rt451_s6_refuse_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(e, owner, async () => {
      expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
    });
    expect(await columns()).toEqual(COLUMNS);
    expect(await validatedChecks()).toEqual(CHECKS);
  });

  it("drops the columns and CHECKs once no tracked line is frozen, is rerunnable, and the up restores them", async () => {
    if (skip()) return;
    const e = pg();
    await e.admin.query(
      `DELETE FROM erpnext_posting_resolution WHERE intent_id = $1 AND tracking_identity_id IS NOT NULL`,
      [INTENT],
    );
    const owner = { role: "rt451_s6_roundtrip_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(e, owner, async () => {
      expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBeNull();
      expect(await columns()).toEqual([]);
      expect(await validatedChecks()).toEqual([]);
      expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(e, UP_PATH, owner.role)).toBeNull();
    });
    expect(await columns()).toEqual(COLUMNS);
    expect(await validatedChecks()).toEqual(CHECKS);
    // The pre-0095 line and the untracked lines written since survive the round trip.
    const r = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM erpnext_posting_resolution WHERE intent_id = $1 AND resolution_version = 1`,
      [INTENT],
    );
    expect(r.rows[0]!.n).toBe("1");
  });
});
