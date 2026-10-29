/**
 * 0075 — one store per ERPNext Warehouse (Jira RT-433; [GATED] migration,
 * approval RT-290 comment 11717 Q4).
 *
 * Applies every migration before 0075 against a real Postgres, then applies
 * 0075 exactly as the runner does (one `query()` for the file), and proves:
 *   - the preflight fails loudly on duplicate active Warehouse refs, naming
 *     every tenant, ref and store:purpose, and changes nothing;
 *   - it does so as a NON-superuser table owner under FORCE ROW LEVEL SECURITY
 *     (the production migration owner), not only as the test superuser;
 *   - on clean data the unique active reverse index replaces the non-unique
 *     one; retired rows and other tenants do not count; a second active row on
 *     a held ref is rejected by the index;
 *   - down restores the non-unique index and round-trips with up.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DRIZZLE_DIR, startEnvBefore } from "../_helpers/migration-before";
import { asMigrationOwner } from "../_helpers/migration-spec";
import { ensureAppRole, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const UP_NAME = "0075_erpnext_warehouse_map_ref_unique.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0075_erpnext_warehouse_map_ref_unique.down.sql");

const UNIQUE_INDEX = "UQ_idx_erpnext_warehouse_map_ref_active";
const OLD_INDEX = "idx_erpnext_warehouse_map_ref";

const TENANT = "0a000000-0000-7000-8000-000000433001";
const TENANT_2 = "0a000000-0000-7000-8000-000000433002";
const STORE_1 = "0a000000-0000-7000-8000-000000433011";
const STORE_2 = "0a000000-0000-7000-8000-000000433012";
const STORE_3 = "0a000000-0000-7000-8000-000000433013";
const STORE_T2 = "0a000000-0000-7000-8000-000000433021";
const ACTOR = "0a000000-0000-7000-8000-000000433099";

const OWNER = {
  role: "rt433_migration_owner",
  tables: ["erpnext_warehouse_map", "tenants"],
  functions: [],
} as const;

let env: PgTestEnv | null = null;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}
const skip = (): boolean => env === null;

interface RunResult {
  readonly code: string | null;
  readonly message: string | null;
}

/** Run a migration file on one connection (optionally `SET ROLE`); never leaves a transaction open. */
async function runFile(path: string, role: string | null = null): Promise<RunResult> {
  const client = await pg().admin.connect();
  try {
    if (role !== null) await client.query(`SET ROLE ${role}`);
    await client.query(readFileSync(path, "utf8"));
    return { code: null, message: null };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? "unknown", message: e.message ?? String(err) };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

async function indexState(): Promise<{ unique: boolean; old: boolean }> {
  const r = await pg().admin.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [[UNIQUE_INDEX, OLD_INDEX]],
  );
  const names = new Set(r.rows.map((row) => row.indexname));
  return { unique: names.has(UNIQUE_INDEX), old: names.has(OLD_INDEX) };
}

async function insertMap(
  tenant: string,
  store: string,
  purpose: "stock" | "returns",
  ref: string,
  retired = false,
): Promise<void> {
  await pg().admin.query(
    `INSERT INTO erpnext_warehouse_map
       (tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, retired_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END)`,
    [tenant, store, purpose, ref, ACTOR, retired],
  );
}

async function insertError(tenant: string, store: string, purpose: "stock" | "returns", ref: string) {
  try {
    await insertMap(tenant, store, purpose, ref);
    return null;
  } catch (err: unknown) {
    const e = err as { code?: string; constraint?: string };
    return { code: e.code, constraint: e.constraint };
  }
}

