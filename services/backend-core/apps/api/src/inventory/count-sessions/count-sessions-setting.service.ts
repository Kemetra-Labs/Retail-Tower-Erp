/**
 * The tenant's Count Session activation switch — Jira RT-1423 (RT-292 Gate 6, G6-7), runtime of
 * `getCountSessionsSetting` / `setCountSessionsSetting` (`inventory/inventory.yaml` 1.16.0-draft).
 *
 * Stored as `tenant_inventory_settings.count_sessions_enabled` (0114, DEFAULT false) with
 * `count_sessions_changed_at` / `_by` (0116). No settings row reads OFF. The change history is the audit trail
 * (`inventory.count_sessions.update`), written in the change's transaction.
 *
 * ON is the activation: it opens the Count Session API (dark until then, RT-1420), makes the legacy immediate
 * count route answer a typed 409 (one writer, G6-7), and lets an approved session emit ERP intents.
 *
 *  - Read: owner / tenant_admin (and a platform admin) get every field with the readiness evaluated on each
 *    read; a store_manager gets the on/off value only.
 *  - Write (owner / tenant_admin): repeating the current value writes nothing and records no audit.
 *    Off -> on evaluates the readiness in the same transaction and FAILS CLOSED with 409
 *    `count_sessions_readiness_unmet` while any boundary is unmet (there is no override). On -> off is
 *    REFUSED with 409 `count_sessions_open` while any session of the tenant is live (open, cut taken,
 *    submitted, approved, posting, needs attention): switching off must never strand a count mid-flight and
 *    must never re-open the legacy writer beside an unfinished session.
 *
 * The write takes the per-tenant settings advisory lock the other settings writers take, then the row.
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../database';
import { MembershipRepository } from '../../context/membership.repository';
import { writeAudit } from '../position-events/position-event.writer';
import { readBarrierInputs } from './count-barrier';
import {
  evaluateReadiness,
  type ReadinessEvidence,
  type StoreEvidence,
  type ReadinessSubject,
  type UnmetReadiness,
} from './count-readiness';

const AUDIT_ACTION = 'inventory.count_sessions.update';
const AUDIT_TARGET_TYPE = 'tenant_inventory_settings';

/** Contract `CountSessionsSetting`. */
export interface CountSessionsSettingBody {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly readinessMet: boolean | null;
  readonly unmetReadiness: Array<{ code: string; storeId: string | null; message: string; subject?: ReadinessSubject }> | null;
}

export interface CountSessionsCaller {
  readonly tenantId: string;
  readonly userId: string;
  readonly isPlatformAdmin: boolean;
}

interface SwitchRow {
  readonly count_sessions_enabled: boolean;
  readonly count_sessions_changed_at: Date | null;
  readonly count_sessions_changed_by: string | null;
}

/** Sessions that are not finished: switching the feature off while one exists is refused. */
export const OPEN_COUNT_SESSION_STATES = ['open', 'cut_taken', 'submitted', 'approved', 'posting', 'needs_attention'];

async function readSwitch(client: PoolClient, tenantId: string, forUpdate: boolean): Promise<SwitchRow | undefined> {
  const r = await client.query<SwitchRow>(
    `SELECT count_sessions_enabled, count_sessions_changed_at, count_sessions_changed_by
       FROM tenant_inventory_settings WHERE tenant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId],
  );
  return r.rows[0];
}

function unmetBody(unmet: readonly UnmetReadiness[]): NonNullable<CountSessionsSettingBody['unmetReadiness']> {
  return unmet.map((u) => ({
    code: u.code,
    storeId: u.storeId,
    message: u.message,
    ...(u.subject !== undefined ? { subject: u.subject } : {}), // additionalProperties: false allows no null key
  }));
}

function fullBody(row: SwitchRow | undefined, unmet: readonly UnmetReadiness[]): CountSessionsSettingBody {
  return {
    enabled: row?.count_sessions_enabled ?? false,
    changedAt: row?.count_sessions_changed_at ? row.count_sessions_changed_at.toISOString() : null,
    changedBy: row?.count_sessions_changed_by ?? null,
    readinessMet: unmet.length === 0,
    unmetReadiness: unmetBody(unmet),
  };
}

function onOffBody(row: SwitchRow | undefined): CountSessionsSettingBody {
  return {
    enabled: row?.count_sessions_enabled ?? false,
    changedAt: null,
    changedBy: null,
    readinessMet: null,
    unmetReadiness: null,
  };
}

/** Gather the evidence of every live store and of the Connector from what Backend-Core really holds. */
async function gatherReadinessEvidence(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<ReadinessEvidence> {
  const stores = await client.query<{ id: string }>(
    `SELECT id FROM stores WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active ORDER BY id`,
    [tenantId],
  );
  const evidence: StoreEvidence[] = [];
  for (const s of stores.rows) {
    const inputs = await readBarrierInputs(client, s.id);
    evidence.push({
      storeId: s.id,
      hasStockWarehouse: inputs.warehouses.length > 0,
      devices: inputs.devices,
      warehouses: inputs.warehouses,
    });
  }
  // RT-1427: the Connector reports the work-item kinds it accepts and the ERP back-dated role itself.
  const health = await client.query<{
    last_seen_at: Date | null;
    accepted_work_item_kinds: string[] | null;
    back_dated_role_status: string | null;
    back_dated_role_reported_at: Date | null;
  }>(
    `SELECT last_seen_at, accepted_work_item_kinds, back_dated_role_status, back_dated_role_reported_at
       FROM connector_health
      WHERE tenant_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
    [tenantId],
  );
  const h = health.rows[0];
  return {
    now,
    stores: evidence,
    connector: {
      lastSeenAt: h?.last_seen_at ?? null,
      acceptedKinds: h?.accepted_work_item_kinds ?? null,
      backDatedRoleStatus: h?.back_dated_role_status ?? null,
      backDatedRoleReportedAt: h?.back_dated_role_reported_at ?? null,
    },
  };
}

