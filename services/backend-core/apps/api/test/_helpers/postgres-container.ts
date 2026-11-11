/**
 * Testcontainers helper for apps/api repo tests.
 *
 *   - Boots `postgres:16-alpine`
 *   - Applies the foundation migration from
 *     `packages/db/drizzle/0000_initial.sql` (the bytes the production
 *     runner ships)
 *   - Exposes an `admin` pool (DB superuser) for setup + RLS-bypassing
 *     metadata writes
 *   - Exposes an `app` pool connected as a non-superuser `app_test` role
 *     so tests that exercise RLS (e.g., AuthTokenRepository tenant
 *     isolation) hit the policies for real.
 *
 * RT-815: under Jest's globalSetup (`jest-global-setup.ts`) there is ONE
 * shared server per run, and `startPgEnv()` clones a fresh, fully migrated
 * database from its `rt_template` per spec file instead of booting a
 * container. `startPgEnv({ isolated: true })` keeps a private container for
 * specs that change cluster-wide state (roles) or need a container handle.
 * Without globalSetup (e.g. the worker package) it falls back to a private
 * container, exactly as before.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client, Pool } from "pg";

import type { GrantFragment } from "../../src/auth/grant-fragment";
import { GRANTS as USERS_COLUMNS } from "../../src/auth/grants/users-columns.grants";
import { GRANTS as VOUCHERS_GRANTS } from "../../src/auth/grants/vouchers.grants";
import { deviceActivity } from "../../src/pos-operators/device-activity";
import {
  cloneDatabase,
  dropDatabase,
  readSharedServer,
  SUPERUSER,
  SUPERUSER_PASSWORD,
  uriFor,
  type SharedServer,
} from "./pg-shared-server";

const DRIZZLE_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "drizzle",
);

export const UP_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.sql");
export const APP_ROLE_NAME = "app_test";
export const APP_ROLE_PASSWORD = "app_test";

export interface PgTestEnv {
  /** Private container; present only on an isolated or fallback env (RT-815). */
  container?: StartedPostgreSqlContainer;
  /** Pool connected as the database superuser (Testcontainers default). */
  admin: Pool;
  /** Pool connected as the non-superuser `app_test` role. */
  app: Pool;
  upSql: string;
  /** Connection URI for the superuser. */
  adminUri: string;
  host: string;
  port: number;
  /** This env's own database: a clone on the shared server, or `test`. */
  database: string;
  /** True when the database is a clone of the shared, already-migrated template. */
  cloned: boolean;
  /** Connection URI for `user` on this env's own database. */
  uriFor(user: string, password: string): string;
}

export type IsolatedPgTestEnv = PgTestEnv & { container: StartedPostgreSqlContainer };

export interface StartPgEnvOptions {
  /** Keep a private container even when a shared server exists (RT-815 §3.4). */
  isolated?: boolean;
}

function buildEnv(
  server: Pick<SharedServer, "host" | "port">,
  database: string,
  cloned: boolean,
  container?: StartedPostgreSqlContainer,
): PgTestEnv {
  const adminUri = uriFor(server, database, SUPERUSER, SUPERUSER_PASSWORD);
  return {
    ...(container ? { container } : {}),
    admin: guardPool(new Pool({ connectionString: adminUri })),
    app: guardPool(new Pool({ connectionString: uriFor(server, database, APP_ROLE_NAME, APP_ROLE_PASSWORD) })),
    upSql: readFileSync(UP_SQL_PATH, "utf8"),
    adminUri,
    host: server.host,
    port: server.port,
    database,
    cloned,
    uriFor: (user, password) => uriFor(server, database, user, password),
  };
}

async function startContainerEnv(): Promise<IsolatedPgTestEnv> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .start();
  const server = { host: container.getHost(), port: container.getMappedPort(5432) };
  return buildEnv(server, "test", false, container) as IsolatedPgTestEnv;
}

export function startPgEnv(opts: { isolated: true }): Promise<IsolatedPgTestEnv>;
export function startPgEnv(opts?: StartPgEnvOptions): Promise<PgTestEnv>;
export async function startPgEnv(opts: StartPgEnvOptions = {}): Promise<PgTestEnv> {
  const shared = opts.isolated ? null : readSharedServer();
  if (!shared) return startContainerEnv();
  const startedAt = Date.now();
  const database = await cloneDatabase(shared);
  if (process.env["RT_PG_TIMING"] === "1") {
    process.stderr.write(`[rt-815] cloned ${database} in ${Date.now() - startedAt} ms\n`);
  }
  return buildEnv(shared, database, true);
}

