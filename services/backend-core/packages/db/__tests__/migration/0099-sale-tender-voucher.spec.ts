/**
 * RT-1114: `0099_sale_tender_voucher` migration test (RT-1098 slice R-4a;
 * owner authorization RT-1114 comment 16670).
 *
 * Validates `packages/db/drizzle/0099_sale_tender_voucher.sql` (+ `.down.sql`):
 *   - the UPGRADE path: an existing cash tender is untouched (redemption_id
 *     NULL) and cash / card tenders still insert as before;
 *   - `voucher` is a tender method, and only with a `redemption_id`; a cash or
 *     card tender with one, a voucher without one and a voucher with a
 *     `reference` are refused (23514);
 *   - the composite FK: a redemption of another tenant, of another store of
 *     the same tenant, or that does not exist is refused (23503);
 *   - one redemption pays at most one tender (23505), across sales;
 *   - as the app role under FORCE RLS, a voucher tender of the caller's own
 *     tenant inserts;
 *   - UP -> DOWN -> UP (acceptance 4), also as a NOSUPERUSER migration owner
 *     under FORCE RLS; the down REFUSES while a voucher tender exists and then
 *     restores the 0033 method CHECK, validated.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode, runSqlFile } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0099_sale_tender_voucher.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0099_sale_tender_voucher.down.sql");

const id = (n: string): string => `09900000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_A2 = id("0a022");
const DEVICE_B = id("0b021");
const ACTOR = id("0a0a1");
const BATCH = id("0a0b1");
const ATTEMPT = id("0a0f1");
const MISSING = id("0f0f9");
const LEGACY_SALE = id("0a101");

/** One voucher, its intent and its redemption per scope. */
const R_A = id("0a0e1"); // tenant A, store A
const R_A_2 = id("0a0e2"); // tenant A, store A (a second redemption)
const R_A2 = id("0a0e3"); // tenant A, store A2
const R_B = id("0b0e1"); // tenant B, store B

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";
let saleSeq = 0;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** A voucher, a live intent and its redemption, all of (tenant, store, device). */
async function seedRedemption(
  redemptionId: string,
  scope: { tenant: string; store: string; device: string; hex: string },
): Promise<void> {
  const a = guard().admin;
  const voucher = redemptionId.replace(/e(\d)$/, "c$1");
  const intent = redemptionId.replace(/e(\d)$/, "d$1");
  await a.query(
    `INSERT INTO vouchers (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, applies_to_all_stores, issued_by_user_id, status)
     VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'), 5000, 'EGP', true, $5, 'redeemed')`,
    [voucher, scope.tenant, BATCH, scope.hex, ACTOR],
  );
  await a.query(
    `INSERT INTO voucher_redemption_intents
       (id, tenant_id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        token_hash, operator_user_id, device_id, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, 5000, 0, decode(repeat($6, 32), 'hex'), $7, $8, now() + interval '4 minutes', now())`,
    [intent, scope.tenant, scope.store, voucher, ATTEMPT, scope.hex, ACTOR, scope.device],
  );
  await a.query(
    `INSERT INTO voucher_redemptions
       (id, tenant_id, store_id, voucher_id, intent_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        operator_user_id, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, 5000, 0, $7, $8)`,
    [redemptionId, scope.tenant, scope.store, voucher, intent, ATTEMPT, ACTOR, scope.device],
  );
}

/** A fresh sale of (tenant, store), returned by id. */
async function insertSale(tenant: string, store: string, saleId = id(`0a2${String(++saleSeq).padStart(2, "0")}`)): Promise<string> {
  await guard().admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, tender_count)
     VALUES ($1, $2, $3, 'EGP', 50, '2026-11-12T10:00:00Z', '2026-11-12', 'pos-1', $6, $4, $5, 1)`,
    [saleId, tenant, store, "c".repeat(64), ACTOR, `stv-${saleId}`],
  );
  return saleId;
}

const INSERT_TENDER = `INSERT INTO sale_tenders
    (id, sale_id, tenant_id, store_id, method, amount, currency_code, reference, redemption_id)
  VALUES (gen_random_uuid(), $1, $2, $3, $4, 50, 'EGP', $5, $6)`;

/** Insert one tender as the superuser; the SQLSTATE, or null when it inserts. */
function tender(
  saleId: string,
  scope: { tenant: string; store: string },
  method: string,
  redemptionId: string | null,
  reference: string | null = null,
): Promise<string | null> {
  return errorCode(() =>
    guard().admin.query(INSERT_TENDER, [saleId, scope.tenant, scope.store, method, reference, redemptionId]),
  );
}

const A = { tenant: TENANT_A, store: STORE_A };

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0099-sale-tender-voucher.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
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
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'stv-a', 'STV A', 'EGP'), ($2, 'stv-b', 'STV B', 'EGP')`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     VALUES ($1, $4, 'A1', 'Store A1'), ($2, $4, 'A2', 'Store A2'), ($3, $5, 'B1', 'Store B1')`,
    [STORE_A, STORE_A2, STORE_B, TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $4, $5, decode(repeat('a1', 32), 'hex')), ($2, $4, $6, decode(repeat('a2', 32), 'hex')),
            ($3, $7, $8, decode(repeat('b1', 32), 'hex'))`,
    [DEVICE_A, DEVICE_A2, DEVICE_B, TENANT_A, STORE_A, STORE_A2, TENANT_B, STORE_B],
  );
  await seedRedemption(R_A, { tenant: TENANT_A, store: STORE_A, device: DEVICE_A, hex: "a1" });
  await seedRedemption(R_A_2, { tenant: TENANT_A, store: STORE_A, device: DEVICE_A, hex: "a3" });
  await seedRedemption(R_A2, { tenant: TENANT_A, store: STORE_A2, device: DEVICE_A2, hex: "a2" });
  await seedRedemption(R_B, { tenant: TENANT_B, store: STORE_B, device: DEVICE_B, hex: "b1" });
  // A pre-0099 cash sale (the UPGRADE path).
  await insertSale(TENANT_A, STORE_A, LEGACY_SALE);
  // Before 0099 there is no redemption_id column, so the legacy row is written without it.
  await a.query(
    `INSERT INTO sale_tenders (id, sale_id, tenant_id, store_id, method, amount, currency_code)
     VALUES (gen_random_uuid(), $1, $2, $3, 'cash', 50, 'EGP')`,
    [LEGACY_SALE, TENANT_A, STORE_A],
  );
  await a.query(upSql);
  // The app role's table grants are taken after the DDL.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** Remove every voucher tender (the superuser bypasses RLS and has DELETE). */
