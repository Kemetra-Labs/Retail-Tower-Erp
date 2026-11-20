import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, PG_POOL } from "../database";
import type { DomainColumnGrant } from "./grant-fragment";
import { GRANT_REGISTRY } from "./grant-registry";

interface RoleRow {
  role_name: string;
  /** The login role. Differs from role_name after `options=-c role=…`. */
  session_role: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

async function readRole(pool: Pool): Promise<RoleRow> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            session_user AS session_role,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) throw new Error("database pool role could not be resolved");
  return role;
}

/**
 * RT-143: the lookup role has BYPASSRLS, so its TABLE GRANTS are its whole
 * privilege boundary (docs/operations/database-roles.md). Each entry is one
 * privilege the auth boundary needs; boot fails if any is missing.
 */
export const AUTH_LOOKUP_REQUIRED_GRANTS: ReadonlyArray<readonly [string, string]> = [
  ["users", "SELECT"],
  ["users", "UPDATE"],
  ["sessions", "SELECT"],
  ["sessions", "INSERT"],
  ["sessions", "UPDATE"],
  ["auth_tokens", "SELECT"],
  ["auth_tokens", "INSERT"],
  ["auth_tokens", "UPDATE"],
  ["devices", "SELECT"],
  ["stores", "SELECT"],
  ["external_identity_links", "SELECT"],
  ["connector_registration", "SELECT"],
  ["pairing_codes", "SELECT"],
];

/**
 * Tables the lookup role must hold NO listed privilege on, and the grants the
 * domain (DATABASE_URL) role must hold (RT-212). Runtime grants are provisioned
 * outside migrations, so a deploy that skips a grant step would otherwise boot
 * healthy while the affected routes return 500. Both lists are assembled from
 * one fragment per feature in ./grants/ (RT-812, grant-registry.ts): add a
 * fragment there when a migration adds a table the domain role must use or
 * the lookup role must not touch. Boot fails if any listed grant is missing
 * (domain) or held (lookup).
 */
export const AUTH_LOOKUP_FORBIDDEN_GRANTS: ReadonlyArray<readonly [string, string]> =
  GRANT_REGISTRY.lookupForbidden;
export const DOMAIN_REQUIRED_GRANTS: ReadonlyArray<readonly [string, string]> =
  GRANT_REGISTRY.domainRequired;

/**
 * RT-1249: column privileges the domain role must hold, for tables it reaches
 * only column by column (`users`). Assembled from the fragments' optional
 * `domainRequiredColumns` (grants/users-columns.grants.ts).
 */
export const DOMAIN_REQUIRED_COLUMN_GRANTS: ReadonlyArray<DomainColumnGrant> =
  GRANT_REGISTRY.domainRequiredColumns;

/**
 * RT-1249 (RT-147 probe 5): [table, column, comma-separated privileges] the
 * domain role must hold none of. `users` has no RLS, so a domain role that can
 * read or write `password_hash` reaches every tenant's password hashes; only
 * the auth lookup role may (sign-in, rehash, reset). A table-level grant, a
 * grant to PUBLIC, an inherited role and a role the domain role can SET ROLE
 * to all count. A fixed security invariant, not a per-feature fragment.
 */
export const DOMAIN_FORBIDDEN_COLUMN_GRANTS: ReadonlyArray<
  readonly [table: string, column: string, privileges: string]
> = [["users", "password_hash", "SELECT, INSERT, UPDATE"]];

interface GrantRow {
  table_name: string;
  privilege: string;
  granted: boolean;
}

/**
 * `has_table_privilege` for each (table, privilege-list) pair; a list is
 * true when ANY listed privilege is held. Tables that do not exist yet are
 * reported as not granted (a required one then fails, a forbidden one passes).
 */
async function readGrants(
  pool: Pool,
  checks: ReadonlyArray<readonly [string, string]>,
): Promise<GrantRow[]> {
  const result = await pool.query<GrantRow>(
    `SELECT t.table_name, t.privilege,
            CASE WHEN to_regclass('public.' || t.table_name) IS NULL THEN false
                 ELSE has_table_privilege(current_user,
                        to_regclass('public.' || t.table_name), t.privilege)
            END AS granted
       FROM unnest($1::text[], $2::text[]) AS t(table_name, privilege)`,
    [checks.map(([table]) => table), checks.map(([, privilege]) => privilege)],
  );
  return result.rows;
}

interface ColumnGrantRow extends GrantRow {
  column_name: string;
  /** False when the table or column does not exist. */
  column_exists: boolean;
}

/**
 * RT-1249: `has_column_privilege` for each (table, column, privilege), in the
 * given order. A missing table or column reads as not granted. With
 * `viaMembership`, a privilege held by any role the checked role is a member
 * of also counts, even without INHERIT: `has_column_privilege` sees inherited
 * privileges only, while SET ROLE reaches every membership (unless granted
 * WITH SET FALSE, PG16+). The worker's retention check uses the same rule.
 */