/**
 * RT-1249: give `role` the production column grants on `users` instead of its
 * table-level SELECT, INSERT and UPDATE: exactly the list in
 * src/auth/grants/users-columns.grants.ts, which a test keeps equal to
 * docs/operations/sql/users-columns-domain-grants.sql. `password_hash` is
 * then out of the domain role's reach, as in production, so every suite that
 * runs domain code on `app_test` through this helper proves it works without
 * it (a spec that grants `app_test` ALL TABLES itself re-opens it there). Revoking a
 * table-level privilege also revokes it on every column, so this is
 * idempotent. DELETE is left as it is (out of RT-1249's scope).
 */
export async function restrictDomainUsersColumns(admin: Pool, role: string): Promise<void> {
  await restrictDomainColumns(admin, role, USERS_COLUMNS, ["SELECT", "INSERT", "UPDATE"]);
}

/**
 * RT-1108: the same for `vouchers`. Production lets the domain role UPDATE only
 * `status`, `cancelled_at` and `cancelled_by_user_id` (src/auth/grants/
 * vouchers.grants.ts), so the test role loses its table-wide UPDATE and gets
 * exactly those columns: a runtime write to any other column fails here with
 * `permission denied`, as it would in production.
 */
export async function restrictDomainVouchersColumns(admin: Pool, role: string): Promise<void> {
  await restrictDomainColumns(admin, role, VOUCHERS_GRANTS, ["UPDATE"]);
}

/**
 * Replace `role`'s table-level `revoked` privileges on every table a fragment
 * names in `domainRequiredColumns` with the fragment's column grants. Revoking a
 * table-level privilege also revokes it on every column, so this is idempotent.
 */
async function restrictDomainColumns(
  admin: Pool,
  role: string,
  fragment: GrantFragment,
  revoked: readonly string[],
): Promise<void> {
  const byTable = new Map<string, Map<string, string[]>>();
  for (const [table, column, privilege] of fragment.domainRequiredColumns ?? []) {
    const byPrivilege = byTable.get(table) ?? new Map<string, string[]>();
    byPrivilege.set(privilege, [...(byPrivilege.get(privilege) ?? []), column]);
    byTable.set(table, byPrivilege);
  }
  // Identifiers come from the validated fragments (lowercase [a-z_][a-z0-9_]*).
  const statements: string[] = [];
  for (const [table, byPrivilege] of byTable) {
    statements.push(`REVOKE ${revoked.join(", ")} ON ${table} FROM ${role}`);
    for (const [privilege, columns] of byPrivilege) {
      statements.push(`GRANT ${privilege} (${columns.join(", ")}) ON ${table} TO ${role}`);
    }
  }
  await admin.query(statements.join(";\n"));
}

/**
 * Apply UP migration via the admin pool, then create the non-superuser
 * `app_test` role and grant it the privileges a real backend would have.
 */
