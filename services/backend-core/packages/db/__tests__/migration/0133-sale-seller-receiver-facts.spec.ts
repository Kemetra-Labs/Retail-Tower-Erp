/**
 * RT-1565 (RT-285 F-1): `0133_sale_seller_receiver_facts` ([GATED: migration]) on a real PostgreSQL 16
 * (Testcontainers), applied on top of every earlier migration.
 *
 * Proves:
 *   - BEFORE 0133: none of the five columns exist;
 *   - UP: a line without a seller and a tender without a receiver are stored as before; a whole seller
 *     snapshot is stored; a partial snapshot is refused; the Seller Code format is enforced; a code is unique
 *     within a tenant among non-deleted memberships, reusable in another tenant and after a soft delete; the
 *     new CHECKs and foreign keys are NOT VALID (no scan of the hot sale tables under the lock);
 *   - DOWN, as a NOSUPERUSER migration owner under FORCE RLS: refuses while any seller, receiver or Seller
 *     Code is recorded, in any tenant (sale_lines and sale_tenders have tenant-only policies, so the guard
 *     reads tenant by tenant under each one's GUC, never lifting FORCE), and once they are cleared it drops
 *     every column; FORCE RLS stays on all three tables; the up re-applies cleanly.
 *
 * Fixtures are inserted on one superuser connection with `session_replication_role = replica` (foreign keys
 * and triggers off; CHECK and UNIQUE constraints still apply), so no store, user or sale rows are needed;
 * three tenant rows are, because the down guard lists the tenants.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { applyMigrationsBefore, asMigrationOwner, startPgEnvOrSkip } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP = "0133_sale_seller_receiver_facts.sql";
const DOWN = "0133_sale_seller_receiver_facts.down.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
const OWNER_ROLE = "rt1565_mig_owner";
// Real tenants: the down guard reads each tenant under its own GUC (sale_lines and sale_tenders have
// tenant-only policies), so every fact row must belong to a tenant that exists.
const TENANT_A = "0a000000-0000-7000-8000-000000156551";
const TENANT_B = "0b000000-0000-7000-8000-000000156552";
const TENANT_C = "0c000000-0000-7000-8000-000000156553";

let env: PgTestEnv | null = null;
const skip = (): boolean => env === null;
function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

/** The constraint violated by `fn` (or the error code), or null when it succeeded. */
async function violated(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { constraint?: string; code?: string };
    return e.constraint ?? e.code ?? "unknown";
  }
}

/** Run `fn` on one superuser connection with triggers and FKs off (fixtures only), committed. */
async function fixture<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pg().admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

interface Seller {
  readonly userId: string | null;
  readonly storeId: string | null;
  readonly roleId: string | null;
}
const NO_SELLER: Seller = { userId: null, storeId: null, roleId: null };
const aSeller = (): Seller => ({ userId: randomUUID(), storeId: randomUUID(), roleId: randomUUID() });

/** A sale line (no parent sale: FKs are off), with or without the seller columns. */
async function insertLine(seller: Seller | undefined, tenantId: string = TENANT_A): Promise<string> {
  const id = randomUUID();
  const cols = seller === undefined ? "" : ", seller_user_id, seller_store_id, seller_role_id";
  const vals = seller === undefined ? "" : ", $5, $6, $7";
  const params: unknown[] = [id, randomUUID(), tenantId, randomUUID()];
  if (seller !== undefined) params.push(seller.userId, seller.storeId, seller.roleId);
  await fixture((c) =>
    c.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity,
                               line_amount, unit${cols})
       VALUES ($1, $2, $3, $4, 'Widget', 5, 'EGP', 1, 5, 'ea'${vals})`,
      params,
    ),
  );
  return id;
}

/** A cash tender (no parent sale), with or without a receiver. */
async function insertTender(receiver: string | null | undefined, tenantId: string = TENANT_B): Promise<string> {
  const id = randomUUID();
  const withReceiver = receiver !== undefined;
  await fixture((c) =>
    c.query(
      `INSERT INTO sale_tenders (id, sale_id, tenant_id, store_id, method, amount, currency_code
                                 ${withReceiver ? ", received_by_user_id" : ""})
       VALUES ($1, $2, $3, $4, 'cash', 5, 'EGP'${withReceiver ? ", $5" : ""})`,
      withReceiver ? [id, randomUUID(), tenantId, randomUUID(), receiver] : [id, randomUUID(), tenantId, randomUUID()],
    ),
  );
  return id;
}

/** A membership of `tenantId` carrying `code`, optionally soft-deleted. */
async function insertMembership(tenantId: string, code: string | null, deleted = false): Promise<string> {
  const id = randomUUID();
  await fixture((c) =>
    c.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, seller_code, deleted_at)
       VALUES ($1, $2, $3, $4, 'all', $5, $6)`,
      [id, tenantId, randomUUID(), randomUUID(), code, deleted ? new Date().toISOString() : null],
    ),
  );
  return id;
}