@Injectable()
export class CountSessionsSettingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  getSetting(caller: CountSessionsCaller): Promise<CountSessionsSettingBody> {
    return runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, async (client) => {
      const row = await readSwitch(client, caller.tenantId, false);
      if (!caller.isPlatformAdmin) {
        const role = await this.memberships.findRoleCodeForUserInTenant(caller.userId, caller.tenantId, client);
        if (role !== 'owner' && role !== 'tenant_admin') return onOffBody(row);
      }
      return fullBody(row, evaluateReadiness(await gatherReadinessEvidence(client, caller.tenantId)));
    });
  }

  setSetting(caller: CountSessionsCaller, enabled: boolean): Promise<CountSessionsSettingBody> {
    return runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`,
        [caller.tenantId],
      );
      const existing = await readSwitch(client, caller.tenantId, true);
      const before = existing?.count_sessions_enabled ?? false;
      if (before === enabled) {
        return fullBody(existing, evaluateReadiness(await gatherReadinessEvidence(client, caller.tenantId)));
      }
      if (enabled) await this.assertReady(client, caller.tenantId);
      else await this.assertNoOpenSession(client, caller.tenantId);
      const r = await client.query<SwitchRow>(
        `INSERT INTO tenant_inventory_settings
           (tenant_id, count_sessions_enabled, count_sessions_changed_at, count_sessions_changed_by, updated_by)
         VALUES ($1, $2, now(), $3, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET count_sessions_enabled = EXCLUDED.count_sessions_enabled,
               count_sessions_changed_at = EXCLUDED.count_sessions_changed_at,
               count_sessions_changed_by = EXCLUDED.count_sessions_changed_by,
               updated_by = EXCLUDED.updated_by
         RETURNING count_sessions_enabled, count_sessions_changed_at, count_sessions_changed_by`,
        [caller.tenantId, enabled, caller.userId],
      );
      const row = r.rows[0];
      if (!row) throw new Error('CountSessionsSettingService: settings upsert returned no row');
      await writeAudit(client, {
        tenantId: caller.tenantId,
        userId: caller.userId,
        action: AUDIT_ACTION,
        targetType: AUDIT_TARGET_TYPE,
        targetId: caller.tenantId,
        metadata: { old: before, new: row.count_sessions_enabled },
      });
      return fullBody(row, evaluateReadiness(await gatherReadinessEvidence(client, caller.tenantId)));
    });
  }

  private async assertReady(client: PoolClient, tenantId: string): Promise<void> {
    const unmet = evaluateReadiness(await gatherReadinessEvidence(client, tenantId));
    if (unmet.length === 0) return;
    const first = unmet[0]!;
    throw new ConflictException({
      code: 'count_sessions_readiness_unmet',
      message: `Count Sessions cannot be switched on: ${first.message}`,
      details: { boundary: first.code, storeId: first.storeId, unmet: unmetBody(unmet) },
    });
  }

  private async assertNoOpenSession(client: PoolClient, tenantId: string): Promise<void> {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM count_sessions WHERE tenant_id = $1 AND state = ANY($2::text[])`,
      [tenantId, OPEN_COUNT_SESSION_STATES],
    );
    if (Number(r.rows[0]?.n ?? '0') > 0) {
      throw new ConflictException({
        code: 'count_sessions_open',
        message: 'Count Sessions cannot be switched off while a session is open.',
      });
    }
  }
}
