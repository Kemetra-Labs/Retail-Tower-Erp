/**
 * RT-451 S3: `0089_sale_capture_tracking` migration test (M2; captain decision
 * RT-451 comment 16262 under owner delegation RT-1283 comment 16225; content
 * of comment 15288's S3 row).
 *
 * Validates `packages/db/drizzle/0089_sale_capture_tracking.sql` (+ `.down.sql`):
 *   - `sale_lines` gains the frozen tracking snapshot and its G7-9 class: the
 *     snapshot is whole or absent, the closed selection / class / reason sets,
 *     a reason exactly on a row-4 line, and only `tracking_missing` has no
 *     snapshot among classified lines (tracking stored while off is
 *     unclassified, comment 16269). A legacy line (all NULL)
 *     stays valid, and the new CHECKs are NOT VALID (no scan of old rows);
 *   - `sales` gains `safety_revision` (>= 0), `safety_synced_at` and
 *     `tracking_status` (closed set);
 *   - the `sale_line_findings` table: the kind/cause pairs, a hold exactly on
 *     `sold_under_hold`, one finding per (line, kind, cause), the same-tenant
 *     FKs (sale, the identity of the line's own product, the hold); FORCE RLS
 *     with SELECT and INSERT policies only (append-only); an empty tenant GUC
 *     sees nothing;
 *   - the down REFUSES while any tracked sale data exists (a finding, a line's
 *     tracking, a sale's safety provenance or tracking status), also as a
 *     NOSUPERUSER migration owner under FORCE RLS, where a bare SELECT would
 *     see no rows;
 *   - UP -> DOWN -> UP round-trips once none exists, also run by that owner,
 *     and the down is rerunnable.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0089_sale_capture_tracking.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0089_sale_capture_tracking.down.sql");

const id = (n: string): string => `08900000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_B = id("0b021");
const PRODUCT_A = id("0a031");
const PRODUCT_A2 = id("0a032");
const PRODUCT_B = id("0b031");
const ACTOR = id("0a0a1");
const IDENTITY_A = id("0a041");
const IDENTITY_A2 = id("0a042");
const IDENTITY_B = id("0b041");
const HOLD_A = id("0a051");
const HOLD_B = id("0b051");
const SALE_A = id("0a061");
const SALE_B = id("0b061");
const LINE_A = id("0a071");
const LINE_B = id("0b071");

const TABLE = "sale_line_findings";

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
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_NAME);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0089-sale-capture-tracking.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'm2-a', 'M2 A', 'USD'), ($2, 'm2-b', 'M2 B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A1', 'Store A1'), ($2, $4, 'B1', 'Store B1')`,
    [STORE_A, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $3, $4, decode(repeat('a1', 32), 'hex')), ($2, $5, $6, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_B, TENANT_A, STORE_A, TENANT_B, STORE_B],
  );
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by, tracking_mode)
     VALUES ($1, $4, 'Product A', 'standard', $6, $6, 'batch'), ($2, $4, 'Product A2', 'standard', $6, $6, 'batch'),
            ($3, $5, 'Product B', 'standard', $6, $6, 'batch')`,
    [PRODUCT_A, PRODUCT_A2, PRODUCT_B, TENANT_A, TENANT_B, ACTOR],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code)
     VALUES ($1, $4, $5, 'batch', 'LOT-A'), ($2, $4, $6, 'batch', 'LOT-A2'), ($3, $7, $8, 'batch', 'LOT-B')`,
    [IDENTITY_A, IDENTITY_A2, IDENTITY_B, TENANT_A, PRODUCT_A, PRODUCT_A2, TENANT_B, PRODUCT_B],
  );
  await a.query(
    `INSERT INTO tracking_holds (id, tenant_id, tracking_identity_id, tenant_product_ref, kind, reason_code, placed_by)
     VALUES ($1, $3, $4, $5, 'quality_hold', 'supplier_notice', $8), ($2, $6, $7, $9, 'quality_hold', 'supplier_notice', $8)`,
    [HOLD_A, HOLD_B, TENANT_A, IDENTITY_A, PRODUCT_A, TENANT_B, IDENTITY_B, ACTOR, PRODUCT_B],
  );
  await seedSale(SALE_A, TENANT_A, STORE_A, DEVICE_A, "m2-a-1");
  await seedSale(SALE_B, TENANT_B, STORE_B, DEVICE_B, "m2-b-1");
  // A legacy line in each tenant, captured before 0089.
  await a.query(
    `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                             line_amount, unit, tenant_product_ref)
     VALUES ($1, $3, $5, $6, 'A', 10, 'USD', 1, 10, 'pcs', $9), ($2, $4, $7, $8, 'B', 10, 'USD', 1, 10, 'pcs', $10)`,
    [LINE_A, LINE_B, SALE_A, SALE_B, TENANT_A, STORE_A, TENANT_B, STORE_B, PRODUCT_A, PRODUCT_B],
  );
  await a.query(upSql);
  // The app role's table grants are taken after the table exists.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// ---------------------------------------------------------------------------
// sale_lines
// ---------------------------------------------------------------------------

interface LineTracking {
  tracking_identity_id: string | null;
  tracking_code: string | null;
  tracking_expiry_date: string | null;
  tracking_selection: string | null;
  tracking_validation_id: string | null;
  tracking_class: string | null;
  tracking_unresolved_reason: string | null;
}

const VALID_LINE: LineTracking = {
  tracking_identity_id: IDENTITY_A,
  tracking_code: "LOT-A",
  tracking_expiry_date: "2027-03-31",
  tracking_selection: "scanned",
  tracking_validation_id: id("0a081"),
  tracking_class: "valid",
  tracking_unresolved_reason: null,
};
const NO_TRACKING: LineTracking = {
  tracking_identity_id: null,
  tracking_code: null,
  tracking_expiry_date: null,
  tracking_selection: null,
  tracking_validation_id: null,
  tracking_class: null,
  tracking_unresolved_reason: null,
};
const LINE_COLUMNS = Object.keys(VALID_LINE) as (keyof LineTracking)[];

/** Insert one line of SALE_A as the superuser in a rolled-back transaction; the error code or null. */
async function tryLine(tracking: LineTracking): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO sale_lines (sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, unit, tenant_product_ref, ${LINE_COLUMNS.join(", ")})
       VALUES ($1, $2, $3, 'L', 1, 'USD', 1, 1, 'pcs', $4, ${LINE_COLUMNS.map((_, i) => `$${i + 5}`).join(", ")})`,
      [SALE_A, TENANT_A, STORE_A, PRODUCT_A, ...LINE_COLUMNS.map((c) => tracking[c])],
    );
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("0089: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0089: sale_lines tracking snapshot", () => {
  it("keeps the legacy line valid with every new column NULL, and adds the CHECKs NOT VALID", async () => {
    if (skip()) return;
    const legacy = await guard().admin.query(`SELECT ${LINE_COLUMNS.join(", ")} FROM sale_lines WHERE id = $1`, [LINE_A]);
    expect(legacy.rows).toEqual([NO_TRACKING]);
    const unvalidated = await guard().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('sale_lines'::regclass, 'sales'::regclass) AND conname ~ '^(sale_lines_tracking|sales_safety|sales_tracking)'
          AND NOT convalidated ORDER BY conname`,
    );
    expect(unvalidated.rows.map((r) => r.conname)).toEqual([
      "sale_lines_tracking_class_allowed",
      "sale_lines_tracking_code_shape",
      "sale_lines_tracking_expiry_in_range",
      "sale_lines_tracking_missing_has_no_snapshot",
      "sale_lines_tracking_selection_allowed",
      "sale_lines_tracking_snapshot_whole",
      "sale_lines_tracking_unresolved_reason_allowed",
      "sale_lines_tracking_unresolved_reason_iff",
      "sales_safety_revision_non_negative",
      "sales_tracking_status_allowed",
    ]);
  });

  it.each<[string, LineTracking]>([
    ["an untracked line", NO_TRACKING],
    ["a valid line without expiry or validation", { ...VALID_LINE, tracking_expiry_date: null, tracking_validation_id: null }],
    ["a valid line", VALID_LINE],
    ["a flagged line", { ...VALID_LINE, tracking_class: "flagged" }],
    ["a row-4 line with an unknown identity", { ...VALID_LINE, tracking_class: "unresolved", tracking_unresolved_reason: "identity_unknown" }],
    ["a row-4 line with another product's identity", { ...VALID_LINE, tracking_class: "unresolved", tracking_unresolved_reason: "identity_other_product" }],
    ["a row-4 line without tracking", { ...NO_TRACKING, tracking_class: "unresolved", tracking_unresolved_reason: "tracking_missing" }],
    ["tracking stored while off (unclassified, comment 16269)", { ...VALID_LINE, tracking_class: null }],
  ])("accepts %s", async (_why, tracking) => {
    if (skip()) return;
    expect(await tryLine(tracking)).toBeNull();
  });

  it.each<[string, LineTracking]>([
    ["an identity without its code", { ...VALID_LINE, tracking_code: null }],
    ["an identity without its selection", { ...VALID_LINE, tracking_selection: null }],
    ["a code without an identity", { ...NO_TRACKING, tracking_code: "LOT-A" }],
    ["an expiry without an identity", { ...NO_TRACKING, tracking_expiry_date: "2027-01-01" }],
    ["a validation without an identity", { ...NO_TRACKING, tracking_validation_id: id("0a081") }],
    ["an empty code", { ...VALID_LINE, tracking_code: "" }],
    ["a 129-character code", { ...VALID_LINE, tracking_code: "x".repeat(129) }],
    ["an unknown selection", { ...VALID_LINE, tracking_selection: "guessed" }],
    ["an unknown class", { ...VALID_LINE, tracking_class: "maybe" }],
    ["a valid line with a reason", { ...VALID_LINE, tracking_unresolved_reason: "identity_unknown" }],
    ["a row-4 line without a reason", { ...VALID_LINE, tracking_class: "unresolved" }],
    ["an unknown reason", { ...VALID_LINE, tracking_class: "unresolved", tracking_unresolved_reason: "lost" }],
    ["a reason on an unclassified line", { ...NO_TRACKING, tracking_unresolved_reason: "tracking_missing" }],
    ["tracking_missing with a snapshot", { ...VALID_LINE, tracking_class: "unresolved", tracking_unresolved_reason: "tracking_missing" }],
    ["identity_unknown without a snapshot", { ...NO_TRACKING, tracking_class: "unresolved", tracking_unresolved_reason: "identity_unknown" }],
    ["a valid line without a snapshot", { ...NO_TRACKING, tracking_class: "valid" }],
  ])("refuses %s (23514)", async (_why, tracking) => {
    if (skip()) return;
    expect(await tryLine(tracking)).toBe("23514");
  });
});

