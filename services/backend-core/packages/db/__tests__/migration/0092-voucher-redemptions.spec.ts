/**
 * RT-1111: `0092_voucher_redemptions` migration test (voucher redemption slice
 * R-2 of RT-1098; owner authorization RT-1098 comment 16496).
 *
 * Validates `packages/db/drizzle/0092_voucher_redemptions.sql` (+ `.down.sql`):
 *   - FORCE RLS and the exact policy set: SELECT + INSERT + UPDATE on both
 *     tables, no DELETE policy on either;
 *   - the CHECKs: applied amount > 0, forfeited amount >= 0, both bounded by
 *     2^53 - 1, the 5-minute intent TTL, and the reverse columns set together;
 *   - UNIQUE (tenant_id, token_hash), and one redemption per intent;
 *   - the composite FKs (AC1): a voucher, store, intent or device (including a
 *     device of another store) of another tenant, or
 *     that does not exist, is refused;
 *   - the partial unique index: a second un-reversed redemption of a voucher is
 *     refused, and allowed once the first is reversed;
 *   - tenant isolation (AC2): COMMITTED tenant-A rows are invisible to tenant
 *     B, an UPDATE by id affects 0 rows, an UPDATE with no WHERE touches only
 *     B's own row, and tenant A is unchanged afterwards; no DELETE;
 *   - UP -> DOWN -> UP (AC3), also as a NOSUPERUSER migration owner under FORCE
 *     RLS, and the down REFUSES while an intent or a redemption exists.
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
const UP_NAME = "0092_voucher_redemptions.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0092_voucher_redemptions.down.sql");

const id = (n: string): string => `09200000-0000-7000-8000-0000000${n}`;
const TENANT_A = id("0a001");
const TENANT_B = id("0b001");
const STORE_A = id("0a011");
const STORE_A2 = id("0a012");
const STORE_B = id("0b011");
const DEVICE_A = id("0a021");
const DEVICE_A2 = id("0a022"); // tenant A, store A2
const DEVICE_A3 = id("0a023"); // tenant A, store A1 (a second device of STORE_A)
const DEVICE_B = id("0b021");
const ACTOR = id("0a0a1");
const BATCH = id("0a0b1");
const VOUCHER_A = id("0a0c1");
const VOUCHER_A2 = id("0a0c2");
const VOUCHER_B = id("0b0c1");
const MISSING = id("0f0f9");
const INTENT_A = id("0a0d1");
const INTENT_A2 = id("0a0d2");
const INTENT_B = id("0b0d1");
const REDEMPTION_A = id("0a0e1");
const REDEMPTION_A2 = id("0a0e2");
const REDEMPTION_B = id("0b0e1");
const ATTEMPT = id("0a0f1");

const I = "voucher_redemption_intents";
const R = "voucher_redemptions";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const voucherInsert = `INSERT INTO vouchers (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, applies_to_all_stores, issued_by_user_id)
  VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'), 5000, 'USD', true, $5)`;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0092-voucher-redemptions.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
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
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'vrd-a', 'VRD A', 'USD'), ($2, 'vrd-b', 'VRD B', 'USD')`,
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
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash) VALUES ($1, $2, $3, decode(repeat('a3', 32), 'hex'))`,
    [DEVICE_A3, TENANT_A, STORE_A],
  );
  await a.query(voucherInsert, [VOUCHER_A, TENANT_A, BATCH, "a1", ACTOR]);
  await a.query(voucherInsert, [VOUCHER_A2, TENANT_A, BATCH, "a2", ACTOR]);
  await a.query(voucherInsert, [VOUCHER_B, TENANT_B, BATCH, "b1", ACTOR]);
  await a.query(upSql);
  // The app role's table grants are taken after the tables exist.
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

interface IntentRow {
  id: string;
  tenant_id: string;
  store_id: string;
  voucher_id: string;
  payment_attempt_id: string;
  applied_amount_minor: number | string;
  forfeited_amount_minor: number | string;
  token_hash: Buffer;
  operator_user_id: string;
  device_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface RedemptionRow {
  id: string;
  tenant_id: string;
  store_id: string;
  voucher_id: string;
  intent_id: string;
  payment_attempt_id: string;
  applied_amount_minor: number | string;
  forfeited_amount_minor: number | string;
  operator_user_id: string;
  device_id: string;
  redeemed_at: string;
  reversed_at: string | null;
  reversed_by_device_id: string | null;
}

const hash = (hex: string): Buffer => Buffer.from(hex.repeat(32).slice(0, 64), "hex");
const CREATED = "2026-11-11T10:00:00Z";
const IN_5_MIN = "2026-11-11T10:05:00Z";
const IN_5_MIN_1S = "2026-11-11T10:05:01Z";
// Well before any real "now", so reversing with now() satisfies reversed_at >= redeemed_at.
const REDEEMED = "2026-11-01T00:00:00Z";

const INTENT: IntentRow = {
  id: INTENT_A,
  tenant_id: TENANT_A,
  store_id: STORE_A,
  voucher_id: VOUCHER_A,
  payment_attempt_id: ATTEMPT,
  applied_amount_minor: 3000,
  forfeited_amount_minor: 2000,
  token_hash: hash("c1"),
  operator_user_id: ACTOR,
  device_id: DEVICE_A,
  created_at: CREATED,
  expires_at: IN_5_MIN,
  consumed_at: null,
};
const INTENT_2: IntentRow = { ...INTENT, id: INTENT_A2, token_hash: hash("c2") };
const INTENT_OF_B: IntentRow = {
  ...INTENT,
  id: INTENT_B,
  tenant_id: TENANT_B,
  store_id: STORE_B,
  voucher_id: VOUCHER_B,
  device_id: DEVICE_B,
  token_hash: hash("d1"),
};

const REDEMPTION: RedemptionRow = {
  id: REDEMPTION_A,
  tenant_id: TENANT_A,
  store_id: STORE_A,
  voucher_id: VOUCHER_A,
  intent_id: INTENT_A,
  payment_attempt_id: ATTEMPT,
  applied_amount_minor: 3000,
  forfeited_amount_minor: 2000,
  operator_user_id: ACTOR,
  device_id: DEVICE_A,
  redeemed_at: REDEEMED,
  reversed_at: null,
  reversed_by_device_id: null,
};
const REDEMPTION_OF_B: RedemptionRow = {
  ...REDEMPTION,
  id: REDEMPTION_B,
  tenant_id: TENANT_B,
  store_id: STORE_B,
  voucher_id: VOUCHER_B,
  intent_id: INTENT_B,
  device_id: DEVICE_B,
};

/** An intent that is live right now, so a consume with now() lies within [created_at, expires_at]. */
const fresh = (row: IntentRow): IntentRow => {
  const now = Date.now();
  return { ...row, created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 120_000).toISOString() };
};

