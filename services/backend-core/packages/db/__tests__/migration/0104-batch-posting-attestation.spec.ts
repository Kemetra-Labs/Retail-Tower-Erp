/**
 * RT-452: `0104_batch_posting_attestation` migration test (owner decision of
 * 2026-11-12: the `erp_batch_posting_verified` precondition is an owner
 * attestation, recorded by an operator CLI).
 *
 * Validates `packages/db/drizzle/0104_batch_posting_attestation.sql`
 * (+ `.down.sql`):
 *   - three nullable columns on `tenant_inventory_settings`; a settings row that
 *     exists BEFORE 0104 (the UPGRADE path) reads as not attested;
 *   - the CHECKs: attested-at, attested-by and the evidence reference are all
 *     NULL or all set; the evidence reference is non-blank and at most 200
 *     characters;
 *   - the existing tenant RLS still isolates the new columns;
 *   - the down REFUSES while any tenant holds an attestation (it would discard
 *     the owner's record), also as a NOSUPERUSER migration owner under FORCE RLS;
 *   - UP -> DOWN -> UP round-trips once no attestation exists; the down drops
 *     ONLY the three columns and two CHECKs.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0104_batch_posting_attestation.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0104_batch_posting_attestation.down.sql");

const TENANT_A = "01040000-0000-7000-8000-00000000a001";
const TENANT_B = "01040000-0000-7000-8000-00000000b001";
const ACTOR = "01040000-0000-7000-8000-00000000a0a1";

const COLUMNS = ["erp_batch_posting_attested_at", "erp_batch_posting_attested_by", "erp_batch_posting_evidence_ref"];
const CONSTRAINTS = [
  "tenant_inventory_settings_batch_posting_attest_together",
  "tenant_inventory_settings_batch_posting_evidence_ref",
];

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
      console.warn(`\n[0104-batch-posting-attestation.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'bp-a', 'Posting A', 'USD'), ($2, 'bp-b', 'Posting B', 'USD')`,
    [TENANT_A, TENANT_B],
  );
  // A settings row that exists BEFORE 0104: it must read as not attested.
  await a.query(`INSERT INTO tenant_inventory_settings (tenant_id, updated_by) VALUES ($1, $2)`, [TENANT_A, ACTOR]);
  await a.query(upSql);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const SET_ATTESTATION = `UPDATE tenant_inventory_settings
    SET erp_batch_posting_attested_at = $2, erp_batch_posting_attested_by = $3, erp_batch_posting_evidence_ref = $4
  WHERE tenant_id = $1`;

describe("0104: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0104: the columns", () => {
  it("adds three nullable columns", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'tenant_inventory_settings' AND column_name = ANY($1) ORDER BY column_name`,
      [COLUMNS],
    );
    expect(cols.rows).toEqual([
      { column_name: "erp_batch_posting_attested_at", is_nullable: "YES", column_default: null },
      { column_name: "erp_batch_posting_attested_by", is_nullable: "YES", column_default: null },
      { column_name: "erp_batch_posting_evidence_ref", is_nullable: "YES", column_default: null },
    ]);
  });

  it("reads a pre-0104 settings row as not attested (upgrade path)", async () => {
    if (skip()) return;
    const r = await guard().admin.query(`SELECT ${COLUMNS.join(", ")} FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(r.rows).toEqual([
      { erp_batch_posting_attested_at: null, erp_batch_posting_attested_by: null, erp_batch_posting_evidence_ref: null },
    ]);
  });

  it("declares the two CHECK constraints", async () => {
    if (skip()) return;
    const c = await guard().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'tenant_inventory_settings'::regclass AND conname = ANY($1) ORDER BY conname`,
      [CONSTRAINTS],
    );
    expect(c.rows.map((r) => r.conname)).toEqual([...CONSTRAINTS].sort());
  });
});

describe("0104: the CHECKs", () => {
  afterEach(async () => {
    if (skip()) return;
    await guard().admin.query(SET_ATTESTATION, [TENANT_A, null, null, null]);
  });

  it("stores all three together", async () => {
    if (skip()) return;
    await expect(guard().admin.query(SET_ATTESTATION, [TENANT_A, new Date(), ACTOR, "RT-452 bench run 1"])).resolves.toBeDefined();
    await expect(guard().admin.query(SET_ATTESTATION, [TENANT_A, null, null, null])).resolves.toBeDefined();
  });

  it.each<[string, Date | null, string | null, string | null]>([
    ["only the time", new Date(), null, null],
    ["only the actor", null, ACTOR, null],
    ["only the evidence reference", null, null, "ref"],
    ["time and actor without the evidence reference", new Date(), ACTOR, null],
    ["time and evidence reference without the actor", new Date(), null, "ref"],
    ["actor and evidence reference without the time", null, ACTOR, "ref"],
  ])("refuses %s (23514)", async (_why, at, by, ref) => {
    if (skip()) return;
    await expect(guard().admin.query(SET_ATTESTATION, [TENANT_A, at, by, ref])).rejects.toMatchObject({ code: "23514" });
  });

  it.each<[string, string]>([
    ["a blank evidence reference", "   "],
    ["an empty evidence reference", ""],
    ["an evidence reference over 200 characters", "x".repeat(201)],
  ])("refuses %s (23514)", async (_why, ref) => {
    if (skip()) return;
    await expect(guard().admin.query(SET_ATTESTATION, [TENANT_A, new Date(), ACTOR, ref])).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts an evidence reference of exactly 200 characters", async () => {
    if (skip()) return;
    await expect(guard().admin.query(SET_ATTESTATION, [TENANT_A, new Date(), ACTOR, "x".repeat(200)])).resolves.toBeDefined();
  });
});

describe("0104: tenant isolation (the existing FORCE RLS on tenant_inventory_settings)", () => {
  it("hides another tenant's attestation and refuses to change it", async () => {
    if (skip()) return;
    await asApp(guard(), TENANT_B, async (client) => {
      const seen = await client.query(`SELECT erp_batch_posting_attested_at FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
      expect(seen.rowCount).toBe(0);
      const write = await client.query(SET_ATTESTATION, [TENANT_A, new Date(), ACTOR, "ref"]);
      expect(write.rowCount).toBe(0);
    });
    const stored = await guard().admin.query(`SELECT erp_batch_posting_attested_at FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(stored.rows).toEqual([{ erp_batch_posting_attested_at: null }]);
  });
});

describe("0104: UP -> DOWN -> UP", () => {
  const columnNames = async (): Promise<string[]> =>
    (
      await guard().admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'tenant_inventory_settings' ORDER BY column_name`,
      )
    ).rows.map((r) => r.column_name);

  it("refuses while a tenant holds an attestation, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(SET_ATTESTATION, [TENANT_A, new Date(), ACTOR, "RT-452 bench run 1"]);
    try {
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      const owner = { role: "rt452_refuse_owner", tables: ["tenants", "tenant_inventory_settings"], functions: [] };
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await columnNames()).toEqual(expect.arrayContaining(COLUMNS));
      const kept = await e.admin.query(`SELECT erp_batch_posting_evidence_ref FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
      expect(kept.rows).toEqual([{ erp_batch_posting_evidence_ref: "RT-452 bench run 1" }]);
    } finally {
      await e.admin.query(SET_ATTESTATION, [TENANT_A, null, null, null]);
    }
  });

  it("drops ONLY the three columns and two CHECKs once no attestation exists, keeps every row, and comes back unattested", async () => {
    if (skip()) return;
    const e = guard();
    const before = await columnNames();
    await e.admin.query(downSql);
    const after = await columnNames();
    expect(before.filter((c) => !after.includes(c))).toEqual(COLUMNS);
    expect(after).toHaveLength(before.length - COLUMNS.length);
    const left = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conname = ANY($1)`, [CONSTRAINTS]);
    expect(left.rowCount).toBe(0);
    expect((await e.admin.query(`SELECT 1 FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A])).rowCount).toBe(1);
    // The down is rerunnable, and the up brings the columns back empty.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    const back = await e.admin.query(`SELECT erp_batch_posting_attested_at FROM tenant_inventory_settings WHERE tenant_id = $1`, [TENANT_A]);
    expect(back.rows).toEqual([{ erp_batch_posting_attested_at: null }]);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt452_owner", tables: ["tenants", "tenant_inventory_settings"], functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await columnNames()).toEqual(expect.arrayContaining(COLUMNS));
  });
});
