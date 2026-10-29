#!/usr/bin/env node
/**
 * Backend-Core P-0 preprod PILOT BOOTSTRAP seed.
 *
 * One-shot, idempotent seed that mints the minimal identity state the first
 * POS live-leg smoke needs in an EMPTY preprod database (tenants/users/stores
 * all zero after deploy — migrations create schema only, no data).
 *
 * WHAT THIS SEEDS (static DB rows; mirrors `TenantsService.createTenant` +
 * the operator-sign-in preconditions in `PosOperatorsService.signIn`):
 *   1. tenants                — the pilot tenant (the binding `tenant_id`).
 *   2. roles (× 4)            — default tenant-scoped roles
 *                               (owner / tenant_admin / store_manager / store_staff),
 *                               byte-identical to `seedDefaultRoles`.
 *   3. stores                 — the pilot store (the binding `store_id`).
 *   4. users                  — the OPERATOR's local user (the bridge column
 *                               also carries the provider subject until RT-799
 *                               drops it).
 *   4b. external_identity_links — the operator's ACTIVE identity link
 *                               (OPERATOR_PROVIDER_KEY, OPERATOR_PROVIDER_ISSUER,
 *                               OPERATOR_PROVIDER_SUBJECT). Operator sign-in
 *                               resolves the user through this row (RT-796).
 *   5. memberships            — the operator's membership in the pilot tenant,
 *                               role = `store_manager` (an ELIGIBLE internal role
 *                               that maps to POS role `manager`; `store_staff`
 *                               maps to null and is REJECTED at sign-in), with
 *                               `store_access_kind = 'all'` so no per-store
 *                               `store_access` row is required.
 *
 * WHAT THIS DOES **NOT** DO (intentionally — out of scope for a static seed):
 *   - Mint the provider identity. The operator's user must already exist at the
 *     identity provider; its provider key, issuer and subject are the REQUIRED
 *     inputs here (OPERATOR_PROVIDER_KEY / _ISSUER / _SUBJECT). Owner work in
 *     the provider's dashboard.
 *   - Pair a terminal / create a `device` row. Pairing is the unauthenticated
 *     runtime bootstrap (POS-010 read-down's device token) — not a seed row.
 *   - Issue the `pos_operator` `auth_tokens` session token. That is the OUTPUT
 *     of the operator sign-in exchange at runtime (`PosOperatorsService.signIn`
 *     step 7) — never a static row.
 *   - Seed the catalog. Catalog rows are the SEPARATE `seed-catalog.ts` slice
 *     (golden-catalog-seed decisions) and run under the same pilot tenant/store.
 *   - Create a platform admin. `createTenant`'s platform-admin gate is the HTTP
 *     API path, which this direct seed bypasses; neither POS smoke needs one.
 *     (If future Console manageability needs a platform admin, that is a
 *     separate, explicit decision — set BOOTSTRAP_PLATFORM_ADMIN=1 is NOT
 *     implemented here on purpose.)
 *
 * The minted UUIDs are the binding pilot IDs and MUST be reused verbatim by the
 * catalog seed and by the POS terminal's pairing target (else read-down returns
 * `{items:[]}` for that device principal).
 *
 * RLS: inserts run inside ONE transaction with the tenant-context GUCs set
 * (`app.current_tenant` = pilot tenant, `app.is_platform_admin` = 'true' for the
 * tenant row itself), mirroring `runWithTenantContext` — "bypasses the HTTP
 * guard" is NOT "bypasses RLS". The existing-tenant slug lookup runs first,
 * under the same elevation with the nil tenant, so a re-run as a non-superuser
 * role finds the pilot tenant.
 *
 * Reads `DATABASE_URL` (same as migrate.ts). Idempotent: re-running is a no-op
 * once the rows exist (existence-guarded). The operator user is found through
 * its link first, then through the bridge column (a pilot seeded before RT-797
 * has no link row; the re-run adds it). Prints the minted IDs as JSON.
 *
 * Usage:
 *   OPERATOR_PROVIDER_KEY=<adapter provider key> \
 *   OPERATOR_PROVIDER_ISSUER=https://<the adapter's issuer> \
 *   OPERATOR_PROVIDER_SUBJECT=<provider user id> \
 *   PILOT_TENANT_SLUG=pilot PILOT_TENANT_NAME="Pilot Tenant" \
 *   PILOT_STORE_CODE=main PILOT_STORE_NAME="Main Store" \
 *   PILOT_OPERATOR_EMAIL=operator@pilot.test \
 *   node dist/cli/bootstrap-pilot.js
 *
 * Exit codes: 0 success · 1 SQL/runtime error · 2 DATABASE_URL missing ·
 *             4 OPERATOR_PROVIDER_* missing or malformed.
 */