const I_COLS = Object.keys(INTENT) as (keyof IntentRow)[];
const R_COLS = Object.keys(REDEMPTION) as (keyof RedemptionRow)[];
const insertSql = (table: string, cols: string[]): string =>
  `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
const INSERT_I = insertSql(I, I_COLS);
const INSERT_R = insertSql(R, R_COLS);
const intentValues = (row: IntentRow): unknown[] => I_COLS.map((c) => row[c]);
const redemptionValues = (row: RedemptionRow): unknown[] => R_COLS.map((c) => row[c]);

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
async function code(sql: string, params: unknown[], before?: (c: PoolClient) => Promise<void>): Promise<string | null> {
  let result: string | null = null;
  await inTx(async (client, attempt) => {
    if (before) await before(client);
    result = (await attempt(sql, params))?.code ?? null;
  });
  return result;
}

const withIntent = async (c: PoolClient): Promise<void> => {
  await c.query(INSERT_I, intentValues(INTENT));
};
/** The intent a redemption with these amounts binds to (same id, store, voucher and attempt as INTENT). */
const withIntentAmounts =
  (applied: number, forfeited: number) =>
  async (c: PoolClient): Promise<void> => {
    await c.query(INSERT_I, intentValues({ ...INTENT, applied_amount_minor: applied, forfeited_amount_minor: forfeited }));
  };

/** Commit tenant A's intent and redemption as the superuser; the caller clears them. */
async function seedA(): Promise<void> {
  await guard().admin.query(INSERT_I, intentValues(INTENT));
  await guard().admin.query(INSERT_R, redemptionValues(REDEMPTION));
}
async function clearAll(): Promise<void> {
  await guard().admin.query(`DELETE FROM ${R}`);
  await guard().admin.query(`DELETE FROM ${I}`);
}

describe("0092: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0092: RLS and policies", () => {
  it("forces RLS on both tables with the exact policy set", async () => {
    if (skip()) return;
    const rls = await guard().admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid IN (to_regclass($1), to_regclass($2)) ORDER BY relname COLLATE "C"`,
      [I, R],
    );
    expect(rls.rows).toEqual([
      { relname: I, relrowsecurity: true, relforcerowsecurity: true },
      { relname: R, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await guard().admin.query<{ tablename: string; policyname: string; cmd: string }>(
      `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ($1, $2)
        ORDER BY tablename COLLATE "C", policyname COLLATE "C"`,
      [I, R],
    );
    expect(policies.rows).toEqual([
      { tablename: I, policyname: `${I}_tenant_insert`, cmd: "INSERT" },
      { tablename: I, policyname: `${I}_tenant_select`, cmd: "SELECT" },
      { tablename: I, policyname: `${I}_tenant_update`, cmd: "UPDATE" },
      { tablename: R, policyname: `${R}_tenant_insert`, cmd: "INSERT" },
      { tablename: R, policyname: `${R}_tenant_select`, cmd: "SELECT" },
      { tablename: R, policyname: `${R}_tenant_update`, cmd: "UPDATE" },
    ]);
  });
});