async function readColumnGrants(
  pool: Pool,
  checks: ReadonlyArray<DomainColumnGrant>,
  viaMembership: boolean,
): Promise<ColumnGrantRow[]> {
  const result = await pool.query<ColumnGrantRow>(
    `SELECT t.table_name, t.column_name, t.privilege,
            CASE WHEN a.attnum IS NULL THEN false
                 ELSE has_column_privilege(current_user, a.attrelid, a.attnum, t.privilege)
                      OR ($4::boolean AND EXISTS (
                        SELECT 1 FROM pg_roles g
                         WHERE g.rolname <> current_user
                           AND pg_has_role(current_user, g.oid, 'MEMBER')
                           AND has_column_privilege(g.oid, a.attrelid, a.attnum, t.privilege)))
            END AS granted,
            a.attnum IS NOT NULL AS column_exists
       FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY
              AS t(table_name, column_name, privilege, ord)
       LEFT JOIN pg_attribute a
              ON a.attrelid = to_regclass('public.' || t.table_name)
             AND a.attname = t.column_name AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY t.ord`,
    [
      checks.map(([table]) => table),
      checks.map(([, column]) => column),
      checks.map(([, , privilege]) => privilege),
      viaMembership,
    ],
  );
  return result.rows;
}

/** The privileges a column can hold; the rest of a forbidden entry's list is table-only. */
const COLUMN_LEVEL_PRIVILEGES: ReadonlySet<string> = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);

/**
 * RT-1520: the columns, per table, that carry any column ACL entry. A privilege
 * held only on some columns of a table appears in `pg_attribute.attacl` (a
 * table-level one lives in `pg_class.relacl` and is caught by readGrants), so
 * a column with no ACL entry need not be probed. Tables that do not exist yield
 * no rows. (The SQL avoids has_*_privilege: it only lists candidates.)
 */