import { randomUUID } from 'node:crypto';
import { Client, type ClientBase } from 'pg';

const NIL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Default tenant roles — byte-identical to TenantsRepository.DEFAULT_TENANT_ROLES. */
const DEFAULT_TENANT_ROLES = [
  { code: 'owner', name: 'Owner' },
  { code: 'tenant_admin', name: 'Tenant Admin' },
  { code: 'store_manager', name: 'Store Manager' },
  { code: 'store_staff', name: 'Store Staff' },
] as const;

/**
 * The operator's membership role. MUST be an ELIGIBLE internal role
 * (`mapInternalRoleToPos` accepts owner/tenant_admin -> "admin",
 * store_manager -> "manager"; store_staff -> null => sign-in refuses
 * `role_not_eligible`). `store_manager` is the least-privileged eligible role.
 */
const OPERATOR_ROLE_CODE = 'store_manager';

/** Same shapes the identity-link cutover CLI accepts. */
const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ISSUER_URL_RE = /^https:\/\/\S{1,500}$/;

/** The operator's identity at the provider: one `external_identity_links` row. */
interface OperatorIdentity {
  providerKey: string;
  issuer: string;
  subject: string;
}

export interface PilotConfig {
  operatorIdentity: OperatorIdentity;
  tenantSlug: string;
  tenantName: string;
  storeCode: string;
  storeName: string;
  operatorEmail: string;
}

export interface MintedIds {
  tenant_id: string;
  store_id: string;
  operator_user_id: string;
  operator_membership_id: string;
  operator_role_id: string;
  operator_provider_key: string;
  operator_provider_subject: string;
  /**
   * false: the configured identity is not the operator's active link (another
   * link is active, or the configured link exists but is disabled). The seed
   * never changes identity-link status.
   */
  operator_link_active: boolean;
}

/** A missing or malformed operator identity input (exit 4). */
export class PilotConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, name: string, shape: RegExp, hint: string): string {
  const value = (env[name] ?? '').trim();
  // Never echo the value: it may be an id typed into the wrong variable.
  if (!shape.test(value)) throw new PilotConfigError(`${name} is required — ${hint}`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv): PilotConfig {
  return {
    operatorIdentity: {
      providerKey: requireEnv(env, 'OPERATOR_PROVIDER_KEY', PROVIDER_KEY_RE, 'the adapter provider key'),
      issuer: requireEnv(env, 'OPERATOR_PROVIDER_ISSUER', ISSUER_URL_RE, "the adapter's https issuer"),
      subject: requireEnv(
        env,
        'OPERATOR_PROVIDER_SUBJECT',
        /\S/,
        'the provider user id of the operator (mint the identity first; this seed only links it)',
      ),
    },
    tenantSlug: env['PILOT_TENANT_SLUG'] ?? 'pilot',
    tenantName: env['PILOT_TENANT_NAME'] ?? 'Pilot Tenant',
    storeCode: env['PILOT_STORE_CODE'] ?? 'main',
    storeName: env['PILOT_STORE_NAME'] ?? 'Main Store',
    operatorEmail: env['PILOT_OPERATOR_EMAIL'] ?? 'operator@pilot.test',
  };
}

/** Set the tenant-context GUCs for this transaction (mirrors runWithTenantContext). */
async function setContext(
  client: ClientBase,
  tenantId: string,
  isPlatformAdmin: boolean,
): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [
    tenantId ?? NIL_TENANT_ID,
  ]);
  await client.query("SELECT set_config('app.is_platform_admin', $1, true)", [
    isPlatformAdmin ? 'true' : 'false',
  ]);
}

/**
 * Serialize this seed with the identity-link cutover CLI on (provider, subject).
 * Taken BEFORE the operator user is resolved: otherwise a cutover could claim
 * the identity between the lookup and the link insert, and the pilot
 * membership would land on a user that cannot sign in.
 */