describe("0092: voucher_redemption_intents constraints", () => {
  it("stores an intent, a consumed one, zero forfeit, the largest safe amounts and a 5-minute TTL", async () => {
    if (skip()) return;
    expect(await code(INSERT_I, intentValues(INTENT))).toBeNull();
    expect(await code(INSERT_I, intentValues({ ...INTENT, consumed_at: "2026-11-11T10:01:00Z" }))).toBeNull();
    expect(await code(INSERT_I, intentValues({ ...INTENT, forfeited_amount_minor: 0 }))).toBeNull();
    // The largest valid splits: the sum, not each amount alone, is bounded.
    expect(await code(INSERT_I, intentValues({ ...INTENT, applied_amount_minor: Number.MAX_SAFE_INTEGER, forfeited_amount_minor: 0 }))).toBeNull();
    expect(
      await code(INSERT_I, intentValues({ ...INTENT, applied_amount_minor: 1, forfeited_amount_minor: Number.MAX_SAFE_INTEGER - 1 })),
    ).toBeNull();
    // Exactly 5 minutes is the limit and is accepted; a shorter TTL too.
    expect(await code(INSERT_I, intentValues({ ...INTENT, expires_at: IN_5_MIN }))).toBeNull();
    expect(await code(INSERT_I, intentValues({ ...INTENT, expires_at: "2026-11-11T10:01:00Z" }))).toBeNull();
  });

  it.each<[string, Partial<IntentRow>]>([
    ["a zero applied amount", { applied_amount_minor: 0 }],
    ["a negative applied amount", { applied_amount_minor: -1 }],
    ["an applied amount above the JS safe-integer bound", { applied_amount_minor: "9007199254740992" }],
    ["a negative forfeited amount", { forfeited_amount_minor: -1 }],
    ["a forfeited amount above the JS safe-integer bound", { forfeited_amount_minor: "9007199254740992" }],
    ["an applied + forfeited sum above the JS safe-integer bound", { applied_amount_minor: Number.MAX_SAFE_INTEGER, forfeited_amount_minor: 1 }],
    ["a TTL one second over 5 minutes", { expires_at: IN_5_MIN_1S }],
    ["an expiry equal to the creation time", { expires_at: CREATED }],
    ["an expiry before the creation time", { expires_at: "2026-11-11T09:59:00Z" }],
    ["a consumption before the creation time", { consumed_at: "2026-11-11T09:59:00Z" }],
    ["a consumption after the expiry", { consumed_at: IN_5_MIN_1S }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await code(INSERT_I, intentValues({ ...INTENT, ...change }))).toBe("23514");
  });

  it("refuses a missing tenant (23503) and a missing required column (23502)", async () => {
    if (skip()) return;
    expect(await code(INSERT_I, intentValues({ ...INTENT, tenant_id: id("0f001") }))).toBe("23503");
    expect(await code(INSERT_I, intentValues({ ...INTENT, token_hash: null as unknown as Buffer }))).toBe("23502");
    expect(await code(INSERT_I, intentValues({ ...INTENT, device_id: null as unknown as string }))).toBe("23502");
    expect(await code(INSERT_I, intentValues({ ...INTENT, operator_user_id: null as unknown as string }))).toBe("23502");
  });

  it("enforces UNIQUE (tenant_id, token_hash): a duplicate in one tenant is refused, in another tenant is allowed", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      await client.query(INSERT_I, intentValues(INTENT));
      const dup = await attempt(INSERT_I, intentValues({ ...INTENT, id: INTENT_A2 }));
      expect(dup).toEqual({ code: "23505", constraint: "voucher_redemption_intents_tenant_token_hash_uk" });
      await client.query(INSERT_I, intentValues({ ...INTENT_OF_B, token_hash: INTENT.token_hash }));
    });
  });
});

