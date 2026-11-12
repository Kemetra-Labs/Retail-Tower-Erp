/**
 * RT-1312 Phase 3(b): `0093_sale_quarantine_items` migration test (the POS sale
 * quarantine store; contracts `pos-sales/sale-quarantine.yaml` 1.0.0-draft and
 * `sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft).
 *
 * Validates `packages/db/drizzle/0093_sale_quarantine_items.sql` (+ `.down.sql`):
 *   - FORCE RLS and the exact policy set: SELECT + INSERT + UPDATE, no DELETE;
 *   - UNIQUE (tenant_id, source_system, external_id): one item per provenance
 *     in a tenant, whatever the store (the upload's natural key);
 *   - the composite FKs: the store, the uploading device, the earlier pairing's
 *     device and the captured sale all belong to the row's tenant AND store;
 *   - the CHECKs: the till's reason rules, the state machine (resolved_at,
 *     sale_id, write-off note and kept body agree with state), the repair
 *     columns set together, the summary formats, bounded text;
 *   - tenant isolation under FORCE RLS, no DELETE, no move to another tenant;
 *   - UP -> DOWN -> UP, also as a NOSUPERUSER migration owner, and the down
 *     REFUSES while any item exists.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0093_sale_quarantine_items.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0093_sale_quarantine_items.down.sql");

const id = (n: string): string => `09300000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_A_OLD = id("0a022"); // tenant A, store A, revoked (an earlier pairing)
const DEVICE_A2 = id("0a023"); // tenant A, store A2
const DEVICE_B = id("0b021");
const ACTOR = id("0a0a1");
const SALE_A = id("0a031");
const SALE_A2 = id("0a032"); // tenant A, store A2
const SALE_B = id("0b031");
const ITEM_A = id("0a041");
const ITEM_A2 = id("0a042");
const ITEM_B = id("0b041");
const MISSING = id("0f0f9");

const T = "sale_quarantine_items";
const DIGEST = "a".repeat(64);

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

async function seedSale(saleId: string, tenantId: string, storeId: string, deviceId: string, ext: string): Promise<void> {
  await guard().admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, device_id)
     VALUES ($1, $2, $3, 'USD', 10, '2026-11-08T10:00:00Z', '2026-11-08', 'pos', $5, repeat('a', 64), $6, $4)`,
    [saleId, tenantId, storeId, deviceId, ext, ACTOR],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0093-sale-quarantine-items.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  // Setup errors from here on are real failures: never skipped.
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'sq-a', 'SQ A', 'USD'), ($2, 'sq-b', 'SQ B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $5, $6, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('a2', 32), 'hex')),
            ($3, $5, $7, decode(repeat('a3', 32), 'hex')), ($4, $8, $9, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_A_OLD, DEVICE_A2, DEVICE_B, TENANT_A, STORE_A, STORE_A2, TENANT_B, STORE_B],
  );
  // The earlier pairing is revoked: the quarantine still names it (a historical fact).
  await a.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [DEVICE_A_OLD]);
  await seedSale(SALE_A, TENANT_A, STORE_A, DEVICE_A, "ext-sale-a");
  await seedSale(SALE_A2, TENANT_A, STORE_A2, DEVICE_A2, "ext-sale-a2");
  await seedSale(SALE_B, TENANT_B, STORE_B, DEVICE_B, "ext-sale-b");
  await a.query(upSql);
  // The app role's table grants are taken after the table exists.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface ItemRow {
  id: string;
  tenant_id: string;
  store_id: string;
  device_id: string;
  previous_terminal_id: string | null;
  source_system: string;
  external_id: string;
  idempotency_key: string;
  reason_kind: string;
  till_http_status: number | null;
  till_error_code: string | null;
  till_recorded_at: string;
  received_at: string;
  sale_body: string | null;
  body_purged_at: string | null;
  facts_digest: string;
  summary_occurred_at: string | null;
  summary_pos_total: string | null;
  summary_currency_code: string | null;
  summary_line_count: number | null;
  state: string;
  resolved_at: string | null;
  repair_count: number;
  last_repair_at: string | null;
  last_repair_outcome: string | null;
  last_repair_http_status: number | null;
  last_repair_error_code: string | null;
  upload_conflict_count: number;
  sale_id: string | null;
  write_off_note: string | null;
}

const RECEIVED = "2026-11-11T10:00:00Z";
const LATER = "2026-11-11T11:00:00Z";
const BODY = JSON.stringify({ sourceSystem: "pos", externalId: "ext-1", posTotal: "10.00", lines: [] });

const ITEM: ItemRow = {
  id: ITEM_A,
  tenant_id: TENANT_A,
  store_id: STORE_A,
  device_id: DEVICE_A,
  previous_terminal_id: null,
  source_system: "pos",
  external_id: "ext-1",
  idempotency_key: "ext-1-idempotency-key",
  reason_kind: "refused",
  till_http_status: 422,
  till_error_code: "sale_tender_mismatch",
  till_recorded_at: "2026-11-11T09:59:00Z",
  received_at: RECEIVED,
  sale_body: BODY,
  body_purged_at: null,
  facts_digest: DIGEST,
  summary_occurred_at: "2026-11-11T09:00:00Z",
  summary_pos_total: "10.00",
  summary_currency_code: "USD",
  summary_line_count: 0,
  state: "open",
  resolved_at: null,
  repair_count: 0,
  last_repair_at: null,
  last_repair_outcome: null,
  last_repair_http_status: null,
  last_repair_error_code: null,
  upload_conflict_count: 0,
  sale_id: null,
  write_off_note: null,
};
const ITEM_OF_B: ItemRow = { ...ITEM, id: ITEM_B, tenant_id: TENANT_B, store_id: STORE_B, device_id: DEVICE_B };
const HELD: Partial<ItemRow> = {
  reason_kind: "held_previous_pairing",
  till_http_status: null,
  till_error_code: null,
  previous_terminal_id: DEVICE_A_OLD,
};
const CAPTURED: Partial<ItemRow> = {
  state: "captured",
  resolved_at: LATER,
  sale_id: SALE_A,
  repair_count: 1,
  last_repair_at: LATER,
  last_repair_outcome: "captured",
};
const WRITTEN_OFF: Partial<ItemRow> = { state: "written-off", resolved_at: LATER, write_off_note: "refunded in cash" };

const COLS = Object.keys(ITEM) as (keyof ItemRow)[];
const INSERT = `INSERT INTO ${T} (${COLS.join(", ")}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(", ")})`;
const values = (row: ItemRow): unknown[] => COLS.map((c) => row[c]);
const row = (change: Partial<ItemRow> = {}): unknown[] => values({ ...ITEM, ...change });

interface Refusal {
  code: string;
  constraint: string | undefined;
}

/** Run `fn` as the superuser inside a transaction that is always rolled back. */
async function inTx(
  fn: (client: PoolClient, attempt: (sql: string, params: unknown[]) => Promise<Refusal | null>) => Promise<void>,
): Promise<void> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    const attempt = async (sql: string, params: unknown[]): Promise<Refusal | null> => {
      await client.query("SAVEPOINT s");
      try {
        await client.query(sql, params);
        return null;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        return { code: e.code ?? "unknown", constraint: e.constraint };
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
    };
    await fn(client, attempt);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Error code of one statement run on its own in a rolled-back transaction. */
async function code(sql: string, params: unknown[]): Promise<string | null> {
  let result: string | null = null;
  await inTx(async (_client, attempt) => {
    result = (await attempt(sql, params))?.code ?? null;
  });
  return result;
}

const fk = (r: Refusal | null): string | null => (r ? `${r.code}:${r.constraint}` : null);

async function clearAll(): Promise<void> {
  await guard().admin.query(`DELETE FROM ${T}`);
}

describe("0093: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0093: RLS and policies", () => {
  it("forces RLS with SELECT + INSERT + UPDATE policies and no DELETE policy", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [T],
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await guard().admin.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname COLLATE "C"`,
      [T],
    );
    expect(policies.rows).toEqual([
      { policyname: `${T}_tenant_insert`, cmd: "INSERT" },
      { policyname: `${T}_tenant_select`, cmd: "SELECT" },
      { policyname: `${T}_tenant_update`, cmd: "UPDATE" },
    ]);
  });
});

describe("0093: valid rows", () => {
  it.each<[string, Partial<ItemRow>]>([
    ["an open refused item", {}],
    ["a refused item with an unknown status and code", { till_http_status: null, till_error_code: null }],
    ["a refused item from an earlier pairing (a revoked device of the store)", { previous_terminal_id: DEVICE_A_OLD }],
    ["a capture 404 refusal", { till_http_status: 404, till_error_code: "not_found" }],
    ["a payload divergence (409)", { reason_kind: "payload_divergence", till_http_status: 409, till_error_code: "idempotency_key_conflict" }],
    ["a payload divergence with an unknown status", { reason_kind: "payload_divergence", till_http_status: null, till_error_code: null }],
    ["a cashier claim refusal (403)", { reason_kind: "cashier_claim_refused", till_http_status: 403, till_error_code: "refused" }],
    ["a held item", HELD],
    ["an item with an all-null summary", { summary_occurred_at: null, summary_pos_total: null, summary_currency_code: null, summary_line_count: null }],
    ["an item with a 4-decimal total", { summary_pos_total: "123456789012345.1234" }],
    ["an open item refused again by a repair", { repair_count: 2, last_repair_at: LATER, last_repair_outcome: "refused", last_repair_http_status: 422, last_repair_error_code: "sale_line_pricing_invalid" }],
    ["an open item whose repair could not prove the operator", { repair_count: 1, last_repair_at: LATER, last_repair_outcome: "refused", last_repair_http_status: null, last_repair_error_code: "repair_operator_unproven" }],
    ["a captured item", CAPTURED],
    ["an already-captured item", { ...CAPTURED, state: "already-captured", last_repair_outcome: "already-captured" }],
    ["a captured item whose body was purged", { ...CAPTURED, sale_body: null, body_purged_at: "2026-12-11T11:00:00Z" }],
    ["a written-off item (no repair)", WRITTEN_OFF],
    ["a written-off item after a refused repair", { ...WRITTEN_OFF, repair_count: 1, last_repair_at: LATER, last_repair_outcome: "refused", last_repair_http_status: 409, last_repair_error_code: "idempotency_key_conflict" }],
    ["an item with upload conflicts", { upload_conflict_count: 3 }],
  ])("stores %s", async (_why, change) => {
    if (skip()) return;
    expect(await code(INSERT, row(change))).toBeNull();
  });
});

describe("0093: CHECKs", () => {
  it.each<[string, Partial<ItemRow>]>([
    ["an empty source system", { source_system: "" }],
    ["a source system over 100 characters", { source_system: "s".repeat(101) }],
    ["an empty external id", { external_id: "" }],
    ["an external id over 200 characters", { external_id: "e".repeat(201) }],
    ["an idempotency key under 16 characters", { idempotency_key: "short" }],
    ["an idempotency key over 128 characters", { idempotency_key: "k".repeat(129) }],
    ["an unknown reason kind", { reason_kind: "lost" }],
    ["a till status of 401", { till_http_status: 401 }],
    ["a till status of 425", { till_http_status: 425 }],
    ["a till status of 429", { till_http_status: 429 }],
    ["a till status of 500", { till_http_status: 500 }],
    ["a till status of 399", { till_http_status: 399 }],
    ["an upper-case till error code", { till_error_code: "Bad_Code" }],
    ["a till error code over 64 characters", { till_error_code: `a${"b".repeat(64)}` }],
    ["a held item with a status", { ...HELD, till_http_status: 422 }],
    ["a held item with a code", { ...HELD, till_error_code: "validation_error" }],
    ["a held item without the earlier pairing", { ...HELD, previous_terminal_id: null }],
    ["a payload divergence with a 422", { reason_kind: "payload_divergence", till_http_status: 422 }],
    ["a cashier claim refusal with a 422", { reason_kind: "cashier_claim_refused", till_http_status: 422 }],
    ["a body that is not a JSON object", { sale_body: JSON.stringify([1, 2]) }],
    ["a malformed facts digest", { facts_digest: "XYZ" }],
    ["a total with a sign", { summary_pos_total: "-1.00" }],
    ["a total with 5 decimals", { summary_pos_total: "1.00001" }],
    ["a lower-case currency", { summary_currency_code: "usd" }],
    ["a negative line count", { summary_line_count: -1 }],
    ["an unknown state", { state: "lost" }],
    ["an open item with resolved_at", { resolved_at: LATER }],
    ["a captured item without resolved_at", { ...CAPTURED, resolved_at: null }],
    ["a captured item without a sale", { ...CAPTURED, sale_id: null }],
    ["an open item with a sale", { sale_id: SALE_A }],
    ["a written-off item with a sale", { ...WRITTEN_OFF, sale_id: SALE_A }],
    ["a written-off item without a note", { ...WRITTEN_OFF, write_off_note: null }],
    ["an open item with a write-off note", { write_off_note: "note" }],
    ["an empty write-off note", { ...WRITTEN_OFF, write_off_note: "" }],
    ["a write-off note over 500 characters", { ...WRITTEN_OFF, write_off_note: "n".repeat(501) }],
    ["an open item without its body", { sale_body: null, body_purged_at: LATER }],
    ["a written-off item without its body", { ...WRITTEN_OFF, sale_body: null, body_purged_at: LATER }],
    ["a purge time on a kept body", { ...CAPTURED, body_purged_at: LATER }],
    ["a missing body without a purge time", { ...CAPTURED, sale_body: null }],
    ["a resolution before the first upload", { ...CAPTURED, resolved_at: "2026-11-11T09:00:00Z", last_repair_at: "2026-11-11T09:00:00Z" }],
    ["a negative repair count", { repair_count: -1 }],
    ["a repair count without a last repair", { repair_count: 1 }],
    ["a last repair with a zero count", { last_repair_at: LATER, last_repair_outcome: "refused" }],
    ["a last repair time without its outcome", { repair_count: 1, last_repair_at: LATER }],
    ["an unknown repair outcome", { repair_count: 1, last_repair_at: LATER, last_repair_outcome: "lost" }],
    ["a captured repair outcome with a status", { ...CAPTURED, last_repair_http_status: 422 }],
    ["a captured repair outcome with a code", { ...CAPTURED, last_repair_error_code: "validation_error" }],
    ["a repair status without a repair", { last_repair_http_status: 404 }],
    ["a repair code without a repair", { last_repair_error_code: "validation_error" }],
    ["a refused repair status of 500", { repair_count: 1, last_repair_at: LATER, last_repair_outcome: "refused", last_repair_http_status: 500 }],
    ["a negative conflict count", { upload_conflict_count: -1 }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await code(INSERT, row(change))).toBe("23514");
  });

  it("refuses a missing required column (23502)", async () => {
    if (skip()) return;
    expect(await code(INSERT, row({ device_id: null as unknown as string }))).toBe("23502");
    expect(await code(INSERT, row({ facts_digest: null as unknown as string }))).toBe("23502");
    expect(await code(INSERT, row({ till_recorded_at: null as unknown as string }))).toBe("23502");
  });
});

describe("0093: one item per provenance in a tenant", () => {
  it("refuses a second item of the same provenance, even from another store, and allows it in another tenant", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      await client.query(INSERT, row());
      const dup = { constraint: "sale_quarantine_items_tenant_provenance_uk", code: "23505" };
      expect(await attempt(INSERT, row({ id: ITEM_A2 }))).toEqual(dup);
      expect(await attempt(INSERT, row({ id: ITEM_A2, store_id: STORE_A2, device_id: DEVICE_A2 }))).toEqual(dup);
      // Another external id in the same tenant is fine.
      expect(await attempt(INSERT, row({ id: ITEM_A2, external_id: "ext-2" }))).toBeNull();
      // The same provenance in another tenant is fine.
      expect(await attempt(INSERT, values(ITEM_OF_B))).toBeNull();
    });
  });
});

describe("0093: composite FKs", () => {
  it("pins the store, the uploading device, the earlier pairing and the sale to the row's tenant and store (23503)", async () => {
    if (skip()) return;
    await inTx(async (_client, attempt) => {
      // Another tenant's store (also trips the device FK, so the code only).
      expect((await attempt(INSERT, row({ store_id: STORE_B })))?.code).toBe("23503");
      // The uploading device: another store, another tenant, missing.
      for (const device of [DEVICE_A2, DEVICE_B, MISSING]) {
        expect(fk(await attempt(INSERT, row({ device_id: device })))).toBe("23503:fk_sale_quarantine_items_device_store_tenant");
      }
      // The earlier pairing: another store, another tenant, missing.
      for (const device of [DEVICE_A2, DEVICE_B, MISSING]) {
        expect(fk(await attempt(INSERT, row({ previous_terminal_id: device })))).toBe(
          "23503:fk_sale_quarantine_items_previous_terminal_store_tenant",
        );
      }
      // The sale: another store, another tenant, missing.
      for (const sale of [SALE_A2, SALE_B, MISSING]) {
        expect(fk(await attempt(INSERT, row({ ...CAPTURED, sale_id: sale })))).toBe("23503:fk_sale_quarantine_items_sale_store_tenant");
      }
      // The same-store rows are accepted.
      expect(fk(await attempt(INSERT, row({ ...CAPTURED, previous_terminal_id: DEVICE_A_OLD })))).toBeNull();
    });
  });

  it("refuses to delete a device or sale that an item cites (23503, ON DELETE RESTRICT)", async () => {
    if (skip()) return;
    try {
      await guard().admin.query(INSERT, row({ ...CAPTURED, previous_terminal_id: DEVICE_A_OLD }));
      expect(await code(`DELETE FROM devices WHERE id = $1`, [DEVICE_A_OLD])).toBe("23503");
      expect(await code(`DELETE FROM sales WHERE id = $1`, [SALE_A])).toBe("23503");
    } finally {
      await clearAll();
    }
  });
});

describe("0093: updated_at trigger", () => {
  it("moves updated_at forward on UPDATE", async () => {
    if (skip()) return;
    await inTx(async (client) => {
      await client.query(`${INSERT.replace(") VALUES (", ", updated_at) VALUES (").replace(/\)$/, `, $${COLS.length + 1})`)}`, [
        ...row(),
        "2026-01-01T00:00:00Z",
      ]);
      await client.query(`UPDATE ${T} SET upload_conflict_count = upload_conflict_count + 1 WHERE id = $1`, [ITEM_A]);
      const after = await client.query<{ moved: boolean }>(
        `SELECT updated_at > '2026-01-01T00:00:00Z'::timestamptz AS moved FROM ${T} WHERE id = $1`,
        [ITEM_A],
      );
      expect(after.rows).toEqual([{ moved: true }]);
    });
  });
});

describe("0093: tenant isolation (FORCE RLS)", () => {
  it("lets the app role read and update only its own tenant's COMMITTED rows, never delete or move one", async () => {
    if (skip()) return;
    try {
      await guard().admin.query(INSERT, row());
      await asApp(guard(), TENANT_A, async (client) => {
        expect((await client.query(`SELECT id FROM ${T}`)).rows).toEqual([{ id: ITEM_A }]);
        await client.query("SAVEPOINT other");
        await expect(client.query(INSERT, values(ITEM_OF_B))).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other");
        // The conditional state write wins once.
        const writeOff = `UPDATE ${T} SET state = 'written-off', resolved_at = now(), write_off_note = 'n'
                           WHERE tenant_id = $1 AND id = $2 AND state = 'open'`;
        expect((await client.query(writeOff, [TENANT_A, ITEM_A])).rowCount).toBe(1);
        expect((await client.query(writeOff, [TENANT_A, ITEM_A])).rowCount).toBe(0);
        await client.query("SAVEPOINT move");
        await expect(client.query(`UPDATE ${T} SET tenant_id = $1 WHERE id = $2`, [TENANT_B, ITEM_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT move");
        expect((await client.query(`DELETE FROM ${T}`)).rowCount).toBe(0);
      });
      await asApp(guard(), TENANT_B, async (client) => {
        await client.query(INSERT, values(ITEM_OF_B));
        expect((await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${T}`)).rows).toEqual([{ tenant_id: TENANT_B }]);
        expect((await client.query(`UPDATE ${T} SET upload_conflict_count = 9 WHERE id = $1`, [ITEM_A])).rowCount).toBe(0);
        expect((await client.query(`UPDATE ${T} SET upload_conflict_count = 9`)).rowCount).toBe(1);
      });
      const a = await guard().admin.query<{ upload_conflict_count: number; state: string }>(
        `SELECT upload_conflict_count, state FROM ${T} WHERE id = $1`,
        [ITEM_A],
      );
      // asApp rolls back: tenant A's committed row is unchanged by both sessions.
      expect(a.rows).toEqual([{ upload_conflict_count: 0, state: "open" }]);
    } finally {
      await clearAll();
    }
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    try {
      await guard().admin.query(INSERT, row());
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${T}`)).rowCount).toBe(0);
      });
    } finally {
      await clearAll();
    }
  });
});

describe("0093: UP -> DOWN -> UP", () => {
  const exists = async (): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [T])).rows[0]!.t !== null;
  const OWNER_TABLES = ["tenants", "stores", "devices", "sales", T];

  it("refuses while an item exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    const owner = { role: "rt1312_refuse_owner", tables: OWNER_TABLES, functions: [] };
    try {
      await e.admin.query(INSERT, row());
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await exists()).toBe(true);
      expect((await e.admin.query(`SELECT 1 FROM ${T}`)).rowCount).toBe(1);
    } finally {
      await clearAll();
    }
  });

  it("drops the table once empty, is rerunnable, and the up recreates it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists()).toBe(false);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists()).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt1312_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists()).toBe(true);
  });
});