async function lockOperatorIdentity(client: ClientBase, identity: OperatorIdentity): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('identity-link:' || $1 || ':' || $2))", [
    identity.providerKey,
    identity.subject,
  ]);
}

/**
 * The operator's user id: the user linked to (provider, subject) under any
 * issuer or status, else the user whose bridge column holds the subject AND who
 * has no link row at all (a pilot seeded before RT-797, which wrote none).
 * A user with links is never adopted through the bridge column: another
 * provider's subject could equal its value. Null for a fresh database.
 *
 * More than one ACTIVE link for (provider, subject) (two users, two issuers)
 * is refused, as the sign-in resolver refuses it: the seed must not give pilot
 * membership to one of two users that neither can sign in as.
 */
async function findOperatorUser(client: ClientBase, identity: OperatorIdentity): Promise<string | null> {
  const active = await client.query<{ user_id: string }>(
    `SELECT user_id FROM external_identity_links
      WHERE provider_key = $1 AND subject = $2 AND status = 'active'
      LIMIT 2`,
    [identity.providerKey, identity.subject],
  );
  if (active.rows.length > 1) {
    throw new Error('the configured operator identity has more than one active link (ambiguous); fix the links first');
  }
  if (active.rows[0]) return active.rows[0].user_id;
  const viaLink = await client.query<{ user_id: string }>(
    `SELECT user_id FROM external_identity_links
      WHERE provider_key = $1 AND subject = $2
      ORDER BY id
      LIMIT 1`,
    [identity.providerKey, identity.subject],
  );
  if (viaLink.rows[0]) return viaLink.rows[0].user_id;
  const viaBridge = await client.query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.clerk_user_id = $1
        AND NOT EXISTS (SELECT 1 FROM external_identity_links l WHERE l.user_id = u.id)`,
    [identity.subject],
  );
  return viaBridge.rows[0]?.id ?? null;
}

/**
 * Give the operator its ACTIVE link, unless (provider, subject) is already
 * linked or the user already has an active link (one per user; a user moved
 * to another provider by the identity-link cutover keeps that link). A seed
 * never flips links: that is the cutover's job.
 *
 * Returns whether the configured identity is the user's active link, so the
 * output never claims an identity the operator cannot sign in with. Matched on
 * (provider, subject) without issuer, exactly as the sign-in resolver
 * (`identity-link-lookup.ts`) matches: a link stored under another issuer form
 * still signs the operator in.
 */
async function ensureOperatorLink(
  client: ClientBase,
  userId: string,
  identity: OperatorIdentity,
): Promise<boolean> {
  // The caller holds the identity lock (lockOperatorIdentity), so the NOT
  // EXISTS checks below cannot race a concurrent cutover's claim.
  await client.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, email, status)
     SELECT $1, $2, $3, u.id, u.email, 'active' FROM users u
      WHERE u.id = $4
        AND NOT EXISTS (SELECT 1 FROM external_identity_links WHERE user_id = $4 AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM external_identity_links WHERE provider_key = $1 AND subject = $3)
     ON CONFLICT (provider_key, issuer, subject) DO NOTHING`,
    [identity.providerKey, identity.issuer, identity.subject, userId],
  );
  const active = await client.query(
    `SELECT 1 FROM external_identity_links
      WHERE user_id = $1 AND status = 'active' AND provider_key = $2 AND subject = $3`,
    [userId, identity.providerKey, identity.subject],
  );
  return active.rows.length === 1;
}