async function newColumnCount(): Promise<number> {
  const r = await pg().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'sale_lines' AND column_name IN ('seller_user_id', 'seller_store_id', 'seller_role_id'))
          OR (table_name = 'sale_tenders' AND column_name = 'received_by_user_id')
          OR (table_name = 'memberships' AND column_name = 'seller_code'))`,
  );
  return Number(r.rows[0]!.n);
}

/** Whether each of the three tables still forces row level security (the down must never lift it). */
async function forcedRls(): Promise<Record<string, boolean>> {
  const r = await pg().admin.query<{ relname: string; forced: boolean }>(
    `SELECT relname, relforcerowsecurity AS forced FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('memberships', 'sale_lines', 'sale_tenders')
      ORDER BY relname`,
  );
  return Object.fromEntries(r.rows.map((row) => [row.relname, row.forced]));
}
const ALL_FORCED = { memberships: true, sale_lines: true, sale_tenders: true };

/** Run a migration file as the NOSUPERUSER owner of the three tables, tenant GUC pre-set to ''. */
async function runAsOwner(file: string): Promise<{ code: string | null; message: string }> {
  const owner = { role: OWNER_ROLE, tables: ["tenants", "memberships", "sale_lines", "sale_tenders"], functions: [] };
  return asMigrationOwner(pg(), owner, async () => {
    const c = await pg().admin.connect();
    try {
      await c.query(`SET ROLE ${OWNER_ROLE}`);
      await c.query(`SELECT set_config('app.current_tenant', '', false)`);
      await c.query(sql(file));
      return { code: null, message: "" };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      await c.query("RESET ROLE").catch(() => undefined);
      await c.query("RESET app.current_tenant").catch(() => undefined);
      c.release();
    }
  });
}

let preExistingLine = "";

beforeAll(async () => {
  const started = await startPgEnvOrSkip(startPgEnv, process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1");
  if (started.env === null) {
    // eslint-disable-next-line no-console
    console.warn(`\n[0133-sale-seller-receiver-facts.spec] Docker NOT AVAILABLE — skipping: ${started.skipReason}\n`);
    return;
  }
  env = started.env;
  await applyMigrationsBefore(env, DRIZZLE_DIR, UP);
  await fixture((c) =>
    c.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'rt1565-a', 'RT1565 A', 'EGP'), ($2, 'rt1565-b', 'RT1565 B', 'EGP'), ($3, 'rt1565-c', 'RT1565 C', 'EGP')`,
      [TENANT_A, TENANT_B, TENANT_C],
    ),
  );
  preExistingLine = await insertLine(undefined);
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0133 — before the migration", () => {
  it("has none of the five columns", async () => {
    if (skip()) return;
    expect(await newColumnCount()).toBe(0);
  });
});

