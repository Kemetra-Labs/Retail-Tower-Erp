/**
 * Worker database role posture check (RT-143).
 *
 * The worker's DATABASE_URL is the domain runtime role: tenant data is
 * reached only through `runWithTenantContext`, and FORCE RLS is the
 * boundary. A superuser or BYPASSRLS credential would silently disable
 * that boundary, so in production the worker refuses to start with one —
 * the same rule the API's `DatabasePoolBoundaryVerifier` enforces
 * (docs/operations/database-roles.md). `WorkerDatabaseRoleVerifier` in
 * worker.module.ts runs it at boot.
 */
import type { Pool } from "pg";

interface RoleRow {
  role_name: string;
  /** The login role. Differs from role_name after `options=-c role=…`. */
  session_role: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_mark_retention?: boolean;
}

export async function verifyWorkerDatabaseRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            session_user AS session_role,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls,
            (has_column_privilege('audit_events', 'retention_marked_at', 'UPDATE')
              -- has_column_privilege counts inherited privileges only; a
              -- NOINHERIT membership can still be reached through SET ROLE
              -- (unless granted WITH SET FALSE, PG16+). Refuse any membership.
              OR EXISTS (
                SELECT 1
                  FROM pg_roles g
                 WHERE g.oid <> r.oid
                   AND pg_has_role(current_user, g.oid, 'MEMBER')
                   AND has_column_privilege(g.oid, 'audit_events', 'retention_marked_at', 'UPDATE')
              )) AS can_mark_retention
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) throw new Error("WorkerModule: database role could not be resolved");
  // RT-357: a login that switched with `options=-c role=…` passes every check
  // below on current_user, while RESET ROLE restores its own privileges.
  if (role.session_role !== role.role_name) {
    throw new Error(
      "WorkerModule: DATABASE_URL role must log in as itself, not switch to it from another login",
    );
  }
  if (role.is_superuser || role.bypass_rls) {
    throw new Error(
      "WorkerModule: DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
  // RT-353: the API shares this role, and the retention decision record (§8)
  // keeps it INSERT-only on audit_events. Only the retention role may mark.
  if (role.can_mark_retention) {
    throw new Error(
      "WorkerModule: DATABASE_URL role must not hold UPDATE on audit_events.retention_marked_at; " +
        "only the AUDIT_RETENTION_DATABASE_URL role may mark retention (RT-353)",
    );
  }
}

/**
 * The database a connection reached: name and OID within the server, and the
 * server's start time, which tells two servers (say production and a staging
 * copy with the same roles) apart. All three are readable by any role. The
 * start time is compared as an epoch: its text form follows each session's
 * TimeZone and DateStyle.
 */
const DB_IDENTITY_COLUMNS = `current_database() AS db_name,
            (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())::text AS db_oid,
            extract(epoch FROM pg_postmaster_start_time())::text AS server_started`;

interface DbIdentity {
  db_name: string;
  db_oid: string;
  server_started: string;
}

interface RetentionLoginRow extends DbIdentity {
  role_name: string;
  session_role: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

interface RetentionGrantRow {
  can_select: boolean;
  can_mark: boolean;
  extra_privilege: boolean;
}

/**
 * The checks every dedicated worker role shares (RT-353, RT-1556): the URL logs
 * in as the role itself, is neither superuser nor BYPASSRLS, reaches the same
 * database as `DATABASE_URL`, and is a different role from it.
 */
async function assertDedicatedLogin(
  envName: string,
  rolePool: Pool,
  domainPool: Pool,
): Promise<void> {
  const login = (
    await rolePool.query<RetentionLoginRow>(
      `SELECT current_user AS role_name,
            session_user AS session_role,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls,
            ${DB_IDENTITY_COLUMNS}
       FROM pg_roles r
      WHERE r.rolname = current_user`,
    )
  ).rows[0];
  if (!login) {
    throw new Error(`WorkerModule: ${envName} role could not be resolved`);
  }
  // A URL can log in as a privileged role and switch with `options=-c role=…`:
  // current_user is then the dedicated role, but RESET ROLE restores the
  // login's own privileges. Every check is about current_user, so the login
  // itself must be the dedicated role.
  if (login.session_role !== login.role_name) {
    throw new Error(
      `WorkerModule: ${envName} role must log in as itself, not switch to it from another login`,
    );
  }
  if (login.is_superuser || login.bypass_rls) {
    throw new Error(
      `WorkerModule: ${envName} role must be non-superuser and must not have BYPASSRLS`,
    );
  }
  const domain = (
    await domainPool.query<DbIdentity & { role_name: string }>(
      `SELECT current_user AS role_name,
            ${DB_IDENTITY_COLUMNS}`,
    )
  ).rows[0];
  // A URL pointing at another migrated database (a staging copy has the same
  // role and grants) would pass every check below and act on the wrong rows.
  if (
    !domain ||
    domain.db_name !== login.db_name ||
    domain.db_oid !== login.db_oid ||
    domain.server_started !== login.server_started
  ) {
    throw new Error(`WorkerModule: ${envName} must connect to the same database as DATABASE_URL`);
  }
  if (domain.role_name === login.role_name) {
    throw new Error(`WorkerModule: ${envName} role must be a different role from DATABASE_URL`);
  }
}

/**
 * RT-353 — the audit retention role (`audit_retention_worker`, migration 0005)
 * must be a distinct, non-superuser, NOBYPASSRLS role holding exactly
 * `SELECT` and `UPDATE (retention_marked_at)` on `audit_events`, in the same
 * database as `DATABASE_URL`. The sweep reaches every tenant through the
 * platform-admin RLS branch, so the column grant is its only write boundary;
 * any other privilege on the table fails boot.
 */
export async function verifyAuditRetentionRole(
  retentionPool: Pool,
  domainPool: Pool,
): Promise<void> {
  await assertDedicatedLogin("AUDIT_RETENTION_DATABASE_URL", retentionPool, domainPool);
  const grants = (
    await retentionPool.query<RetentionGrantRow>(
      `SELECT has_table_privilege('audit_events', 'SELECT') AS can_select,
            has_column_privilege('audit_events', 'retention_marked_at', 'UPDATE') AS can_mark,
            (has_table_privilege('audit_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege('audit_events', 'INSERT, REFERENCES')
              OR EXISTS (
                SELECT 1
                  FROM pg_attribute a
                 WHERE a.attrelid = 'audit_events'::regclass
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                   AND a.attname <> 'retention_marked_at'
                   AND has_column_privilege('audit_events', a.attname, 'UPDATE')
              )
              -- MAINTAIN (PG17+) includes LOCK TABLE. PG16 rejects the name,
              -- and CASE keeps it from being evaluated there.
              OR CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN has_table_privilege('audit_events', 'MAINTAIN')
                      ELSE false END
              -- has_*_privilege counts inherited privileges only: a NOINHERIT
              -- membership can still reach more through SET ROLE (unless granted
              -- WITH SET FALSE, PG16+). As a conservative rule, the retention
              -- role may be a member of no role at all.
              OR EXISTS (
                SELECT 1
                  FROM pg_auth_members m
                  JOIN pg_roles r ON r.oid = m.member
                 WHERE r.rolname = current_user
              )) AS extra_privilege`,
    )
  ).rows[0];
  const missing = [
    ...(grants?.can_select ? [] : ["SELECT ON audit_events"]),
    ...(grants?.can_mark ? [] : ["UPDATE (retention_marked_at) ON audit_events"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `WorkerModule: AUDIT_RETENTION_DATABASE_URL role is missing required grants: ${missing.join(", ")}`,
    );
  }
  if (grants?.extra_privilege) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role may hold only SELECT and " +
        "UPDATE (retention_marked_at) on audit_events, and no role membership",
    );
  }
}

/**
 * RT-1556 — the exact table privileges the sync-failure alert role
 * (`docs/operations/sql/sync-failure-alert-role.sql`) may hold, as
 * [table, column | null, privilege]. `null` is a table-level privilege. Keep it
 * in step with the template and with the `alert_probe` set RT-1034 proved S13 on.
 */
export const SYNC_FAILURE_ALERT_ROLE_GRANTS: ReadonlyArray<
  readonly [string, string | null, string]
> = [
  ...[
    "tenants",
    "stores",
    "sales",
    "erpnext_posting_status",
    "memberships",
    "roles",
    "store_access",
  ].map((t) => [t, null, "SELECT"] as const),
  ["audit_events", null, "SELECT"],
  ["audit_events", null, "INSERT"],
  ...["sync_failure_alert_windows", "sync_failure_alert_deliveries"].flatMap((t) =>
    ["SELECT", "INSERT", "UPDATE"].map((p) => [t, null, p] as const),
  ),
  ["users", "id", "SELECT"],
  ["users", "email", "SELECT"],
  ["users", "deleted_at", "SELECT"],
];

interface HeldPrivilege {
  tbl: string;
  col: string | null;
  priv: string;
}

const privilegeKey = (tbl: string, col: string | null, priv: string): string =>
  `${priv} ON ${tbl}${col === null ? "" : ` (${col})`}`;

/** What the role lacks of the required grants, and what it holds beyond them. */
export function diffSyncFailureAlertGrants(held: readonly HeldPrivilege[]): {
  missing: string[];
  extra: string[];
} {
  const heldKeys = new Set(held.map((h) => privilegeKey(h.tbl, h.col, h.priv)));
  const required = new Set(SYNC_FAILURE_ALERT_ROLE_GRANTS.map(([t, c, p]) => privilegeKey(t, c, p)));
  return {
    missing: [...required].filter((k) => !heldKeys.has(k)).sort(),
    extra: [...heldKeys].filter((k) => !required.has(k)).sort(),
  };
}

/**
 * Every privilege `current_user` holds on a relation outside the system
 * schemas: table-level ones, column-level ones where the table-level one is
 * missing, and sequence ones. `has_*_privilege` counts inherited privileges
 * (and PUBLIC's) only; a NOINHERIT membership is refused separately.
 * MAINTAIN (PG17+) includes LOCK TABLE; PG16 rejects the name, so it is only in
 * the list from 17.
 */
const HELD_PRIVILEGES_SQL = `
  WITH privs(priv) AS (
    SELECT unnest(CASE WHEN current_setting('server_version_num')::int >= 170000
      THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
      ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END)
  ), rels AS (
    SELECT c.oid, c.relkind,
           CASE WHEN n.nspname = 'public' THEN c.relname
                ELSE n.nspname || '.' || c.relname END AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       -- A privilege in a schema the role cannot use is unreachable.
       AND has_schema_privilege(current_user, n.oid, 'USAGE')
       -- Extension objects (pg_stat_statements and the like grant SELECT to
       -- PUBLIC) are not the application's tables.
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  )
  SELECT r.tbl, NULL::text AS col, p.priv
    FROM rels r CROSS JOIN privs p
   WHERE r.relkind <> 'S' AND has_table_privilege(current_user, r.oid, p.priv)
  UNION ALL
  SELECT r.tbl, a.attname::text AS col, p.priv
    FROM rels r
    JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN privs p
   WHERE r.relkind <> 'S'
     AND p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
     AND NOT has_table_privilege(current_user, r.oid, p.priv)
     AND has_column_privilege(current_user, r.oid, a.attnum, p.priv)
  UNION ALL
  SELECT r.tbl, NULL::text AS col, s.priv
    FROM rels r CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS s(priv)
   WHERE r.relkind = 'S' AND has_sequence_privilege(current_user, r.oid, s.priv)`;

/**
 * RT-1556 — the sync-failure alert role (created from
 * `docs/operations/sql/sync-failure-alert-role.sql`) must be a distinct,
 * non-superuser, NOBYPASSRLS role, in the same database as `DATABASE_URL`,
 * holding exactly the privileges of SYNC_FAILURE_ALERT_ROLE_GRANTS: no write on
 * the posting, reconciliation or sale tables, no DELETE anywhere, and no role
 * membership.
 */
export async function verifySyncFailureAlertRole(alertPool: Pool, domainPool: Pool): Promise<void> {
  await assertDedicatedLogin("SYNC_FAILURE_ALERT_DATABASE_URL", alertPool, domainPool);
  const held = (await alertPool.query<HeldPrivilege>(HELD_PRIVILEGES_SQL)).rows;
  const { missing, extra } = diffSyncFailureAlertGrants(held);
  if (extra.length > 0) {
    throw new Error(
      "WorkerModule: SYNC_FAILURE_ALERT_DATABASE_URL role holds privileges beyond the " +
        `sync-failure alert grants: ${extra.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `WorkerModule: SYNC_FAILURE_ALERT_DATABASE_URL role is missing required grants: ${missing.join(", ")}`,
    );
  }
  const membership = (
    await alertPool.query<{ member_of_role: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname = current_user
       ) AS member_of_role`,
    )
  ).rows[0];
  // has_*_privilege counts inherited privileges only: a NOINHERIT membership can
  // still reach more through SET ROLE (unless granted WITH SET FALSE, PG16+).
  // As a conservative rule the alert role may be a member of no role at all.
  if (membership?.member_of_role) {
    throw new Error("WorkerModule: SYNC_FAILURE_ALERT_DATABASE_URL role must be a member of no role");
  }
}
