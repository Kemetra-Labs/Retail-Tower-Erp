/**
 * RT-1603: `docs/operations/sql/release-prerequisites.sql` on a real PostgreSQL 16.
 *
 * The lab deploy document runs it at G-Prereq (before anything on lab-01 changes) as the
 * migration owner, in a read-only transaction; deploy/README.md runs it as Deploy step 0.
 * This proves, the way 2026-11-25 failed (RT-2 c18831), that it:
 *   - refuses a NOSUPERUSER migration owner when role pricing_projection_writer is missing,
 *     and again when the role exists but the owner is not a member (55000, both named);
 *   - passes once the documented superuser step ran ("Before migration 0132");
 *   - passes for a superuser migration owner (test databases: 0132 creates the role itself);
 *   - runs inside `SET TRANSACTION READ ONLY`, so it writes nothing.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT
 * set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const SQL_PATH = resolve(__dirname, "..", "..", "..", "..", "docs", "operations", "sql", "release-prerequisites.sql");
const OWNER = "rt1603_migration_owner";
const WRITER = "pricing_projection_writer";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
const sql = readFileSync(SQL_PATH, "utf8");

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** Runs the file as `role` (null: the superuser) in a read-only transaction, as the deploy does. */
async function check(role: string | null): Promise<{ code: string | null; message: string }> {
  const client = await guard().admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    if (role !== null) await client.query(`SET ROLE ${role}`);
    await client.query(sql);
    return { code: null, message: "" };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? "unknown", message: e.message ?? "" };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    dockerSkipReason = String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw err;
    return;
  }
  await env.admin.query(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS`);
}, 120_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

describe("release-prerequisites.sql (RT-1603)", () => {
  it("starts on a cluster without the 0132 role", async () => {
    if (skip()) return;
    const { rows } = await guard().admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [WRITER]);
    expect(rows).toHaveLength(0);
  });

  it("passes a superuser migration owner, which lets 0132 create the role itself", async () => {
    if (skip()) return;
    expect(await check(null)).toEqual({ code: null, message: "" });
  });

  it("refuses a NOSUPERUSER migration owner while the role is missing", async () => {
    if (skip()) return;
    const r = await check(OWNER);
    expect(r.code).toBe("55000");
    expect(r.message).toContain("release prerequisites missing: role pricing_projection_writer does not exist");
  });

  it("refuses it again while the owner is not a member of the role", async () => {
    if (skip()) return;
    await guard().admin.query(`CREATE ROLE ${WRITER} NOLOGIN`);
    const r = await check(OWNER);
    expect(r.code).toBe("55000");
    expect(r.message).toContain(`${OWNER} is not a member of pricing_projection_writer`);
  });

  it("passes, read-only, once the documented superuser step ran", async () => {
    if (skip()) return;
    await guard().admin.query(`GRANT ${WRITER} TO ${OWNER}`);
    expect(await check(OWNER)).toEqual({ code: null, message: "" });
  });
});