describe("0092: voucher_redemptions constraints", () => {
  it("stores an open redemption, a reversed one, zero forfeit and the largest safe amounts", async () => {
    if (skip()) return;
    expect(await code(INSERT_R, redemptionValues(REDEMPTION), withIntent)).toBeNull();
    expect(
      await code(
        INSERT_R,
        redemptionValues({ ...REDEMPTION, reversed_at: "2026-11-11T11:00:00Z", reversed_by_device_id: DEVICE_A }),
        withIntent,
      ),
    ).toBeNull();
    expect(
      await code(INSERT_R, redemptionValues({ ...REDEMPTION, forfeited_amount_minor: 0 }), withIntentAmounts(3000, 0)),
    ).toBeNull();
    // The largest valid splits: the sum, not each amount alone, is bounded.
    expect(
      await code(
        INSERT_R,
        redemptionValues({ ...REDEMPTION, applied_amount_minor: Number.MAX_SAFE_INTEGER, forfeited_amount_minor: 0 }),
        withIntentAmounts(Number.MAX_SAFE_INTEGER, 0),
      ),
    ).toBeNull();
    expect(
      await code(
        INSERT_R,
        redemptionValues({ ...REDEMPTION, applied_amount_minor: 1, forfeited_amount_minor: Number.MAX_SAFE_INTEGER - 1 }),
        withIntentAmounts(1, Number.MAX_SAFE_INTEGER - 1),
      ),
    ).toBeNull();
  });

  it.each<[string, Partial<RedemptionRow>]>([
    ["a zero applied amount", { applied_amount_minor: 0 }],
    ["a negative applied amount", { applied_amount_minor: -1 }],
    ["an applied amount above the JS safe-integer bound", { applied_amount_minor: "9007199254740992" }],
    ["a negative forfeited amount", { forfeited_amount_minor: -1 }],
    ["a forfeited amount above the JS safe-integer bound", { forfeited_amount_minor: "9007199254740992" }],
    ["an applied + forfeited sum above the JS safe-integer bound", { applied_amount_minor: Number.MAX_SAFE_INTEGER, forfeited_amount_minor: 1 }],
    ["a reverse before the redeem", { reversed_at: "2026-10-31T00:00:00Z", reversed_by_device_id: DEVICE_A }],
    ["reversed_at without the reversing device", { reversed_at: "2026-11-11T11:00:00Z" }],
    ["a reversing device without reversed_at", { reversed_by_device_id: DEVICE_A }],
  ])("refuses %s (23514)", async (_why, change) => {
    if (skip()) return;
    expect(await code(INSERT_R, redemptionValues({ ...REDEMPTION, ...change }), withIntent)).toBe("23514");
  });

  it("refuses a missing required column (23502)", async () => {
    if (skip()) return;
    expect(await code(INSERT_R, redemptionValues({ ...REDEMPTION, operator_user_id: null as unknown as string }), withIntent)).toBe(
      "23502",
    );
  });
});

