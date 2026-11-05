import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";

import { InstrumentedPool } from "../observability/instrumented-pool";
import type { DomainColumnGrant } from "./grant-fragment";
import { GRANT_REGISTRY } from "./grant-registry";

export const PG_POOL = "PG_POOL";
export const AUTH_LOOKUP_POOL = "AUTH_LOOKUP_POOL";

const ownedPools = new WeakSet<Pool>();

function createOwnedPool(connectionString: string): Pool {
  const pool = new InstrumentedPool({ connectionString });
  ownedPools.add(pool);
  return pool;
}

export function domainPoolFactory(): Pool {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("AuthModule: DATABASE_URL is not set; cannot create domain pg.Pool");
  }
  return createOwnedPool(url);
}

/**
 * Pre-tenant identity/token/device lookup pool.
 *
 * Production must provide a distinct credential. Tests and local development
 * may deliberately reuse an injected PG_POOL so hermetic module tests do not
 * need a second database user. That fallback is never available in production.
 */
export function authLookupPoolFactory(domainPool: Pool): Pool {
  const lookupUrl = process.env["AUTH_LOOKUP_DATABASE_URL"];
  if (!lookupUrl) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "AuthModule: AUTH_LOOKUP_DATABASE_URL is required in production; " +
          "pre-tenant lookups must not reuse the domain pool",
      );
    }
    return domainPool;
  }

  const domainUrl = process.env["DATABASE_URL"];
  if (process.env["NODE_ENV"] === "production" && lookupUrl === domainUrl) {
    throw new Error(
      "AuthModule: AUTH_LOOKUP_DATABASE_URL must use credentials distinct from DATABASE_URL",
    );
  }
  return createOwnedPool(lookupUrl);
}

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
  const [required, forbidden] = await Promise.all([
    readGrants(lookupPool, AUTH_LOOKUP_REQUIRED_GRANTS),
    readGrants(lookupPool, AUTH_LOOKUP_FORBIDDEN_GRANTS),
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

/** Close only pools created by this module; never close test-supplied pools. */
@Injectable()
export class DatabasePoolLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly domainPool: Pool,
    @Inject(AUTH_LOOKUP_POOL) private readonly lookupPool: Pool,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const pools = new Set([this.domainPool, this.lookupPool]);
    await Promise.all(
      [...pools]
        .filter((pool) => ownedPools.has(pool))
        .map((pool) => pool.end()),
    );
  }
}
