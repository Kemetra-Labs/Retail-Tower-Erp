/**
 * Lab-fixture guards — RT-1309.
 *
 * Four independent families, each fail-closed and each run BEFORE any write:
 *   - environment: the opt-in flag AND the database server's own name;
 *   - tenant/store: code allowlist AND a synthetic tenant name AND the store
 *     belonging to that tenant;
 *   - identity: the identity-provider project allowlist (the test flag is checked per
 *     identity by the provisioner);
 *   - permission: the connected role is neither a superuser nor BYPASSRLS.
 *
 * Static guards need no I/O, so `--dry-run` runs them without touching the
 * database or the identity provider.
 */
import type { PoolClient } from "pg";

import {
  ENABLE_ENV,
  ENABLE_VALUE,
  LAB_DATABASE_NAMES,
  LAB_IDENTITY_PROJECT_IDS,
  LAB_FIXTURE_TENANT_IDS,
  MAX_FIXTURES,
  SYNTHETIC_TENANT_MARKER,
} from "./constants";

export type GuardFamily = "environment" | "tenant" | "identity" | "permission" | "input";

export class GuardRefusedError extends Error {
  constructor(
    readonly family: GuardFamily,
    readonly reason: string,
  ) {
    super(`${family} guard refused: ${reason}`);
    this.name = "GuardRefusedError";
  }
}

export interface StaticGuardInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerProjectId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly count: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every check that needs no I/O. Throws `GuardRefusedError` on the first failure. */
export function assertStaticGuards(input: StaticGuardInput): void {
  if (input.env[ENABLE_ENV] !== ENABLE_VALUE) {
    throw new GuardRefusedError("environment", `${ENABLE_ENV} is not '${ENABLE_VALUE}'`);
  }
  if (!LAB_IDENTITY_PROJECT_IDS.includes(input.providerProjectId)) {
    throw new GuardRefusedError("identity", "the identity-provider project is not an allowlisted lab project");
  }
  if (!UUID_RE.test(input.tenantId) || !UUID_RE.test(input.storeId)) {
    throw new GuardRefusedError("input", "tenant and store must be lowercase UUIDs");
  }
  if (!LAB_FIXTURE_TENANT_IDS.includes(input.tenantId)) {
    throw new GuardRefusedError("tenant", "the tenant is not an allowlisted synthetic lab tenant");
  }
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_FIXTURES) {
    throw new GuardRefusedError("input", `count must be an integer from 1 to ${MAX_FIXTURES}`);
  }
}

/**
 * The checks the target database answers itself. `client` must run inside the
 * fixture tenant's context (RLS); these are reads only.
 */
export async function assertDatabaseGuards(
  client: PoolClient,
  tenantId: string,
  storeId: string,
): Promise<void> {
  await assertLabDatabase(client);
  await assertUnprivilegedRole(client);
  await assertSyntheticTenantStore(client, tenantId, storeId);
}

/** Anything that can run one query: a pooled client or a pool. */
interface Queryable {
  query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * The second (auth-lookup) connection must reach the same allowlisted lab
 * database: links are read through it, so it must not point elsewhere.
 */
export async function assertLabDatabase(db: Queryable): Promise<void> {
  const r = await db.query<{ name: string }>("SELECT current_database() AS name");
  const name = r.rows[0]?.name ?? "";
  if (!LAB_DATABASE_NAMES.includes(name)) {
    throw new GuardRefusedError("environment", "the connected database is not an allowlisted lab database");
  }
}

async function assertUnprivilegedRole(client: PoolClient): Promise<void> {
  const r = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const role = r.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new GuardRefusedError("permission", "the database role must be neither superuser nor BYPASSRLS");
  }
}

async function assertSyntheticTenantStore(
  client: PoolClient,
  tenantId: string,
  storeId: string,
): Promise<void> {
  const tenant = await client.query<{ name: string }>(
    "SELECT name FROM tenants WHERE id = $1 AND deleted_at IS NULL AND status = 'active'",
    [tenantId],
  );
  const name = tenant.rows[0]?.name;
  if (name === undefined || !name.includes(SYNTHETIC_TENANT_MARKER)) {
    throw new GuardRefusedError("tenant", `the tenant is missing or not named ${SYNTHETIC_TENANT_MARKER}`);
  }
  const store = await client.query<{ id: string }>(
    "SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND is_active",
    [storeId, tenantId],
  );
  if (store.rows.length !== 1) {
    throw new GuardRefusedError("tenant", "the store is not an active store of the tenant");
  }
}
