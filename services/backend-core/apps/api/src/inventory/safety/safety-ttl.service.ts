/**
 * The tenant's Safety TTL — Jira RT-449 PR 2 (RT-50 G7-7, Q8; ruling H8,
 * RT-449 comment 13434).
 *
 * The maximum age of a till's last successful sync from the POS inventory
 * safety feed before its safety data is stale. Stored as
 * `tenant_inventory_settings.safety_ttl_seconds` (0072): NULL means the
 * default of 900 seconds (15 minutes); the column CHECK bounds a set value to
 * 60–900, so it is configurable downwards only. The feed answers the
 * effective value on every call, so a change does not step the Inventory
 * Safety Revision (the change-log kinds of 0072 do not include it).
 *
 * The write mirrors the return landing policy (`position-events.service.ts`):
 * a per-tenant advisory lock, the row read FOR UPDATE, no write and no audit
 * for the current value, an upsert, and the audit row in the same
 * transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { writeAudit } from '../position-events/position-event.writer';

/** H8: the Safety TTL while the tenant has not set one (15 minutes). */
export const DEFAULT_SAFETY_TTL_SECONDS = 900;
/** H8: the shortest Safety TTL a tenant may set. */
export const MIN_SAFETY_TTL_SECONDS = 60;

const AUDIT_ACTION_SAFETY_TTL = 'inventory.safety_ttl.update';
const AUDIT_TARGET_TYPE_SETTINGS = 'tenant_inventory_settings';

/** The SQL expression of a tenant's effective Safety TTL (`$1` = tenant id). */
export const EFFECTIVE_SAFETY_TTL_SQL = `COALESCE(
  (SELECT safety_ttl_seconds FROM tenant_inventory_settings WHERE tenant_id = $1),
  ${DEFAULT_SAFETY_TTL_SECONDS})`;

/** Contract `SafetyTtlSetting`. */
export interface SafetyTtlSettingBody {
  readonly safetyTtlSeconds: number | null;
  readonly effectiveSafetyTtlSeconds: number;
  readonly updatedAt: string | null;
}

interface SettingsRow {
  readonly safety_ttl_seconds: number | null;
  readonly updated_at: Date;
}

function toBody(row: SettingsRow | undefined): SafetyTtlSettingBody {
  const configured = row?.safety_ttl_seconds ?? null;
  return {
    safetyTtlSeconds: configured,
    effectiveSafetyTtlSeconds: configured ?? DEFAULT_SAFETY_TTL_SECONDS,
    updatedAt: row ? row.updated_at.toISOString() : null,
  };
}

async function readSettings(
  client: PoolClient,
  tenantId: string,
  forUpdate: boolean,
): Promise<SettingsRow | undefined> {
  const r = await client.query<SettingsRow>(
    `SELECT safety_ttl_seconds, updated_at FROM tenant_inventory_settings
      WHERE tenant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId],
  );
  return r.rows[0];
}

@Injectable()
export class SafetyTtlService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** The tenant's Safety TTL (the default when unset). */
  getSafetyTtl(tenantId: string): Promise<SafetyTtlSettingBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) =>
      toBody(await readSettings(client, tenantId, false)),
    );
  }

  /** Set the tenant's Safety TTL (60–900, or null for the default), audited in the same transaction. */
  setSafetyTtl(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly safetyTtlSeconds: number | null;
  }): Promise<SafetyTtlSettingBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Serialize the tenant's settings writers (the return landing policy
        // takes the same lock), then lock the row: FOR UPDATE alone cannot
        // lock a row that does not exist yet.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`,
          [input.tenantId],
        );
        const existing = await readSettings(client, input.tenantId, true);
        const before = existing?.safety_ttl_seconds ?? null;
        if (before === input.safetyTtlSeconds) return toBody(existing);
        const r = await client.query<SettingsRow>(
          `INSERT INTO tenant_inventory_settings (tenant_id, safety_ttl_seconds, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id) DO UPDATE
             SET safety_ttl_seconds = EXCLUDED.safety_ttl_seconds,
                 updated_by = EXCLUDED.updated_by
           RETURNING safety_ttl_seconds, updated_at`,
          [input.tenantId, input.safetyTtlSeconds, input.userId],
        );
        const row = r.rows[0];
        if (!row) throw new Error('SafetyTtlService: settings upsert returned no row');
        await writeAudit(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          action: AUDIT_ACTION_SAFETY_TTL,
          targetType: AUDIT_TARGET_TYPE_SETTINGS,
          targetId: input.tenantId,
          metadata: { old: before, new: row.safety_ttl_seconds },
        });
        return toBody(row);
      },
    );
  }
}