describe("0092: composite FKs (AC1)", () => {
  it("refuses an intent whose voucher, store or device belongs to another tenant or store, or does not exist (23503)", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      const fk = (r: Refusal | null): string | null => (r ? `${r.code}:${r.constraint}` : null);
      // A same-tenant row is fine.
      expect(fk(await attempt(INSERT_I, intentValues(INTENT)))).toBeNull();
      // Tenant A's row naming tenant B's voucher / a missing voucher.
      expect(fk(await attempt(INSERT_I, intentValues({ ...INTENT, voucher_id: VOUCHER_B })))).toBe(
        "23503:fk_voucher_redemption_intents_voucher_tenant",
      );
      expect(fk(await attempt(INSERT_I, intentValues({ ...INTENT, voucher_id: MISSING })))).toBe(
        "23503:fk_voucher_redemption_intents_voucher_tenant",
      );
      // Tenant A's row naming tenant B's store (this also trips the device composite FK, so the code only).
      expect((await attempt(INSERT_I, intentValues({ ...INTENT, store_id: STORE_B })))?.code).toBe("23503");
      // Tenant B's device, and tenant A's device of another store.
      expect(fk(await attempt(INSERT_I, intentValues({ ...INTENT, device_id: DEVICE_B })))).toBe(
        "23503:fk_voucher_redemption_intents_device_store_tenant",
      );
      expect(fk(await attempt(INSERT_I, intentValues({ ...INTENT, device_id: DEVICE_A2, token_hash: hash("c9") })))).toBe(
        "23503:fk_voucher_redemption_intents_device_store_tenant",
      );
    });
  });

  it("refuses a redemption whose voucher, intent or device belongs to another tenant or store, or does not exist (23503)", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      const fk = (r: Refusal | null): string | null => (r ? `${r.code}:${r.constraint}` : null);
      await client.query(INSERT_I, intentValues(INTENT));
      await client.query(INSERT_I, intentValues(INTENT_OF_B));
      // These also differ from the intent's voucher (the binding FK), so only the code is asserted.
      expect((await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, voucher_id: VOUCHER_B })))?.code).toBe("23503");
      expect((await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, voucher_id: MISSING })))?.code).toBe("23503");
      // Tenant A's redemption citing tenant B's intent, and a missing intent.
      expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, intent_id: INTENT_B })))).toBe(
        "23503:fk_voucher_redemptions_intent_tenant",
      );
      expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, intent_id: MISSING })))).toBe(
        "23503:fk_voucher_redemptions_intent_tenant",
      );
      // The store assertions also trip the device composite FK (and, for a redemption, the binding FK), so they
      // check the code only; the device FK already implies the store.
      expect((await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, store_id: STORE_B })))?.code).toBe("23503");
      expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, device_id: DEVICE_B })))).toBe(
        "23503:fk_voucher_redemptions_device_store_tenant",
      );
      expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, device_id: DEVICE_A2 })))).toBe(
        "23503:fk_voucher_redemptions_device_store_tenant",
      );
      // The same-tenant, same-store row is accepted.
      expect(fk(await attempt(INSERT_R, redemptionValues(REDEMPTION)))).toBeNull();
      // A different device of the same store may redeem (the binding leaves device_id out).
      expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, device_id: DEVICE_A3 })))).toBeNull();
      // The reversing device: any device of the redemption's store is accepted ...
      const reversed = { reversed_at: "2026-11-11T11:00:00Z" };
      for (const device of [DEVICE_A, DEVICE_A3]) {
        expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, ...reversed, reversed_by_device_id: device })))).toBeNull();
      }
      // ... one of another store, another tenant's device and a missing one are refused.
      for (const device of [DEVICE_A2, DEVICE_B, MISSING]) {
        expect(fk(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, ...reversed, reversed_by_device_id: device })))).toBe(
          "23503:fk_voucher_redemptions_reversed_by_device_store_tenant",
        );
      }
    });
  });

  it("refuses a redemption that differs from its intent in store, voucher, payment attempt or amounts (23503, the binding FK)", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      await client.query(INSERT_I, intentValues(INTENT));
      const binding = "23503:fk_voucher_redemptions_intent_tenant";
      const refused = async (change: Partial<RedemptionRow>): Promise<string | null> => {
        const r = await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, ...change }));
        return r ? `${r.code}:${r.constraint}` : null;
      };
      // Each other row is valid on its own (voucher, store and device exist in the tenant), so only the binding fails.
      expect(await refused({ voucher_id: VOUCHER_A2 })).toBe(binding);
      expect(await refused({ store_id: STORE_A2, device_id: DEVICE_A2 })).toBe(binding);
      expect(await refused({ payment_attempt_id: id("0a0f2") })).toBe(binding);
      expect(await refused({ applied_amount_minor: 2999 })).toBe(binding);
      expect(await refused({ forfeited_amount_minor: 1999 })).toBe(binding);
      // The matching row is accepted.
      expect(await refused({})).toBeNull();
    });
  });

  it("refuses to delete a voucher, intent or device that a row cites (23503, ON DELETE RESTRICT)", async () => {
    if (skip()) return;
    await seedA();
    try {
      expect(await code(`DELETE FROM vouchers WHERE id = $1`, [VOUCHER_A])).toBe("23503");
      expect(await code(`DELETE FROM ${I} WHERE id = $1`, [INTENT_A])).toBe("23503");
      expect(await code(`DELETE FROM devices WHERE id = $1`, [DEVICE_A])).toBe("23503");
    } finally {
      await clearAll();
    }
  });
});