async function readColumnsWithAcl(pool: Pool, tables: readonly string[]): Promise<Map<string, string[]>> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT t.table_name, a.attname AS column_name
       FROM unnest($1::text[]) AS t(table_name)
       JOIN pg_attribute a
         ON a.attrelid = to_regclass('public.' || t.table_name)
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      ORDER BY t.table_name, a.attnum`,
    [tables],
  );
  const columns = new Map<string, string[]>();
  for (const { table_name, column_name } of result.rows) {
    columns.set(table_name, [...(columns.get(table_name) ?? []), column_name]);
  }
  return columns;
}

/**
 * RT-1520: column-level privileges (SELECT, INSERT, UPDATE, REFERENCES) the
 * pool's role holds on the tables of `forbidden`, limited to the privileges each
 * entry lists. `has_table_privilege` ignores column grants, and a BYPASSRLS
 * role with `GRANT SELECT (cells) ON catalog_import_rows` reads that column for
 * every tenant. Same check as readColumnGrants (via a column list), same
 * inherited-privilege semantics as readGrants.
 */
async function readForbiddenColumnGrants(
  pool: Pool,
  forbidden: ReadonlyArray<readonly [string, string]>,
): Promise<ColumnGrantRow[]> {
  const privilegesByTable = new Map<string, Set<string>>();
  for (const [table, privileges] of forbidden) {
    const held = privilegesByTable.get(table) ?? new Set<string>();
    for (const p of privileges.split(",").map((x) => x.trim())) {
      if (COLUMN_LEVEL_PRIVILEGES.has(p)) held.add(p);
    }
    privilegesByTable.set(table, held);
  }
  const columns = await readColumnsWithAcl(pool, [...privilegesByTable.keys()]);
  const checks: DomainColumnGrant[] = [...privilegesByTable].flatMap(([table, privileges]) =>
    (columns.get(table) ?? []).flatMap((column) => [...privileges].map((p) => [table, column, p] as const)),
  );
  if (checks.length === 0) return [];
  return (await readColumnGrants(pool, checks, false)).filter((g) => g.granted);
}

function formatGrants(grants: ReadonlyArray<GrantRow | ColumnGrantRow>): string {
  return grants
    .map((g) => ("column_name" in g ? `${g.privilege} ON ${g.table_name}(${g.column_name})` : `${g.privilege} ON ${g.table_name}`))
    .join(", ");
}

/** One [table, column, privilege] check per privilege of each forbidden entry, in order. */
function forbiddenColumnChecks(): DomainColumnGrant[] {
  return DOMAIN_FORBIDDEN_COLUMN_GRANTS.flatMap(([table, column, privileges]) =>
    privileges.split(",").map((privilege) => [table, column, privilege.trim()] as const),
  );
}

async function assertDomainGrants(domainPool: Pool): Promise<void> {
  const [required, requiredColumns] = await Promise.all([
    readGrants(domainPool, DOMAIN_REQUIRED_GRANTS),
    readColumnGrants(domainPool, DOMAIN_REQUIRED_COLUMN_GRANTS, false),
  ]);
  const missing = [...required, ...requiredColumns].filter((g) => !g.granted);
  if (missing.length > 0) {
    throw new Error(
      "AuthModule: DATABASE_URL role is missing required grants: " +
        formatGrants(missing) +
        " (see docs/operations/database-roles.md)",
    );
  }
}

/**
 * RT-1249: the domain role must not reach users.password_hash in any way.
 * Fails closed when a forbidden column is missing: a rename would otherwise
 * leave the new name unguarded while this check passed.
 */
async function assertDomainForbiddenColumns(domainPool: Pool): Promise<void> {
  const rows = await readColumnGrants(domainPool, forbiddenColumnChecks(), true);
  const absent = rows.filter((g) => !g.column_exists);
  if (absent.length > 0) {
    throw new Error(
      "AuthModule: forbidden column not found, so the domain role's access to it cannot be checked: " +
        [...new Set(absent.map((g) => `${g.table_name}(${g.column_name})`))].join(", ") +
        " (update DOMAIN_FORBIDDEN_COLUMN_GRANTS with the schema; RT-1249)",
    );
  }
  const held = rows.filter((g) => g.granted);
  if (held.length > 0) {
    throw new Error(
      "AuthModule: DATABASE_URL role holds forbidden column grants: " +
        formatGrants(held) +
        "; only the AUTH_LOOKUP_DATABASE_URL role may read or write password hashes" +
        " (RT-1249, see docs/operations/database-roles.md)",
    );
  }
}

async function assertLookupGrants(lookupPool: Pool): Promise<void> {
  const [required, forbidden, forbiddenColumns] = await Promise.all([
    readGrants(lookupPool, AUTH_LOOKUP_REQUIRED_GRANTS),
    readGrants(lookupPool, AUTH_LOOKUP_FORBIDDEN_GRANTS),
    readForbiddenColumnGrants(lookupPool, AUTH_LOOKUP_FORBIDDEN_GRANTS),
  ]);
  const missing = required.filter((g) => !g.granted);
  if (missing.length > 0) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role is missing required grants: " +
        formatGrants(missing) +
        " (see docs/operations/database-roles.md)",
    );
  }
  const excess = forbidden.filter((g) => g.granted);
  if (excess.length > 0) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role holds forbidden grants on: " +
        excess.map((g) => g.table_name).join(", ") +
        " (see docs/operations/database-roles.md)",
    );
  }
  // RT-1520: a column-only grant passes the table check above.
  if (forbiddenColumns.length > 0) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role holds forbidden column grants: " +
        formatGrants(forbiddenColumns) +
        "; the role has BYPASSRLS, so a column privilege on these tables reaches every tenant's rows" +
        " (RT-1520, see docs/operations/database-roles.md)",
    );
  }
}

/**
 * RT-357: a URL can log in as a privileged role and switch with
 * `options=-c role=…`. current_user then passes every posture and grant check
 * below, while RESET ROLE restores the login's own privileges (a superuser,
 * BYPASSRLS, the migration owner). The login itself must be the checked role.
 */
function assertLogsInAsItself(role: RoleRow, variable: string): void {
  if (role.session_role !== role.role_name) {
    throw new Error(
      `AuthModule: ${variable} role must log in as itself, not switch to it from another login`,
    );
  }
}

/** Exported for Testcontainers proof of the production role boundary. */
export async function verifyDatabasePoolBoundary(
  domainPool: Pool,
  lookupPool: Pool,
): Promise<void> {
  const [domainRole, lookupRole] = await Promise.all([
    readRole(domainPool),
    readRole(lookupPool),
  ]);

  assertLogsInAsItself(domainRole, "DATABASE_URL");
  assertLogsInAsItself(lookupRole, "AUTH_LOOKUP_DATABASE_URL");
  assertDomainRole(domainRole);
  assertLookupRole(lookupRole, domainRole.role_name);
  await assertDomainGrants(domainPool);
  await assertDomainForbiddenColumns(domainPool);
  await assertLookupGrants(lookupPool);
}

function assertDomainRole(domainRole: RoleRow): void {
  if (domainRole.is_superuser || domainRole.bypass_rls) {
    throw new Error(
      "AuthModule: DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
}

function assertLookupRole(lookupRole: RoleRow, domainRoleName: string): void {
  if (lookupRole.is_superuser) {
    throw new Error("AuthModule: AUTH_LOOKUP_DATABASE_URL role must not be a superuser");
  }
  if (!lookupRole.bypass_rls) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL role must have BYPASSRLS for pre-tenant lookups",
    );
  }
  if (domainRoleName === lookupRole.role_name) {
    throw new Error(
      "AuthModule: domain and pre-tenant lookup pools must use distinct database roles",
    );
  }
}

@Injectable()
export class DatabasePoolBoundaryVerifier implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      process.env["NODE_ENV"] === "production" ||
      process.env["VERIFY_DATABASE_POOL_BOUNDARY"] === "1"
    ) {
      await verifyDatabasePoolBoundary(this.domainPool, this.lookupPool);
    }
  }
}
