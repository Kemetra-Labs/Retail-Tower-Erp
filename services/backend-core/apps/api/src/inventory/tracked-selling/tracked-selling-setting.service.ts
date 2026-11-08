/**
 * The tenant's tracked-selling switch — Jira RT-451 S2 runtime of
 * `getTrackedSellingSetting` / `setTrackedSellingSetting`
 * (`inventory/inventory.yaml` 1.12.0-draft; owner decisions OD-T1..OD-T7,
 * RT-451 comments 16215, 16216, 16217).
 *
 * Stored as `tenant_inventory_settings.tracked_selling_enabled` with
 * `tracked_selling_changed_at` / `_by` (0086). No settings row reads OFF,
 * never changed. The history of the switch is the audit trail
 * (`inventory.tracked_selling.update`), written in the change's transaction.
 *
 * - Read: owner / tenant_admin (and a platform admin) get every field, the
 *   Q13 preconditions evaluated on each read; a store_manager gets the on/off
 *   value only, every other field null (OD-T6).
 * - Write (owner / tenant_admin): repeating the current value writes nothing
 *   and records no audit. Off -> on checks the preconditions in the same
 *   transaction and refuses with 409 `tracked_selling_preconditions_unmet`
 *   while any is unmet (OD-T3, OD-T5). On -> off is always accepted. A tenant
 *   that is on stays on when a precondition later fails (OD-T7): nothing here
 *   or elsewhere turns the switch off by itself.
 *
 * The write takes the per-tenant settings advisory lock the other settings
 * writers take (`safety-ttl.service.ts`, the return landing policy), then the
 * row FOR UPDATE.
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { MembershipRepository } from '../../context/membership.repository';
import { writeAudit } from '../position-events/position-event.writer';
import {
  TrackedSellingPreconditions,
  type TrackedSellingPrecondition,
} from './tracked-selling-preconditions';

const AUDIT_ACTION_TRACKED_SELLING = 'inventory.tracked_selling.update';
const AUDIT_TARGET_TYPE_SETTINGS = 'tenant_inventory_settings';

/** Contract `TrackedSellingSetting`. */
export interface TrackedSellingSettingBody {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly preconditionsMet: boolean | null;
  readonly unmetPreconditions: TrackedSellingPrecondition[] | null;
}

/** The authenticated caller of a tracked-selling operation. */
export interface TrackedSellingCaller {
  readonly tenantId: string;
  readonly userId: string;
  readonly isPlatformAdmin: boolean;
}

interface SwitchRow {
  readonly tracked_selling_enabled: boolean;
  readonly tracked_selling_changed_at: Date | null;
  readonly tracked_selling_changed_by: string | null;
}

async function readSwitch(
  client: PoolClient,
  tenantId: string,
  forUpdate: boolean,
): Promise<SwitchRow | undefined> {
  const r = await client.query<SwitchRow>(
    `SELECT tracked_selling_enabled, tracked_selling_changed_at, tracked_selling_changed_by
       FROM tenant_inventory_settings WHERE tenant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId],
  );
  return r.rows[0];
}

function fullBody(row: SwitchRow | undefined, unmet: TrackedSellingPrecondition[]): TrackedSellingSettingBody {
  return {
    enabled: row?.tracked_selling_enabled ?? false,
    changedAt: row?.tracked_selling_changed_at ? row.tracked_selling_changed_at.toISOString() : null,
    changedBy: row?.tracked_selling_changed_by ?? null,
    preconditionsMet: unmet.length === 0,
    unmetPreconditions: unmet,
  };
}

/** OD-T6: a store_manager reads on/off only. */
function onOffBody(row: SwitchRow | undefined): TrackedSellingSettingBody {
  return {
    enabled: row?.tracked_selling_enabled ?? false,
    changedAt: null,
    changedBy: null,
    preconditionsMet: null,
    unmetPreconditions: null,
  };
}

@Injectable()
export class TrackedSellingSettingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(TrackedSellingPreconditions) private readonly preconditions: TrackedSellingPreconditions,
  ) {}

  /** The tenant's switch: every field for owner / tenant_admin, on/off only for a store_manager. */
  getSetting(caller: TrackedSellingCaller): Promise<TrackedSellingSettingBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: caller.tenantId, isPlatformAdmin: false },
      async (client) => {
        const row = await readSwitch(client, caller.tenantId, false);
        if (!caller.isPlatformAdmin) {
          const role = await this.memberships.findRoleCodeForUserInTenant(caller.userId, caller.tenantId, client);
          if (role !== 'owner' && role !== 'tenant_admin') return onOffBody(row);
        }
        return fullBody(row, await this.preconditions.unmet(client, caller.tenantId));
      },
    );
  }

  /** Switch tracked selling on or off for the tenant, audited in the same transaction. */
  setSetting(caller: TrackedSellingCaller, enabled: boolean): Promise<TrackedSellingSettingBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: caller.tenantId, isPlatformAdmin: false },
      async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`,
          [caller.tenantId],
        );
        const existing = await readSwitch(client, caller.tenantId, true);
        const before = existing?.tracked_selling_enabled ?? false;
        // A repeat in either direction is a no-op: no write, no audit, and no
        // precondition re-check while already on (OD-T7).
        if (before === enabled) return fullBody(existing, await this.preconditions.unmet(client, caller.tenantId));
        if (enabled) {
          const unmet = await this.preconditions.unmet(client, caller.tenantId);
          if (unmet.length > 0) {
            throw new ConflictException({
              code: 'tracked_selling_preconditions_unmet',
              message: 'Tracked selling cannot be switched on until its preconditions hold.',
            });
          }
        }
        const r = await client.query<SwitchRow>(
          `INSERT INTO tenant_inventory_settings
             (tenant_id, tracked_selling_enabled, tracked_selling_changed_at, tracked_selling_changed_by, updated_by)
           VALUES ($1, $2, now(), $3, $3)
           ON CONFLICT (tenant_id) DO UPDATE
             SET tracked_selling_enabled = EXCLUDED.tracked_selling_enabled,
                 tracked_selling_changed_at = EXCLUDED.tracked_selling_changed_at,
                 tracked_selling_changed_by = EXCLUDED.tracked_selling_changed_by,
                 updated_by = EXCLUDED.updated_by
           RETURNING tracked_selling_enabled, tracked_selling_changed_at, tracked_selling_changed_by`,
          [caller.tenantId, enabled, caller.userId],
        );
        const row = r.rows[0];
        if (!row) throw new Error('TrackedSellingSettingService: settings upsert returned no row');
        await writeAudit(client, {
          tenantId: caller.tenantId,
          userId: caller.userId,
          action: AUDIT_ACTION_TRACKED_SELLING,
          targetType: AUDIT_TARGET_TYPE_SETTINGS,
          targetId: caller.tenantId,
          metadata: { old: before, new: row.tracked_selling_enabled },
        });
        return fullBody(row, await this.preconditions.unmet(client, caller.tenantId));
      },
    );
  }
}
