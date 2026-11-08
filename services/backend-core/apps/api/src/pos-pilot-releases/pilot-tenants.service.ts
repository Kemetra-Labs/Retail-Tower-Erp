/**
 * PilotTenantsService: `platformAddPilotTenant` and `platformRemovePilotTenant`
 * (RT-1292; `pos-pilot-releases.openapi.yaml`). The pilot allowlist is a
 * tenant control managed only by a platform admin.
 *
 * Both run under `{ tenantId: null, isPlatformAdmin: true }` (platform scope).
 * Each is idempotent: a no-op (already listed, already absent) writes no audit
 * row. An effective change writes ONE platform-scoped audit row (`tenant_id`
 * NULL, target the tenant, metadata `tenantId` only) in the same transaction.
 * An unknown tenant is a foreign-key violation, read as
 * `PilotTenantNotFoundError` (404).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";

const PILOT_TENANT_ADDED_ACTION = "pos.pilot_tenant.added";
const PILOT_TENANT_REMOVED_ACTION = "pos.pilot_tenant.removed";

/** No tenant has this id → 404 `tenant_not_found`. */
export class PilotTenantNotFoundError extends Error {
  constructor() {
    super("tenant not found");
    this.name = "PilotTenantNotFoundError";
  }
}

export interface PilotTenantBody {
  readonly tenantId: string;
  readonly addedAt: string;
  readonly addedByUserId: string;
}

export interface PilotTenantChangeInput {
  readonly tenantId: string;
  /** The session user (`users.id`): the change's actor. */
  readonly actorUserId: string;
  readonly requestId: string | null;
}

interface AllowlistRow {
  tenant_id: string;
  added_by_user_id: string;
  added_at: Date;
}

const COLUMNS = "tenant_id, added_by_user_id, added_at";
const PLATFORM = { tenantId: null, isPlatformAdmin: true } as const;
const FOREIGN_KEY_VIOLATION = "23503";

/** Map an allowlist row to the contract body. */
function toBody(row: AllowlistRow): PilotTenantBody {
  return { tenantId: row.tenant_id, addedAt: row.added_at.toISOString(), addedByUserId: row.added_by_user_id };
}

/** True when `err`, or a `cause` below it, is a PostgreSQL foreign-key violation. */
function isForeignKeyViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Write one platform-scoped audit row for an effective allowlist change. */
async function audit(client: PoolClient, input: PilotTenantChangeInput, action: string): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, NULL, $3, 'tenant', $4, $5, $6::jsonb)`,
    [newId(), input.actorUserId, action, input.tenantId, input.requestId, JSON.stringify({ tenantId: input.tenantId })],
  );
}

/** Adds and removes pilot allowlist tenants in platform scope, auditing each effective change. */
@Injectable()
export class PilotTenantsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Add the tenant; `created` is false when it was already listed (nothing written). */
  async add(input: PilotTenantChangeInput): Promise<{ created: boolean; entry: PilotTenantBody }> {
    try {
      return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
        const inserted = await client.query<AllowlistRow>(
          `INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id)
           VALUES ($1::uuid, $2::uuid)
           ON CONFLICT (tenant_id) DO NOTHING
           RETURNING ${COLUMNS}`,
          [input.tenantId, input.actorUserId],
        );
        const row = inserted.rows[0];
        if (row !== undefined) {
          await audit(client, input, PILOT_TENANT_ADDED_ACTION);
          return { created: true, entry: toBody(row) };
        }
        const existing = await client.query<AllowlistRow>(
          `SELECT ${COLUMNS} FROM pos_pilot_tenant_allowlist WHERE tenant_id = $1::uuid`,
          [input.tenantId],
        );
        const stored = existing.rows[0];
        if (stored === undefined) throw new Error("addPilotTenant: no row inserted and none stored");
        return { created: false, entry: toBody(stored) };
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new PilotTenantNotFoundError();
      throw err;
    }
  }

  /** Remove the tenant; removing an absent tenant is a no-op that writes nothing. */
  async remove(input: PilotTenantChangeInput): Promise<void> {
    await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const deleted = await client.query(`DELETE FROM pos_pilot_tenant_allowlist WHERE tenant_id = $1::uuid RETURNING tenant_id`, [
        input.tenantId,
      ]);
      if ((deleted.rowCount ?? 0) > 0) await audit(client, input, PILOT_TENANT_REMOVED_ACTION);
    });
  }
}
