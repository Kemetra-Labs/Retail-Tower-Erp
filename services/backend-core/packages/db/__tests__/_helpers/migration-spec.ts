/**
 * Shared scaffolding for the per-migration specs (first used by 0067, RT-787):
 *
 *   - `applyMigrationsBefore`: apply every up file that sorts before a
 *     migration (the UPGRADE path), then create the app role;
 *   - `inRolledBackTx`: run `fn` on one superuser connection, always rolled back;
 *   - `asApp`: run `fn` as the non-superuser app role with `app.current_tenant`
 *     set to `guc` (null leaves it unset), always rolled back;
 *   - `errorCode`: the Postgres error code `fn` raised, or null;
 *   - `runSqlFile`: run a migration file, optionally `SET ROLE`, and return its
 *     error code (rolled back on failure);
 *   - `asMigrationOwner`: hand the named tables and functions to a NOSUPERUSER,
 *     NOBYPASSRLS role, like the production migration owner (FORCE ROW LEVEL
 *     SECURITY applies to it), run `fn`, then hand them back;
 *   - `isDockerUnavailable` / `startPgEnvOrSkip` (first used by 0124, RT-1503):
 *     the MIGRATION_TEST_ALLOW_SKIP opt-in skips ONLY when no container
 *     runtime is reachable; every other setup failure is rethrown.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Pool, PoolClient } from "pg";

import { ensureAppRole, type PgTestEnv } from "./postgres-container";

export async function applyMigrationsBefore(env: PgTestEnv, drizzleDir: string, upName: string): Promise<void> {
  const files = readdirSync(drizzleDir)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(upName) < 0)
    .sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    await env.admin.query(readFileSync(resolve(drizzleDir, name), "utf8"));
  }
  await ensureAppRole(env);
}

export async function inRolledBackTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export async function asApp<T>(
  env: PgTestEnv,
  guc: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return inRolledBackTx(env.app, async (client) => {
    if (guc !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [guc]);
    return fn(client);
  });
}

export async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

export async function runSqlFile(env: PgTestEnv, path: string, role: string | null = null): Promise<string | null> {
  const client = await env.admin.connect();
  try {
    if (role !== null) await client.query(`SET ROLE ${role}`);
    return await errorCode(() => client.query(readFileSync(path, "utf8")));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    client.release();
  }
}

export interface MigrationOwner {
  readonly role: string;
  readonly tables: readonly string[];
  /** Function signatures, e.g. `my_trigger_fn()`. */
  readonly functions: readonly string[];
}

export async function asMigrationOwner<T>(env: PgTestEnv, owner: MigrationOwner, fn: () => Promise<T>): Promise<T> {
  const quietly = async (statements: readonly string[]): Promise<void> => {
    for (const sql of statements) await env.admin.query(sql).catch(() => undefined);
  };
  const superuser = (await env.admin.query<{ u: string }>(`SELECT current_user AS u`)).rows[0]!.u;
  await env.admin.query(`CREATE ROLE ${owner.role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await env.admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${owner.role}`);
  for (const table of owner.tables) await env.admin.query(`ALTER TABLE IF EXISTS ${table} OWNER TO ${owner.role}`);
  await quietly(owner.functions.map((f) => `ALTER FUNCTION ${f} OWNER TO ${owner.role}`));
  try {
    return await fn();
  } finally {
    await quietly([
      ...owner.tables.map((table) => `ALTER TABLE IF EXISTS ${table} OWNER TO ${superuser}`),
      ...owner.functions.map((f) => `ALTER FUNCTION ${f} OWNER TO ${superuser}`),
      `REVOKE ALL ON SCHEMA public FROM ${owner.role}`,
      `DROP ROLE ${owner.role}`,
    ]);
  }
}

/**
 * True only for Testcontainers' "no container runtime" error (testcontainers
 * 11.x, container-runtime/clients/client.js), raised before any container
 * exists. An image pull failure, a container start failure, a file error or
 * any other setup failure is not "Docker unavailable".
 */
export function isDockerUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Could not find a working container runtime strategy");
}

export type PgEnvStart =
  | { readonly env: PgTestEnv; readonly skipReason: null }
  | { readonly env: null; readonly skipReason: string };

/**
 * Start the test database. With `allowSkip` (MIGRATION_TEST_ALLOW_SKIP=1) a
 * missing container runtime becomes a skip reason; any other failure, and
 * every failure without the opt-in, is rethrown, so the opt-in can never turn
 * a real setup fault into a silent skip.
 */
export async function startPgEnvOrSkip(start: () => Promise<PgTestEnv>, allowSkip: boolean): Promise<PgEnvStart> {
  try {
    return { env: await start(), skipReason: null };
  } catch (err: unknown) {
    if (!allowSkip || !isDockerUnavailable(err)) throw err;
    return { env: null, skipReason: String(err) };
  }
}