describe("0092: one redemption per intent, one open redemption per voucher", () => {
  it("refuses a second un-reversed redemption of a voucher, and allows one after the first is reversed", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      await client.query(INSERT_I, intentValues(INTENT));
      await client.query(INSERT_I, intentValues(INTENT_2));
      await client.query(INSERT_R, redemptionValues(REDEMPTION));
      const second = { ...REDEMPTION, id: REDEMPTION_A2, intent_id: INTENT_A2 };
      expect(await attempt(INSERT_R, redemptionValues(second))).toEqual({
        code: "23505",
        constraint: "uq_voucher_redemptions_open_per_voucher",
      });
      // A different voucher (with its own intent) is unaffected.
      const intent3: IntentRow = { ...INTENT, id: id("0a0d3"), voucher_id: VOUCHER_A2, token_hash: hash("c3") };
      await client.query(INSERT_I, intentValues(intent3));
      expect(
        await attempt(INSERT_R, redemptionValues({ ...second, id: id("0a0e3"), intent_id: intent3.id, voucher_id: VOUCHER_A2 })),
      ).toBeNull();
      // Reversing the first frees the voucher.
      await client.query(`UPDATE ${R} SET reversed_at = now(), reversed_by_device_id = $1 WHERE id = $2`, [DEVICE_A, REDEMPTION_A]);
      expect(await attempt(INSERT_R, redemptionValues(second))).toBeNull();
    });
  });

  it("refuses a second redemption of the same intent, even once the first is reversed", async () => {
    if (skip()) return;
    await inTx(async (client, attempt) => {
      await client.query(INSERT_I, intentValues(INTENT));
      await client.query(INSERT_R, redemptionValues({ ...REDEMPTION, reversed_at: "2026-11-11T11:00:00Z", reversed_by_device_id: DEVICE_A }));
      expect(await attempt(INSERT_R, redemptionValues({ ...REDEMPTION, id: REDEMPTION_A2 }))).toEqual({
        code: "23505",
        constraint: "voucher_redemptions_tenant_intent_uk",
      });
    });
  });
});

describe("0092: voucher_redemptions updated_at trigger", () => {
  it("moves updated_at forward on UPDATE", async () => {
    if (skip()) return;
    await inTx(async (client) => {
      await client.query(INSERT_I, intentValues(INTENT));
      await client.query(insertSql(R, [...R_COLS, "updated_at"]), [...redemptionValues(REDEMPTION), "2026-01-01T00:00:00Z"]);
      await client.query(`UPDATE ${R} SET reversed_at = now(), reversed_by_device_id = $1 WHERE id = $2`, [DEVICE_A, REDEMPTION_A]);
      const after = await client.query<{ moved: boolean }>(
        `SELECT updated_at > '2026-01-01T00:00:00Z'::timestamptz AS moved FROM ${R} WHERE id = $1`,
        [REDEMPTION_A],
      );
      expect(after.rows).toEqual([{ moved: true }]);
    });
  });
});