async function clearVoucherTenders(): Promise<void> {
  await guard().admin.query(`DELETE FROM sale_tenders WHERE method = 'voucher'`);
}

describe("0099: voucher as a sale tender", () => {
  it("leaves an existing tender untouched and still accepts cash and card tenders", async () => {
    if (skip()) return;
    const legacy = await guard().admin.query<{ method: string; redemption_id: string | null }>(
      `SELECT method, redemption_id FROM sale_tenders WHERE sale_id = $1`,
      [LEGACY_SALE],
    );
    expect(legacy.rows).toEqual([{ method: "cash", redemption_id: null }]);
    const sale = await insertSale(TENANT_A, STORE_A);
    expect(await tender(sale, A, "cash", null)).toBeNull();
    expect(await tender(sale, A, "card_external", null, "AB12")).toBeNull();
  });

  it("accepts a voucher tender only with its redemption, and no other method with one", async () => {
    if (skip()) return;
    try {
      const sale = await insertSale(TENANT_A, STORE_A);
      expect(await tender(sale, A, "voucher", null)).toBe("23514");
      expect(await tender(sale, A, "cash", R_A)).toBe("23514");
      expect(await tender(sale, A, "card_external", R_A)).toBe("23514");
      expect(await tender(sale, A, "voucher", R_A, "AB12")).toBe("23514");
      expect(await tender(sale, A, "gift_card", null)).toBe("23514");
      expect(await tender(sale, A, "voucher", R_A)).toBeNull();
    } finally {
      await clearVoucherTenders();
    }
  });

  it("refuses a redemption of another tenant, of another store, or that does not exist", async () => {
    if (skip()) return;
    const sale = await insertSale(TENANT_A, STORE_A);
    expect(await tender(sale, A, "voucher", R_B)).toBe("23503");
    expect(await tender(sale, A, "voucher", R_A2)).toBe("23503");
    expect(await tender(sale, A, "voucher", MISSING)).toBe("23503");
  });

  it("lets one redemption pay at most one tender, across sales", async () => {
    if (skip()) return;
    try {
      const first = await insertSale(TENANT_A, STORE_A);
      const second = await insertSale(TENANT_A, STORE_A);
      expect(await tender(first, A, "voucher", R_A)).toBeNull();
      expect(await tender(second, A, "voucher", R_A)).toBe("23505");
      expect(await tender(second, A, "voucher", R_A_2)).toBeNull();
    } finally {
      await clearVoucherTenders();
    }
  });

  it("lets the app role insert its own tenant's voucher tender under FORCE RLS", async () => {
    if (skip()) return;
    const sale = await insertSale(TENANT_A, STORE_A);
    await asApp(guard(), TENANT_A, async (client) => {
      await client.query(INSERT_TENDER, [sale, TENANT_A, STORE_A, "voucher", null, R_A]);
      const r = await client.query<{ redemption_id: string }>(
        `SELECT redemption_id FROM sale_tenders WHERE sale_id = $1`,
        [sale],
      );
      expect(r.rows).toEqual([{ redemption_id: R_A }]);
    });
  });
});

describe("0099: UP -> DOWN -> UP (acceptance 4)", () => {
  const OWNER_TABLES = ["tenants", "sales", "sale_tenders", "voucher_redemptions"];
  const redemptionColumn = async (): Promise<number> =>
    Number(
      (
        await guard().admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM information_schema.columns
            WHERE table_name = 'sale_tenders' AND column_name = 'redemption_id'`,
        )
      ).rows[0]!.n,
    );
  const methodCheck = async (): Promise<{ def: string; valid: boolean }> =>
    (
      await guard().admin.query<{ def: string; valid: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid
           FROM pg_constraint WHERE conname = 'sale_tenders_method_valid'`,
      )
    ).rows[0]!;

  it("refuses while a voucher tender exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    const owner = { role: "rt1114_refuse_owner", tables: OWNER_TABLES, functions: [] };
    try {
      const sale = await insertSale(TENANT_A, STORE_A);
      expect(await tender(sale, A, "voucher", R_A)).toBeNull();
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      expect(await redemptionColumn()).toBe(1);
      expect((await methodCheck()).def).toContain("voucher");
    } finally {
      await clearVoucherTenders();
    }
  });

  it("drops what 0099 added once no voucher tender exists, restores the 0033 CHECK validated, is rerunnable, and the up re-adds it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await redemptionColumn()).toBe(0);
    expect(await methodCheck()).toEqual({ def: "CHECK ((method = ANY (ARRAY['cash'::text, 'card_external'::text])))", valid: true });
    const key = await e.admin.query(`SELECT 1 FROM pg_constraint WHERE conname = 'voucher_redemptions_tenant_store_id_uk'`);
    expect(key.rowCount).toBe(0);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await redemptionColumn()).toBe(1);
    expect((await methodCheck()).def).toContain("voucher");
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt1114_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await redemptionColumn()).toBe(1);
  });
});
