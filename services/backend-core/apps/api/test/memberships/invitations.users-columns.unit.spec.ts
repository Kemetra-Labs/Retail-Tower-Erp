/**
 * RT-1249 — the invitation paths run on the domain role, which holds only
 * column grants on `users` (docs/operations/sql/users-columns-domain-grants.sql):
 * SELECT (id, email, display_name, is_platform_admin, deleted_at) and
 * INSERT (id, email, display_name, email_verified_at). PostgreSQL checks a
 * privilege for every column a statement names, including a column whose
 * value is DEFAULT, so these tests pin the exact column lists the SQL names.
 *
 * Unlike invitations.repository.unit.spec.ts this does NOT mock drizzle: the
 * real query builder renders the SQL, and a fake client records it.
 */
import type { PoolClient } from "pg";

import { InvitationsRepository } from "../../src/memberships/invitations.repository";
import { GRANTS as USERS_COLUMNS } from "../../src/auth/grants/users-columns.grants";

interface Recorded {
  readonly text: string;
}

function recordingClient(rows: unknown[] = []): { client: PoolClient; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const query = jest.fn(async (input: string | { text: string }) => {
    queries.push({ text: typeof input === "string" ? input : input.text });
    return { rows, rowCount: rows.length, fields: [], command: "", oid: 0 };
  });
  return { client: { query } as unknown as PoolClient, queries };
}

/** The quoted or bare column names a statement mentions. */
function columnsIn(sql: string): string[] {
  const known = [
    "id",
    "email",
    "email_verified_at",
    "password_hash",
    "display_name",
    "is_platform_admin",
    "clerk_user_id",
    "created_at",
    "updated_at",
    "deleted_at",
  ];
  return known.filter((c) => new RegExp(`(^|[^a-z_])"?${c}"?([^a-z_]|$)`).test(sql));
}

const granted = (privilege: string): string[] =>
  (USERS_COLUMNS.domainRequiredColumns ?? [])
    .filter(([table, , p]) => table === "users" && p === privilege)
    .map(([, column]) => column)
    .sort();

describe("RT-1249: invitation SQL names only the users columns the domain role holds", () => {
  it("findUserByEmail selects id, email and display_name, never password_hash", async () => {
    const { client, queries } = recordingClient();
    await new InvitationsRepository().findUserByEmail(client, "invitee@example.test");

    expect(queries).toHaveLength(1);
    const sql = queries[0]!.text;
    expect(sql).not.toMatch(/password_hash/);
    expect(columnsIn(sql).sort()).toEqual(["deleted_at", "display_name", "email", "id"]);
    for (const column of columnsIn(sql)) expect(granted("SELECT")).toContain(column);
  });

  it("insertUser names exactly the granted INSERT columns, never password_hash", async () => {
    const { client, queries } = recordingClient();
    await new InvitationsRepository().insertUser(client, {
      id: "0193c000-0000-7000-8000-000000000003",
      email: "invitee@example.test",
      displayName: "Invitee",
    });

    expect(queries).toHaveLength(1);
    const sql = queries[0]!.text;
    expect(sql).toMatch(/^\s*INSERT INTO users\b/i);
    expect(sql).not.toMatch(/password_hash|is_platform_admin|clerk_user_id/);
    expect(columnsIn(sql).sort()).toEqual(granted("INSERT"));
  });

  it("the INSERT column list is exactly the new-user fields", () => {
    expect(granted("INSERT")).toEqual(["display_name", "email", "email_verified_at", "id"]);
  });
});
