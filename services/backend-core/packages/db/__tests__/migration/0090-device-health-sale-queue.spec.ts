/**
 * RT-1312 Phase 1 (F1): `0090_device_health_sale_queue` migration test.
 *
 * Validates `packages/db/drizzle/0090_device_health_sale_queue.sql` (+ `.down.sql`):
 *   - four NULLABLE columns on `device_health`, no default (unknown is never
 *     0), and an existing health row reads NULL in all four;
 *   - each count is bounded 0..1000000 (23514 otherwise);
 *   - the consistency CHECK: all four NULL (a beat that carried no queue), or
 *     the three counts present with an optional oldest time; a partial queue
 *     or a time alone is refused;
 *   - the existing tenant RLS on `device_health` still isolates the columns;
 *   - UP -> DOWN -> UP round-trips and the down drops ONLY the four columns
 *     and their constraints, leaving every other column and row.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0090_device_health_sale_queue.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0090_device_health_sale_queue.down.sql");

const TENANT_A = "09000000-0000-7000-8000-00000000a001";
const TENANT_B = "09000000-0000-7000-8000-00000000b001";
const STORE_A = "09000000-0000-7000-8000-00000000a002";
const STORE_B = "09000000-0000-7000-8000-00000000b002";
const DEV_OLD = "09000000-0000-7000-8000-00000000a0d0";
const DEV_A = "09000000-0000-7000-8000-00000000a0d1";
const DEV_B = "09000000-0000-7000-8000-00000000b0d1";

const COLUMNS = ["sale_queue_dead_letter", "sale_queue_held", "sale_queue_oldest_pending_at", "sale_queue_pending"];
const CONSTRAINTS = ["device_health_sale_queue_bounds", "device_health_sale_queue_consistent"];

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Apply every migration with a basename lexically < 0090. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  await ensureAppRole(pgEnv);
}

const INSERT_DEVICE = `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1::uuid, $2, $3, decode(md5($1::text), 'hex'))`;
const INSERT_HEALTH = `INSERT INTO device_health (device_id, tenant_id, last_seen_at) VALUES ($1, $2, now())`;

async function seed(pgEnv: PgTestEnv, devices: Array<[string, string, string]>): Promise<void> {
  for (const [id, tenant, store] of devices) {
    await pgEnv.admin.query(INSERT_DEVICE, [id, tenant, store]);
    await pgEnv.admin.query(INSERT_HEALTH, [id, tenant]);
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0090-device-health-sale-queue.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'sq-a', 'Queue A', 'USD'), ($2, 'sq-b', 'Queue B', 'USD')`, [
    TENANT_A,
    TENANT_B,
  ]);
  await a.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'A', 'A'), ($2, $4, 'B', 'B')`, [STORE_A, STORE_B, TENANT_A, TENANT_B]);
  // A health row that exists BEFORE 0090: it must read NULL in every new column.
  await seed(env, [[DEV_OLD, TENANT_A, STORE_A]]);
  await a.query(upSql);
  await ensureAppRole(env);
  await seed(env, [
    [DEV_A, TENANT_A, STORE_A],
    [DEV_B, TENANT_B, STORE_B],
  ]);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface Queue {
  readonly pending?: number | null;
  readonly deadLetter?: number | null;
  readonly held?: number | null;
  readonly oldest?: boolean;
}

async function setQueue(id: string, q: Queue): Promise<unknown> {
  return guard().admin.query(
    `UPDATE device_health SET sale_queue_pending = $2, sale_queue_dead_letter = $3, sale_queue_held = $4,
            sale_queue_oldest_pending_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
      WHERE device_id = $1`,
    [id, q.pending ?? null, q.deadLetter ?? null, q.held ?? null, q.oldest === true],
  );
}

describe("0090: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0090: the columns", () => {
  it("adds four nullable columns with no default, and a pre-existing health row reads NULL in all of them", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'device_health' AND column_name = ANY($1) ORDER BY column_name`,
      [COLUMNS],
    );
    expect(cols.rows).toEqual(COLUMNS.map((column_name) => ({ column_name, is_nullable: "YES", column_default: null })));
    const old = await guard().admin.query(`SELECT ${COLUMNS.join(", ")} FROM device_health WHERE device_id = $1`, [DEV_OLD]);
    expect(Object.values(old.rows[0] as Record<string, unknown>)).toEqual([null, null, null, null]);
  });

  it("declares the two CHECK constraints", async () => {
    if (skip()) return;
    const c = await guard().admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'device_health'::regclass AND conname = ANY($1) ORDER BY conname`,
      [CONSTRAINTS],
    );
    expect(c.rows.map((r) => r.conname)).toEqual(CONSTRAINTS);
  });
});

describe("0090: bounded values and consistency", () => {
  beforeEach(async () => {
    if (skip()) return;
    await setQueue(DEV_A, {});
  });

  it("stores a full queue, an empty queue with no oldest time, and the unknown (all NULL) state", async () => {
    if (skip()) return;
    await expect(setQueue(DEV_A, { pending: 3, deadLetter: 1, held: 0, oldest: true })).resolves.toBeDefined();
    await expect(setQueue(DEV_A, { pending: 0, deadLetter: 0, held: 0 })).resolves.toBeDefined();
    await expect(setQueue(DEV_A, { pending: 1_000_000, deadLetter: 1_000_000, held: 1_000_000 })).resolves.toBeDefined();
    await expect(setQueue(DEV_A, {})).resolves.toBeDefined();
  });

  it.each<[string, Queue]>([
    ["a negative pending count", { pending: -1, deadLetter: 0, held: 0 }],
    ["a negative dead-letter count", { pending: 0, deadLetter: -1, held: 0 }],
    ["a held count over 1000000", { pending: 0, deadLetter: 0, held: 1_000_001 }],
    ["a partial queue", { pending: 1, deadLetter: 0 }],
    ["one count alone", { deadLetter: 2 }],
    ["an oldest time alone", { oldest: true }],
  ])("refuses %s (23514)", async (_why, q) => {
    if (skip()) return;
    await expect(setQueue(DEV_A, q)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0090: tenant isolation (the existing RLS on device_health)", () => {
  it("shows a tenant its own queue only, and refuses a write to another tenant's row", async () => {
    if (skip()) return;
    await setQueue(DEV_A, { pending: 2, deadLetter: 1, held: 0 });
    const client = await guard().app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_B]);
      const seen = await client.query(`SELECT device_id, sale_queue_dead_letter FROM device_health WHERE device_id = ANY($1)`, [[DEV_A, DEV_B]]);
      expect(seen.rows).toEqual([{ device_id: DEV_B, sale_queue_dead_letter: null }]);
      const write = await client.query(
        `UPDATE device_health SET sale_queue_pending = 9, sale_queue_dead_letter = 9, sale_queue_held = 9 WHERE device_id = $1`,
        [DEV_A],
      );
      expect(write.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const stored = await guard().admin.query(`SELECT sale_queue_dead_letter FROM device_health WHERE device_id = $1`, [DEV_A]);
    expect(stored.rows).toEqual([{ sale_queue_dead_letter: 1 }]);
  });
});

describe("0090: UP -> DOWN -> UP", () => {
  it("drops ONLY the four columns and their constraints, keeps every health row, and comes back", async () => {
    if (skip()) return;
    const e = guard();
    const columnNames = async (): Promise<string[]> =>
      (
        await e.admin.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'device_health' ORDER BY column_name`,
        )
      ).rows.map((r) => r.column_name);
    const before = await columnNames();
    const rowsBefore = (await e.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM device_health`)).rows[0]?.n;
    await e.admin.query(downSql);
    const after = await columnNames();
    expect(before.filter((c) => !after.includes(c))).toEqual(COLUMNS);
    expect(after).toHaveLength(before.length - COLUMNS.length);
    const left = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conrelid = 'device_health'::regclass AND conname = ANY($1)`, [CONSTRAINTS]);
    expect(left.rowCount).toBe(0);
    expect((await e.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM device_health`)).rows[0]?.n).toBe(rowsBefore);
    // The down is rerunnable, and the up brings every column back as unknown.
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    const back = await e.admin.query(`SELECT ${COLUMNS.join(", ")} FROM device_health WHERE device_id = $1`, [DEV_A]);
    expect(Object.values(back.rows[0] as Record<string, unknown>)).toEqual([null, null, null, null]);
  });
});