const clearMaps = (): Promise<unknown> => pg().admin.query(`DELETE FROM erpnext_warehouse_map`);
const mapCount = async (): Promise<number> =>
  Number((await pg().admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM erpnext_warehouse_map`)).rows[0]!.n);

const BEFORE = { unique: false, old: true };
const AFTER = { unique: true, old: false };

beforeAll(async () => {
  env = await startEnvBefore(UP_NAME, "0075 spec");
  if (env === null) return;
  const a = env.admin;
  await a.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt433-a', 'A'), ($2, 'rt433-b', 'B')`, [
    TENANT,
    TENANT_2,
  ]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'S1', 'S1'), ($2, $4, 'S2', 'S2'), ($3, $4, 'S3', 'S3'), ($5, $6, 'T2', 'T2')`,
    [STORE_1, STORE_2, STORE_3, TENANT, STORE_T2, TENANT_2],
  );
  await a.query(`INSERT INTO users (id, email) VALUES ($1, 'a@rt433.example')`, [ACTOR]);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0075 preflight — fails loudly on duplicate active Warehouse refs", () => {
  afterEach(async () => {
    if (!skip()) await clearMaps();
  });

  it("two stores of one tenant on one ref → names tenant, ref and both stores; nothing changes", async () => {
    if (skip()) return;
    await insertMap(TENANT, STORE_1, "stock", "WH-DUP");
    await insertMap(TENANT, STORE_2, "stock", "WH-DUP");
    // History and other tenants are not offenders.
    await insertMap(TENANT, STORE_3, "stock", "WH-DUP", true);
    await insertMap(TENANT_2, STORE_T2, "stock", "WH-DUP");

    const res = await runFile(UP_PATH);

    expect(res.code).toBe("23505");
    expect(res.message).toContain("RT-433 preflight: 1 ERPNext Warehouse ref(s)");
    expect(res.message).toContain(`tenant=${TENANT} ref='WH-DUP' maps=${STORE_1}:stock,${STORE_2}:stock`);
    expect(res.message).not.toContain(STORE_3);
    expect(res.message).not.toContain(TENANT_2);
    expect(await indexState()).toEqual(BEFORE);
    expect(await mapCount()).toBe(4);
  });

  it("one store holding `stock` and `returns` on one ref is an offender too (the index key ignores purpose)", async () => {
    if (skip()) return;
    await insertMap(TENANT, STORE_3, "stock", "WH-BOTH");
    await insertMap(TENANT, STORE_3, "returns", "WH-BOTH");

    const res = await runFile(UP_PATH);

    expect(res.code).toBe("23505");
    expect(res.message).toContain(`ref='WH-BOTH' maps=${STORE_3}:returns,${STORE_3}:stock`);
    expect(await indexState()).toEqual(BEFORE);
  });

  it("lists every offender across tenants in one error", async () => {
    if (skip()) return;
    await insertMap(TENANT, STORE_1, "stock", "WH-X");
    await insertMap(TENANT, STORE_2, "stock", "WH-X");
    await insertMap(TENANT_2, STORE_T2, "stock", "WH-Y");
    await insertMap(TENANT_2, STORE_T2, "returns", "WH-Y");

    const res = await runFile(UP_PATH);

    expect(res.message).toContain("RT-433 preflight: 2 ERPNext Warehouse ref(s)");
    expect(res.message).toContain(`tenant=${TENANT} ref='WH-X'`);
    expect(res.message).toContain(`tenant=${TENANT_2} ref='WH-Y'`);
  });

  it("sees the rows as a NON-superuser owner under FORCE RLS (the production migration owner)", async () => {
    if (skip()) return;
    await insertMap(TENANT, STORE_1, "stock", "WH-RLS");
    await insertMap(TENANT, STORE_2, "stock", "WH-RLS");

    await asMigrationOwner(pg(), OWNER, async () => {
      const res = await runFile(UP_PATH, OWNER.role);
      // The precise preflight message, not the index build's generic
      // "could not create unique index" (which would mean the preflight saw nothing).
      expect(res.code).toBe("23505");
      expect(res.message).toContain(`tenant=${TENANT} ref='WH-RLS' maps=${STORE_1}:stock,${STORE_2}:stock`);
      expect(await indexState()).toEqual(BEFORE);
    });
    await ensureAppRole(pg());
  });
});

describe("0075 up — clean data", () => {
  beforeAll(async () => {
    if (skip()) return;
    await clearMaps();
    await insertMap(TENANT, STORE_1, "stock", "WH-1");
    await insertMap(TENANT, STORE_2, "stock", "WH-1", true); // history on the same ref
    await insertMap(TENANT, STORE_2, "stock", "WH-2");
    await insertMap(TENANT_2, STORE_T2, "stock", "WH-1"); // same ref, other tenant
  });

  it("passes and replaces the non-unique index with the unique active one; every row survives", async () => {
    if (skip()) return;
    expect(await runFile(UP_PATH)).toEqual({ code: null, message: null });
    expect(await indexState()).toEqual(AFTER);
    const valid = await pg().admin.query<{ indisvalid: boolean; indisunique: boolean }>(
      `SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = $1::regclass`,
      [`"${UNIQUE_INDEX}"`],
    );
    expect(valid.rows[0]).toEqual({ indisvalid: true, indisunique: true });
    expect(await mapCount()).toBe(4);
  });

  it("a second store mapping an active ref → 23505 on the unique active reverse index", async () => {
    if (skip()) return;
    expect(await insertError(TENANT, STORE_3, "stock", "WH-1")).toEqual({ code: "23505", constraint: UNIQUE_INDEX });
  });

  it("the same store's `returns` row on its `stock` ref → 23505 on the same index", async () => {
    if (skip()) return;
    expect(await insertError(TENANT, STORE_1, "returns", "WH-1")).toEqual({ code: "23505", constraint: UNIQUE_INDEX });
  });

  it("retired rows and other tenants do not count", async () => {
    if (skip()) return;
    await insertMap(TENANT, STORE_3, "stock", "WH-1", true);
    expect(await insertError(TENANT_2, STORE_T2, "returns", "WH-2")).toBeNull();
  });
});

describe("0075 down", () => {
  it("restores the non-unique index (a duplicate is accepted again) and round-trips as the migration owner", async () => {
    if (skip()) return;
    expect(await runFile(DOWN_PATH)).toEqual({ code: null, message: null });
    expect(await indexState()).toEqual(BEFORE);
    expect(await insertError(TENANT, STORE_3, "stock", "WH-2")).toBeNull();
    await pg().admin.query(`DELETE FROM erpnext_warehouse_map WHERE store_id = $1 AND retired_at IS NULL`, [STORE_3]);

    await asMigrationOwner(pg(), OWNER, async () => {
      expect(await runFile(UP_PATH, OWNER.role)).toEqual({ code: null, message: null });
      expect(await indexState()).toEqual(AFTER);
      expect(await runFile(DOWN_PATH, OWNER.role)).toEqual({ code: null, message: null });
      expect(await indexState()).toEqual(BEFORE);
      expect(await runFile(UP_PATH, OWNER.role)).toEqual({ code: null, message: null });
      expect(await indexState()).toEqual(AFTER);
    });
    await ensureAppRole(pg());
  });
});