export async function seed(client: ClientBase, cfg: PilotConfig): Promise<MintedIds> {
  // Resolve-or-create the tenant first (idempotent on slug). `tenants` has
  // FORCE RLS, so the lookup runs under the same platform-admin elevation as
  // the tenant INSERT below; with no GUC a non-superuser re-run sees no tenant
  // and inserts a duplicate (RT-939). The nil tenant keeps the policy's uuid
  // cast well-formed.
  await setContext(client, NIL_TENANT_ID, true);
  const existingTenant = await client.query<{ id: string }>(
    'SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL',
    [cfg.tenantSlug],
  );
  const tenantId = existingTenant.rows[0]?.id ?? randomUUID();

  // GUCs: scope to the pilot tenant; is_platform_admin=true so the tenants
  // INSERT itself passes RLS (createTenant uses the same elevation).
  await setContext(client, tenantId, true);

  if (!existingTenant.rows[0]) {
    await client.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
      tenantId,
      cfg.tenantSlug,
      cfg.tenantName,
    ]);
  }

  // Default roles (idempotent on (tenant_id, code)).
  for (const r of DEFAULT_TENANT_ROLES) {
    await client.query(
      `INSERT INTO roles (id, tenant_id, code, name, is_built_in)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [randomUUID(), tenantId, r.code, r.name],
    );
  }
  const roleRow = await client.query<{ id: string }>(
    'SELECT id FROM roles WHERE tenant_id = $1 AND code = $2',
    [tenantId, OPERATOR_ROLE_CODE],
  );
  const operatorRoleId = roleRow.rows[0]?.id;
  if (!operatorRoleId) {
    throw new Error(`bootstrap: role '${OPERATOR_ROLE_CODE}' not found after seed`);
  }

  // Store (idempotent on (tenant_id, lower(code))).
  const existingStore = await client.query<{ id: string }>(
    'SELECT id FROM stores WHERE tenant_id = $1 AND lower(code) = lower($2) AND deleted_at IS NULL',
    [tenantId, cfg.storeCode],
  );
  const storeId = existingStore.rows[0]?.id ?? randomUUID();
  if (!existingStore.rows[0]) {
    await client.query('INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [
      storeId,
      tenantId,
      cfg.storeCode,
      cfg.storeName,
    ]);
  }

  // Operator user, found through its link first, then the bridge column.
  await lockOperatorIdentity(client, cfg.operatorIdentity);
  const operatorUserId =
    (await findOperatorUser(client, cfg.operatorIdentity)) ?? randomUUID();
  const existingUser = await client.query('SELECT 1 FROM users WHERE id = $1', [operatorUserId]);
  if (existingUser.rows.length === 0) {
    // The bridge column carries the subject until RT-799 drops it.
    await client.query(
      `INSERT INTO users (id, email, clerk_user_id, is_platform_admin)
       VALUES ($1, $2, $3, false)`,
      [operatorUserId, cfg.operatorEmail, cfg.operatorIdentity.subject],
    );
  }
  const operatorLinkActive = await ensureOperatorLink(client, operatorUserId, cfg.operatorIdentity);

  // Membership in the pilot tenant (idempotent on the active-membership uidx).
  const existingMembership = await client.query<{ id: string }>(
    'SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [tenantId, operatorUserId],
  );
  const membershipId = existingMembership.rows[0]?.id ?? randomUUID();
  if (!existingMembership.rows[0]) {
    await client.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      [membershipId, tenantId, operatorUserId, operatorRoleId],
    );
  }

  return {
    tenant_id: tenantId,
    store_id: storeId,
    operator_user_id: operatorUserId,
    operator_membership_id: membershipId,
    operator_role_id: operatorRoleId,
    operator_provider_key: cfg.operatorIdentity.providerKey,
    operator_provider_subject: cfg.operatorIdentity.subject,
    operator_link_active: operatorLinkActive,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  let cfg: PilotConfig;
  try {
    cfg = readConfig(process.env);
  } catch (err) {
    if (!(err instanceof PilotConfigError)) throw err;
    console.error(err.message);
    process.exit(4);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const ids = await seed(client, cfg);
      await client.query('COMMIT');
      console.log('bootstrap-pilot: seeded (idempotent). Minted/confirmed IDs:');
      console.log(JSON.stringify(ids, null, 2));
      if (!ids.operator_link_active) {
        console.error(
          'bootstrap-pilot: WARNING — the configured OPERATOR_PROVIDER_* identity link ' +
            'is not active; bootstrap does not change identity-link status.',
        );
      }
      console.log(
        '\nNEXT (runtime / separate): (1) pair a terminal to this tenant/store ' +
          '(device token); (2) operator signs in via the POS app to obtain the ' +
          'pos_operator session token; (3) run seed-catalog.ts under tenant_id ' +
          `${ids.tenant_id} / store_id ${ids.store_id}.`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`bootstrap-pilot: ${message}`);
    process.exit(1);
  });
}