export async function applyUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(env.upSql);
  await env.admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
        CREATE ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await env.admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
  await env.admin.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await env.admin.query(`
    GRANT USAGE, SELECT
    ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await restrictDomainUsersColumns(env.admin, APP_ROLE_NAME);
}

/**
 * SQLSTATEs Postgres sends when it terminates a backend on shutdown:
 * 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
 */
const SHUTDOWN_SQLSTATES = new Set(["57P01", "57P02", "57P03"]);

/**
 * True for errors a pooled client can receive because the test container is
 * shutting down: a server FATAL with a shutdown SQLSTATE, or pg's own
 * "Connection terminated" when the socket closes under it.
 */
export function isShutdownError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && SHUTDOWN_SQLSTATES.has(code)) return true;
  return /^Connection terminated( unexpectedly)?$/.test(err.message);
}

/**
 * Pool 'error' listener for test pools. pg-pool re-emits an idle client's
 * error on the pool, and with no listener Node throws "Unhandled error.",
 * which Jest pins on whichever suite is running. Shutdown errors are expected
 * during teardown and are dropped; anything else is rethrown so a real fault
 * still fails loudly.
 */
export function ignoreShutdownErrors(err: Error): void {
  if (isShutdownError(err)) return;
  throw err;
}

/** Idempotently attach `ignoreShutdownErrors` to a pool. */
export function guardPool(pool: Pool): Pool {
  if (!pool.listeners("error").includes(ignoreShutdownErrors)) {
    pool.on("error", ignoreShutdownErrors);
  }
  return pool;
}

/**
 * End a pool whose server is about to be stopped. pg-pool resolves end()
 * before closing clients finish their Terminate, so a container stop right
 * after can hand one of them FATAL 57P01, which the pool re-emits as 'error'.
 */
export async function endPoolQuietly(pool: Pool): Promise<void> {
  guardPool(pool);
  await pool.end().catch(() => undefined);
}

/**
 * Wait until the server has no client backends besides this probe's own.
 *
 * `Pool.end()` resolves before its sockets close, so a pool a spec ended in
 * its own afterAll (which carries no 'error' listener) can still hold a live
 * backend when the container is stopped; Postgres then sends that client
 * FATAL 57P01 and the pool throws "Unhandled error." Waiting for those
 * backends to exit closes the race for every pool on the server, not just
 * the two this env owns. Uses a standalone Client because `Client.end()`,
 * unlike `Pool.end()`, resolves only once its socket has closed. Bounded, so
 * a leaked (never-ended) pool costs `timeoutMs` and a warning naming the open
 * connections, rather than hanging the suite.
 */
async function waitForOtherBackendsToExit(uri: string, database: string, timeoutMs = 5000): Promise<void> {
  const probe = new Client({ connectionString: uri });
  probe.on("error", ignoreShutdownErrors);
  try {
    await probe.connect();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Scoped to this env's database: on the shared server (RT-815) other
      // workers' databases have live backends that are not ours to wait for.
      const { rows } = await probe.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND datname = $1`,
        [database],
      );
      if (rows[0]?.n === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    const { rows: left } = await probe.query(
      `SELECT usename, state, left(query, 80) AS query FROM pg_stat_activity
       WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND datname = $1`,
      [database],
    );
    // eslint-disable-next-line no-console
    console.warn(
      `stopPgEnv: ${left.length} connection(s) still open after ${timeoutMs}ms; ` +
        `a pool/client was not ended before teardown`,
      left,
    );
  } finally {
    await probe.end().catch(() => undefined);
  }
}

export async function stopPgEnv(env: PgTestEnv): Promise<void> {
  // RT-370: let in-flight device activity writes finish before the pools end.
  await deviceActivity.flush();
  await endPoolQuietly(env.app);
  await endPoolQuietly(env.admin);
  await waitForOtherBackendsToExit(env.adminUri, env.database).catch(() => undefined);
  if (env.container) {
    await env.container.stop().catch(() => undefined);
    return;
  }
  const shared = readSharedServer();
  if (shared) await dropDatabase(shared, env.database).catch(() => undefined);
}

/**
 * Apply every UP migration in lex order (matches the production runner's
 * file walk in `packages/db/src/cli/migrate.ts`). Used by tests that
 * need the *full* schema across migrations — e.g. POS operator sign-in,
 * which depends on `users.clerk_user_id`, `devices`, and the scope-aware
 * `auth_tokens` CHECK shipped in `0001_pos_operator_identity.sql`.
 *
 * The single-file `applyUpAndCreateAppRole` (0000 only) has no api callers
 * today; it only works on a private (isolated/fallback) env, never a clone.
 */
export async function applyAllUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  // A clone already carries every migration, the role and the grants: the
  // shared template was built by `applyAllMigrationsAndAppRole` (RT-815).
  if (env.cloned) return;
  await applyAllMigrationsAndAppRole(env.admin);
}

/** Every UP migration in lex order + the `app_test` role and its grants. */
export async function applyAllMigrationsAndAppRole(admin: Pool): Promise<void> {
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of upFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await admin.query(sql);
  }
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
        CREATE ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
  await admin.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await admin.query(`
    GRANT USAGE, SELECT
    ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await restrictDomainUsersColumns(admin, APP_ROLE_NAME);
  await restrictDomainVouchersColumns(admin, APP_ROLE_NAME);
}