describe("0092: tenant isolation (AC2, FORCE RLS)", () => {
  it("lets the app role read only its own tenant's COMMITTED rows; cross-tenant writes and no-WHERE UPDATEs never reach another tenant", async () => {
    if (skip()) return;
    // Tenant A's rows are committed as the superuser, so they are really there
    // when tenant B's session runs (asApp rolls back).
    try {
      await seedA();
      await asApp(guard(), TENANT_A, async (client) => {
        expect((await client.query(`SELECT id FROM ${I}`)).rows).toEqual([{ id: INTENT_A }]);
        expect((await client.query(`SELECT id FROM ${R}`)).rows).toEqual([{ id: REDEMPTION_A }]);
        // Another tenant's rows are refused by the INSERT policies (42501).
        await client.query("SAVEPOINT other_i");
        await expect(client.query(INSERT_I, intentValues(INTENT_OF_B))).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other_i");
        await client.query("SAVEPOINT other_r");
        await expect(client.query(INSERT_R, redemptionValues(REDEMPTION_OF_B))).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT other_r");
      });
      await asApp(guard(), TENANT_B, async (client) => {
        await client.query(INSERT_I, intentValues(fresh(INTENT_OF_B)));
        await client.query(INSERT_R, redemptionValues(REDEMPTION_OF_B));
        // Tenant B sees only its own rows: not the committed tenant-A ones.
        expect((await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${I}`)).rows).toEqual([{ tenant_id: TENANT_B }]);
        expect((await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM ${R}`)).rows).toEqual([{ tenant_id: TENANT_B }]);
        // An UPDATE by id of tenant A's rows affects nothing: they are invisible to the UPDATE policy.
        expect((await client.query(`UPDATE ${I} SET consumed_at = now() WHERE id = $1`, [INTENT_A])).rowCount).toBe(0);
        expect(
          (
            await client.query(`UPDATE ${R} SET reversed_at = now(), reversed_by_device_id = $2 WHERE id = $1`, [
              REDEMPTION_A,
              DEVICE_B,
            ])
          ).rowCount,
        ).toBe(0);
        // An UPDATE with no WHERE touches only the caller's own row (the UPDATE
        // policy alone; a USING (true) policy would also change tenant A's).
        expect((await client.query(`UPDATE ${I} SET consumed_at = now()`)).rowCount).toBe(1);
        expect(
          (await client.query(`UPDATE ${R} SET reversed_at = now(), reversed_by_device_id = $1`, [DEVICE_B])).rowCount,
        ).toBe(1);
      });
      // The superuser confirms tenant A's rows were not touched.
      const i = await guard().admin.query<{ consumed_at: string | null }>(`SELECT consumed_at FROM ${I} WHERE id = $1`, [INTENT_A]);
      expect(i.rows).toEqual([{ consumed_at: null }]);
      const r = await guard().admin.query<{ reversed_at: string | null; reversed_by_device_id: string | null }>(
        `SELECT reversed_at, reversed_by_device_id FROM ${R} WHERE id = $1`,
        [REDEMPTION_A],
      );
      expect(r.rows).toEqual([{ reversed_at: null, reversed_by_device_id: null }]);
    } finally {
      await clearAll();
    }
  });

  it("lets the app role consume its own intent and reverse its own redemption but never delete, and never move a row to another tenant", async () => {
    if (skip()) return;
    try {
      await asApp(guard(), TENANT_A, async (client) => {
        await client.query(INSERT_I, intentValues(fresh(INTENT)));
        await client.query(INSERT_R, redemptionValues(REDEMPTION));
        const consume = `UPDATE ${I} SET consumed_at = now() WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL`;
        expect((await client.query(consume, [TENANT_A, INTENT_A])).rowCount).toBe(1);
        // The conditional write wins once.
        expect((await client.query(consume, [TENANT_A, INTENT_A])).rowCount).toBe(0);
        const reverse = `UPDATE ${R} SET reversed_at = now(), reversed_by_device_id = $3
                          WHERE tenant_id = $1 AND id = $2 AND reversed_at IS NULL`;
        expect((await client.query(reverse, [TENANT_A, REDEMPTION_A, DEVICE_A])).rowCount).toBe(1);
        expect((await client.query(reverse, [TENANT_A, REDEMPTION_A, DEVICE_A])).rowCount).toBe(0);
        // An UPDATE that would move a row to another tenant is refused (WITH CHECK).
        await client.query("SAVEPOINT move");
        await expect(client.query(`UPDATE ${I} SET tenant_id = $1 WHERE id = $2`, [TENANT_B, INTENT_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT move");
        await client.query("SAVEPOINT move_r");
        await expect(client.query(`UPDATE ${R} SET tenant_id = $1 WHERE id = $2`, [TENANT_B, REDEMPTION_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK TO SAVEPOINT move_r");
        // No DELETE policy on either table.
        expect((await client.query(`DELETE FROM ${R}`)).rowCount).toBe(0);
        expect((await client.query(`DELETE FROM ${I}`)).rowCount).toBe(0);
        expect((await client.query(`SELECT 1 FROM ${I}`)).rowCount).toBe(1);
      });
    } finally {
      await clearAll();
    }
  });

  it("shows nothing under an empty tenant GUC", async () => {
    if (skip()) return;
    try {
      await seedA();
      await asApp(guard(), "", async (client) => {
        expect((await client.query(`SELECT 1 FROM ${I}`)).rowCount).toBe(0);
        expect((await client.query(`SELECT 1 FROM ${R}`)).rowCount).toBe(0);
      });
    } finally {
      await clearAll();
    }
  });
});

describe("0092: UP -> DOWN -> UP (AC3)", () => {
  const exists = async (table: string): Promise<boolean> =>
    (await guard().admin.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [table])).rows[0]!.t !== null;
  const OWNER_TABLES = ["tenants", "stores", "devices", "vouchers", I, R];

  it("refuses while an intent exists (even with no redemption) or a redemption exists, also as a NOSUPERUSER migration owner, and changes nothing", async () => {
    if (skip()) return;
    const e = guard();
    const owner = { role: "rt1111_refuse_owner", tables: OWNER_TABLES, functions: [] };
    const owner2 = { role: "rt1111_refuse_owner_2", tables: OWNER_TABLES, functions: [] };
    try {
      // An intent alone.
      await e.admin.query(INSERT_I, intentValues(INTENT));
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      await asMigrationOwner(e, owner, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner.role)).toBe("P0001");
      });
      // An intent and its redemption.
      await e.admin.query(INSERT_R, redemptionValues(REDEMPTION));
      expect(await runSqlFile(e, DOWN_PATH)).toBe("P0001");
      await asMigrationOwner(e, owner2, async () => {
        expect(await runSqlFile(e, DOWN_PATH, owner2.role)).toBe("P0001");
      });
      expect(await exists(I)).toBe(true);
      expect(await exists(R)).toBe(true);
      expect((await e.admin.query(`SELECT 1 FROM ${I}`)).rowCount).toBe(1);
      expect((await e.admin.query(`SELECT 1 FROM ${R}`)).rowCount).toBe(1);
    } finally {
      await clearAll();
    }
  });

  it("drops both tables once empty, is rerunnable, and the up recreates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    expect(await exists(I)).toBe(false);
    expect(await exists(R)).toBe(false);
    await e.admin.query(downSql);
    await e.admin.query(upSql);
    expect(await exists(I)).toBe(true);
    expect(await exists(R)).toBe(true);
  });

  it("runs DOWN and UP as a NOSUPERUSER migration owner under FORCE RLS", async () => {
    if (skip()) return;
    const owner = { role: "rt1111_owner", tables: OWNER_TABLES, functions: [] };
    await asMigrationOwner(guard(), owner, async () => {
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), DOWN_PATH, owner.role)).toBeNull();
      expect(await runSqlFile(guard(), UP_PATH, owner.role)).toBeNull();
    });
    expect(await exists(I)).toBe(true);
    expect(await exists(R)).toBe(true);
  });
});