describe("0133 — up", () => {
  beforeAll(async () => {
    if (skip()) return;
    await pg().admin.query(sql(UP));
  });

  it("adds the five columns", async () => {
    if (skip()) return;
    expect(await newColumnCount()).toBe(5);
  });

  it("keeps a line recorded before the migration, with no seller", async () => {
    if (skip()) return;
    const r = await pg().admin.query(`SELECT seller_user_id FROM sale_lines WHERE id = $1`, [preExistingLine]);
    expect(r.rows).toEqual([{ seller_user_id: null }]);
  });

  it("stores a line without a seller and a line with a whole seller snapshot", async () => {
    if (skip()) return;
    expect(await violated(() => insertLine(undefined))).toBeNull();
    expect(await violated(() => insertLine(NO_SELLER))).toBeNull();
    const seller = aSeller();
    const id = await insertLine(seller, TENANT_B);
    const r = await pg().admin.query(
      `SELECT seller_user_id::text AS u, seller_store_id::text AS s, seller_role_id::text AS r FROM sale_lines WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ u: seller.userId, s: seller.storeId, r: seller.roleId });
  });

  it.each([
    ["the user alone", (s: Seller): Seller => ({ ...s, storeId: null, roleId: null })],
    ["no role", (s: Seller): Seller => ({ ...s, roleId: null })],
    ["no store", (s: Seller): Seller => ({ ...s, storeId: null })],
    ["no user", (s: Seller): Seller => ({ ...s, userId: null })],
  ])("refuses a partial seller snapshot (%s)", async (_label, cut) => {
    if (skip()) return;
    expect(await violated(() => insertLine(cut(aSeller())))).toBe("sale_lines_seller_snapshot_whole");
  });

  it("stores a tender with and without a receiver", async () => {
    if (skip()) return;
    expect(await violated(() => insertTender(undefined))).toBeNull();
    expect(await violated(() => insertTender(null))).toBeNull();
    const receiver = randomUUID();
    const id = await insertTender(receiver);
    const r = await pg().admin.query(`SELECT received_by_user_id::text AS v FROM sale_tenders WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ v: receiver });
  });

  it.each([["A"], ["ab12"], ["TOO-LONG-CODE"], ["ABCDEFGHIJKLMNOPQ"], ["ع1"]])(
    "refuses the Seller Code %p",
    async (code) => {
      if (skip()) return;
      expect(await violated(() => insertMembership(TENANT_A, code))).toBe("memberships_seller_code_format");
    },
  );

  it("keeps a Seller Code unique within a tenant, reusable in another tenant and after a soft delete", async () => {
    if (skip()) return;
    const tenant = TENANT_A;
    await insertMembership(tenant, "S100");
    expect(await violated(() => insertMembership(tenant, "S100"))).toBe("uq_memberships_tenant_seller_code");
    expect(await violated(() => insertMembership(TENANT_B, "S100"))).toBeNull();
    const reused = TENANT_C;
    await insertMembership(reused, "S200", true);
    expect(await violated(() => insertMembership(reused, "S200"))).toBeNull();
    expect(await violated(() => insertMembership(tenant, null))).toBeNull();
    expect(await violated(() => insertMembership(tenant, null))).toBeNull();
  });

  it("adds the new CHECKs and foreign keys NOT VALID (no scan of the sale tables under the lock)", async () => {
    if (skip()) return;
    const r = await pg().admin.query<{ conname: string; validated: boolean }>(
      `SELECT conname, convalidated AS validated FROM pg_constraint
        WHERE conname IN ('memberships_seller_code_format', 'sale_lines_seller_snapshot_whole',
                          'fk_sale_lines_seller_user', 'fk_sale_lines_seller_store', 'fk_sale_lines_seller_role',
                          'fk_sale_tenders_received_by_user')
        ORDER BY conname`,
    );
    expect(r.rows).toHaveLength(6);
    expect(r.rows.every((row) => row.validated === false)).toBe(true);
  });
});

describe("0133 — down, as the NOSUPERUSER migration owner under FORCE RLS", () => {
  it("refuses while a seller, a receiver or a Seller Code is recorded, and changes nothing", async () => {
    if (skip()) return;
    const refused = await runAsOwner(DOWN);
    expect(refused.code).toBe("P0001");
    expect(refused.message).toContain("0133 down refused");
    expect(await newColumnCount()).toBe(5);
    expect(await forcedRls()).toEqual(ALL_FORCED);
  });

  it("drops every column once the facts are cleared, and the up re-applies", async () => {
    if (skip()) return;
    await fixture(async (c) => {
      await c.query(`UPDATE sale_lines SET seller_user_id = NULL, seller_store_id = NULL, seller_role_id = NULL`);
      await c.query(`UPDATE sale_tenders SET received_by_user_id = NULL`);
      await c.query(`UPDATE memberships SET seller_code = NULL`);
    });
    expect((await runAsOwner(DOWN)).code).toBeNull();
    expect(await newColumnCount()).toBe(0);
    expect(await forcedRls()).toEqual(ALL_FORCED);
    expect((await runAsOwner(DOWN)).code).toBeNull();

    await pg().admin.query(sql(UP));
    expect(await newColumnCount()).toBe(5);
    expect(await violated(() => insertLine(aSeller()))).toBeNull();
  });
});
