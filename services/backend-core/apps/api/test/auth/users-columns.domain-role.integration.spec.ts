/**
 * RT-1249 (RT-147 probe 5) — the domain role reaches `users` only through the
 * column grants of docs/operations/sql/users-columns-domain-grants.sql, which
 * the test harness gives `app_test` (postgres-container.ts). This spec proves,
 * on real PostgreSQL:
 *   - the probe-5 query reads f for every password_hash privilege of the
 *     domain role, and t for every granted column;
 *   - the domain role cannot read, write or insert a password hash;
 *   - the invitation paths that run on the domain role (RT-937) still work:
 *     the existing-user lookup and the new-user insert, which leaves
 *     password_hash NULL.
 * Every other domain suite runs on the same `app_test` role, so a domain read
 * of a column outside the grant list fails there too.
 */
import type { Pool, PoolClient } from "pg";

import { InvitationsRepository } from "../../src/memberships/invitations.repository";
import { GRANTS as USERS_COLUMNS } from "../../src/auth/grants/users-columns.grants";
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const EXISTING_USER = "0193c249-0000-7000-8000-000000000001";
const NEW_USER = "0193c249-0000-7000-8000-000000000002";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, 'existing@rt1249.test', 'Existing', 'not-a-real-hash')`,
      [EXISTING_USER],
    );
  } catch (error) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      return;
    }
    throw error;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

async function onApp<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function columnPrivilege(column: string, privilege: string): Promise<boolean> {
  const { rows } = await env!.admin.query<{ ok: boolean }>(
    `SELECT has_column_privilege($1, 'users', $2, $3) AS ok`,
    [APP_ROLE_NAME, column, privilege],
  );
  return rows[0]!.ok;
}

describe("RT-1249: the domain role and users.password_hash", () => {
  it("probe 5: the domain role holds no SELECT, INSERT or UPDATE on password_hash", async () => {
    if (dockerSkipped) return;
    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      expect({ privilege, held: await columnPrivilege("password_hash", privilege) }).toEqual({ privilege, held: false });
    }
  });

  it("holds exactly the granted columns, and no UPDATE on any users column", async () => {
    if (dockerSkipped) return;
    for (const [, column, privilege] of USERS_COLUMNS.domainRequiredColumns ?? []) {
      expect({ column, privilege, held: await columnPrivilege(column, privilege) }).toEqual({ column, privilege, held: true });
    }
    const { rows } = await env!.admin.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_attribute a
        WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege($1, 'public.users'::regclass, a.attname, 'UPDATE')`,
      [APP_ROLE_NAME],
    );
    expect(rows).toEqual([]);
  });

  it("refuses to read, overwrite or insert a password hash on the domain role", async () => {
    if (dockerSkipped) return;
    const { app } = env!;
    await expect(app.query("SELECT password_hash FROM users WHERE id = $1", [EXISTING_USER])).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.query("SELECT * FROM users LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(
      app.query("UPDATE users SET password_hash = 'attacker' WHERE id = $1", [EXISTING_USER]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      app.query(
        "INSERT INTO users (id, email, password_hash) VALUES ('0193c249-0000-7000-8000-0000000000ff', 'x@rt1249.test', 'attacker')",
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("reads the granted columns on the domain role", async () => {
    if (dockerSkipped) return;
    const { rows } = await env!.app.query<{ email: string; display_name: string; is_platform_admin: boolean }>(
      `SELECT id, email, display_name, is_platform_admin FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [EXISTING_USER],
    );
    expect(rows).toEqual([
      { id: EXISTING_USER, email: "existing@rt1249.test", display_name: "Existing", is_platform_admin: false },
    ]);
  });

  it("RT-937 paths on the domain role: find an existing user, insert a new one with no password hash", async () => {
    if (dockerSkipped) return;
    const repo = new InvitationsRepository();
    const found = await onApp(env!.app, (client) => repo.findUserByEmail(client, "existing@rt1249.test"));
    expect(found).toEqual({ id: EXISTING_USER, email: "existing@rt1249.test", displayName: "Existing" });

    await onApp(env!.app, (client) =>
      repo.insertUser(client, { id: NEW_USER, email: "new@rt1249.test", displayName: "New" }),
    );
    const { rows } = await env!.admin.query(
      `SELECT email, display_name, password_hash, email_verified_at IS NOT NULL AS verified, is_platform_admin
         FROM users WHERE id = $1`,
      [NEW_USER],
    );
    expect(rows).toEqual([
      { email: "new@rt1249.test", display_name: "New", password_hash: null, verified: true, is_platform_admin: false },
    ]);

    // A duplicate email is still a unique violation (the caller's 409), not a permission error.
    await expect(
      onApp(env!.app, (client) =>
        repo.insertUser(client, { id: "0193c249-0000-7000-8000-000000000003", email: "new@rt1249.test", displayName: "Dup" }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
