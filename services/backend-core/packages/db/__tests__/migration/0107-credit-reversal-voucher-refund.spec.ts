/**
 * RT-1343 item 2: `0107_credit_reversal_voucher_refund` migration test.
 *
 * Validates `packages/db/drizzle/0107_credit_reversal_voucher_refund.sql`
 * (+ `.down.sql`):
 *   - `sale_credit_reversal_tenders_method_valid` accepts `voucher` after UP,
 *     still refuses an unknown method, and the unchanged
 *     `reference_card_only` CHECK still refuses a reference on a voucher;
 *   - UP -> DOWN -> UP round-trips as a NOSUPERUSER migration owner of the
 *     table; after DOWN a voucher row is refused again.
 *
 * The CHECKs are probed with rows whose parents do not exist: Postgres
 * evaluates a CHECK when the row is formed and the foreign keys afterwards
 * (RI triggers), so a row that passes every CHECK fails with 23503 (FK) and a
 * row that breaks one fails with 23514 (CHECK). No parent rows are needed.
 *
 * Docker policy: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyMigrationsBefore, asMigrationOwner, errorCode, runSqlFile } from "../_helpers/migration-spec";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_NAME = "0107_credit_reversal_voucher_refund.sql";
const UP_PATH = resolve(DRIZZLE_DIR, UP_NAME);
const DOWN_PATH = resolve(DRIZZLE_DIR, "0107_credit_reversal_voucher_refund.down.sql");
const CONSTRAINT = "sale_credit_reversal_tenders_method_valid";
const OWNER = { role: "rt1343_migration_owner", tables: ["sale_credit_reversal_tenders"], functions: [] };

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

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
      console.warn(`\n[0107-credit-reversal-voucher-refund.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  await env.admin.query(readFileSync(UP_PATH, "utf8"));
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** The error code of inserting one refund tender with no parent rows (23503 = every CHECK passed). */
function probe(method: string, reference: string | null = null): Promise<string | null> {
  return errorCode(() =>
    guard().admin.query(
      `INSERT INTO sale_credit_reversal_tenders (reversal_id, tenant_id, store_id, ordinal, method, amount, reference)
       VALUES ($1, $2, $3, 0, $4, 1, $5)`,
      [randomUUID(), randomUUID(), randomUUID(), method, reference],
    ),
  );
}

async function constraintDef(): Promise<string> {
  const r = await guard().admin.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'sale_credit_reversal_tenders'::regclass AND conname = $1`,
    [CONSTRAINT],
  );
  return r.rows[0]?.def ?? "";
}

describe("0107: files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0107: the method CHECK after UP", () => {
  it("names the three methods", async () => {
    if (skip()) return;
    const def = await constraintDef();
    for (const m of ["cash", "card_external", "voucher"]) expect(def).toContain(`'${m}'`);
  });

  it("accepts cash, card_external and voucher (the row then fails only its foreign keys)", async () => {
    if (skip()) return;
    expect(await probe("cash")).toBe("23503");
    expect(await probe("card_external", "AB12")).toBe("23503");
    expect(await probe("voucher")).toBe("23503");
  });

  it("still refuses an unknown method, and a reference on a voucher (reference_card_only unchanged)", async () => {
    if (skip()) return;
    expect(await probe("gift_card")).toBe("23514");
    expect(await probe("voucher", "AB12")).toBe("23514");
  });
});

describe("0107: DOWN and UP again, as a NOSUPERUSER migration owner", () => {
  it("round-trips; after DOWN a voucher is refused again", async () => {
    if (skip()) return;
    const e = guard();
    await asMigrationOwner(e, OWNER, async () => {
      expect(await runSqlFile(e, DOWN_PATH, OWNER.role)).toBeNull();
      expect(await probe("voucher")).toBe("23514");
      expect(await probe("cash")).toBe("23503");
      expect(await runSqlFile(e, UP_PATH, OWNER.role)).toBeNull();
      expect(await probe("voucher")).toBe("23503");
    });
  });
});