describe("0089: sales safety provenance and tracking status", () => {
  it.each<[string, string, unknown, string | null]>([
    ["a revision", "safety_revision", 7, null],
    ["revision zero", "safety_revision", 0, null],
    ["a negative revision", "safety_revision", -1, "23514"],
    ["a synced-at instant", "safety_synced_at", "2026-11-08T09:00:00Z", null],
    ["tracked", "tracking_status", "tracked", null],
    ["tracking_unresolved", "tracking_status", "tracking_unresolved", null],
    ["an unknown status", "tracking_status", "resolved", "23514"],
  ])("%s", async (_why, column, value, expected) => {
    if (skip()) return;
    const client = await guard().admin.connect();
    try {
      await client.query("BEGIN");
      const code = await client
        .query(`UPDATE sales SET ${column} = $2 WHERE id = $1`, [SALE_A, value])
        .then(() => null)
        .catch((err: { code?: string }) => err.code ?? "unknown");
      expect(code).toBe(expected);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// sale_line_findings
// ---------------------------------------------------------------------------

interface Finding {
  tenant_id: string;
  store_id: string;
  sale_id: string;
  sale_line_id: string;
  tenant_product_ref: string;
  tracking_identity_id: string;
  kind: string;
  cause: string;
  hold_id: string | null;
  business_date: string;
  occurred_at: string;
}

const FINDING: Finding = {
  tenant_id: TENANT_A,
  store_id: STORE_A,
  sale_id: SALE_A,
  sale_line_id: LINE_A,
  tenant_product_ref: PRODUCT_A,
  tracking_identity_id: IDENTITY_A,
  kind: "unvalidated_tracked_line",
  cause: "validation_missing",
  hold_id: null,
  business_date: "2026-11-08",
  occurred_at: "2026-11-08T10:00:00Z",
};
const FINDING_B: Finding = {
  ...FINDING,
  tenant_id: TENANT_B,
  store_id: STORE_B,
  sale_id: SALE_B,
  sale_line_id: LINE_B,
  tenant_product_ref: PRODUCT_B,
  tracking_identity_id: IDENTITY_B,
};
const F_COLUMNS = Object.keys(FINDING) as (keyof Finding)[];
const INSERT = `INSERT INTO ${TABLE} (${F_COLUMNS.join(", ")}) VALUES (${F_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;
const values = (row: Finding): unknown[] => F_COLUMNS.map((c) => row[c]);

async function tryFinding(...rows: Finding[]): Promise<string | null> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) await client.query(INSERT, values(row));
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("0089: the sale_line_findings table", () => {
  it("creates it with FORCE ROW LEVEL SECURITY and only SELECT and INSERT policies", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
      [TABLE],
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await guard().admin.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 ORDER BY policyname`,
      [TABLE],
    );
    expect(policies.rows).toEqual([
      { policyname: "sale_line_findings_tenant_insert", cmd: "INSERT" },
      { policyname: "sale_line_findings_tenant_read", cmd: "SELECT" },
    ]);
  });

  it.each<[string, Partial<Finding>]>([
    ["unvalidated: validation_missing", {}],
    ["unvalidated: validation_mismatch", { cause: "validation_mismatch" }],
    ["sold under a quality hold", { kind: "sold_under_hold", cause: "quality_hold", hold_id: HOLD_A }],
    ["sold under a recall hold", { kind: "sold_under_hold", cause: "recall_hold", hold_id: HOLD_A }],
    ["ERP intent held: expired", { kind: "erp_intent_held", cause: "expired" }],
    ["ERP intent held: edge map missing", { kind: "erp_intent_held", cause: "edge_map_missing" }],
  ])("records %s", async (_why, change) => {
    if (skip()) return;
    expect(await tryFinding({ ...FINDING, ...change })).toBeNull();
  });

  it("records several kinds and causes on one line, but each (line, kind, cause) once (23505)", async () => {
    if (skip()) return;
    const expired = { ...FINDING, kind: "erp_intent_held", cause: "expired" };
    expect(await tryFinding(FINDING, expired, { ...expired, cause: "edge_map_missing" })).toBeNull();
    expect(await tryFinding(FINDING, FINDING)).toBe("23505");
  });

  it.each<[string, Partial<Finding>]>([
    ["an unknown kind", { kind: "sold_expired" }],
    ["a cause of another kind", { cause: "expired" }],
    ["sold_under_hold without its hold", { kind: "sold_under_hold", cause: "quality_hold" }],
    ["a hold on another kind", { hold_id: HOLD_A }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await tryFinding({ ...FINDING, ...change })).toBe("23514");
  });

  it.each<[string, Partial<Finding>]>([
    ["a sale of another tenant", { sale_id: SALE_B }],
    ["a sale of another store", { store_id: STORE_B }],
    ["another product's identity", { tracking_identity_id: IDENTITY_A2 }],
    ["an identity of another tenant", { tracking_identity_id: IDENTITY_B }],
    ["a hold of another tenant", { kind: "sold_under_hold", cause: "quality_hold", hold_id: HOLD_B }],
    ["an unknown sale line", { sale_line_id: id("0a0ff") }],
  ])("refuses %s (23503)", async (_why, change) => {
    if (skip()) return;
    expect(await tryFinding({ ...FINDING, ...change })).toBe("23503");
  });

  it("gives each finding a server id and recording time", async () => {
    if (skip()) return;
    const defaults = await guard().admin.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = $1 AND column_name IN ('id', 'recorded_at') ORDER BY column_name`,
      [TABLE],
    );
    expect(defaults.rows).toEqual([
      { column_name: "id", column_default: "gen_random_uuid()" },
      { column_name: "recorded_at", column_default: "now()" },
    ]);
  });
});

describe("0089: tenant isolation and append-only (FORCE RLS)", () => {
  it("lets the app role write and read only its own tenant, and never change or remove a finding", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(INSERT, values(FINDING));
      expect((await client.query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(1);
      await client.query("SAVEPOINT other");
      await expect(client.query(INSERT, values(FINDING_B))).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT other");
      expect((await client.query(`UPDATE ${TABLE} SET cause = 'validation_mismatch'`)).rowCount).toBe(0);
      expect((await client.query(`DELETE FROM ${TABLE}`)).rowCount).toBe(0);
      expect((await client.query(`SELECT cause FROM ${TABLE}`)).rows).toEqual([{ cause: "validation_missing" }]);
    });
    await asApp(guard(), TENANT_B, async (client) => {
      await client.query(INSERT, values(FINDING_B));
      const seen = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${TABLE}`);
      expect(seen.rows).toEqual([{ tenant_id: TENANT_B }]);
    });
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    await guard().admin.query(INSERT, values(FINDING));
    try {
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${TABLE}`)).rowCount).toBe(0);
      });
    } finally {
      await guard().admin.query(`DELETE FROM ${TABLE}`);
    }
  });
});

// ---------------------------------------------------------------------------
// UP -> DOWN -> UP
// ---------------------------------------------------------------------------

describe("0089: UP -> DOWN -> UP", () => {
  const tableExists = async (): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [TABLE])).rows[0]!.t !== null;
  const columnCount = async (): Promise<number> =>
    Number(
      (
        await guard().admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_attribute
            WHERE NOT attisdropped
              AND ((attrelid = 'sale_lines'::regclass AND attname LIKE 'tracking\\_%')
                OR (attrelid = 'sales'::regclass AND attname IN ('safety_revision', 'safety_synced_at', 'tracking_status')))`,
        )
      ).rows[0]!.n,
    );
  const OWNER_TABLES = ["tenants", "stores", "devices", "tenant_products", "tracking_identities", "tracking_holds", "sales", "sale_lines", TABLE];

  it.each<[string, string, string]>([
    ["a finding", `INSERT INTO ${TABLE} (${F_COLUMNS.join(", ")}) VALUES (${F_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`, `DELETE FROM ${TABLE}`],
    [
      "a line's tracking class",
      `UPDATE sale_lines SET tracking_class = 'unresolved', tracking_unresolved_reason = 'tracking_missing' WHERE id = '${LINE_B}'`,
      `UPDATE sale_lines SET tracking_class = NULL, tracking_unresolved_reason = NULL WHERE id = '${LINE_B}'`,
    ],
    [
      "a line's tracking stored while off (no class)",
      `UPDATE sale_lines SET tracking_identity_id = '${IDENTITY_B}', tracking_code = 'LOT-B', tracking_selection = 'scanned' WHERE id = '${LINE_B}'`,
      `UPDATE sale_lines SET tracking_identity_id = NULL, tracking_code = NULL, tracking_selection = NULL WHERE id = '${LINE_B}'`,
    ],
    ["a sale's safety revision", `UPDATE sales SET safety_revision = 3 WHERE id = '${SALE_B}'`, `UPDATE sales SET safety_revision = NULL WHERE id = '${SALE_B}'`],
    [
      "a sale's synced-at",
      `UPDATE sales SET safety_synced_at = now() WHERE id = '${SALE_B}'`,
      `UPDATE sales SET safety_synced_at = NULL WHERE id = '${SALE_B}'`,
    ],
    ["a sale's tracking status", `UPDATE sales SET tracking_status = 'tracked' WHERE id = '${SALE_B}'`, `UPDATE sales SET tracking_status = NULL WHERE id = '${SALE_B}'`],
  ])("refuses while %s exists, also as a NOSUPERUSER migration owner, and changes nothing", async (what, seedSql, cleanSql) => {
    if (skip()) return;
    const e = guard();
    if (what === "a finding") await e.admin.query(seedSql, values(FINDING_B));
    else await e.admin.query(seedSql);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt451_m2_refuse_owner", tables: OWNER_TABLES, functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await tableExists()).toBe(true);
      expect(await columnCount()).toBe(10);
    } finally {
      await e.admin.query(cleanSql);
    }
  });

  it("drops the table and columns once no tracked data exists, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await tableExists()).toBe(false);
    expect(await columnCount()).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await tableExists()).toBe(true);
    expect(await columnCount()).toBe(10);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt451_m2_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await tableExists()).toBe(true);
    expect(await columnCount()).toBe(10);
  });
});
