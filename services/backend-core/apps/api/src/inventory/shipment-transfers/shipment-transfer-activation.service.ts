/**
 * The tenant's shipment-Transfer activation switch — Jira RT-1513 (RT-291 Gate 5). The runtime of the switch only:
 * the contract (RT-1512) has no settings operation, so no HTTP surface is added here; RT-1517 (per-tenant enable and
 * switch-over) exposes it. Stored as `tenant_inventory_settings.shipment_transfers_enabled` (0124, DEFAULT false) with
 * `shipment_transfers_changed_at` / `_by`. No settings row reads OFF. The change history is the audit trail
 * (`inventory.shipment_transfers.update`), written in the change's transaction.
 *
 * ON opens the shipment Transfer API (dark until then) and makes the legacy instant transfer answer 409
 * `transfer_workflow_required` (one writable workflow, 976). Off -> on FAILS CLOSED while any boundary is unmet:
 *   - the Connector has a recent heartbeat, reports that it accepts BOTH `transfer_dispatch` and `transfer_receive`
 *     (posting-feed.yaml 1.17.0-draft: Backend-Core must not emit them before that), and a fresh verified back-dated
 *     stock role (a receipt is posted after the fact, with its own `occurred_at`);
 *   - the tenant has an active transit warehouse in the warehouse map (O2).
 * On -> off is REFUSED while any Transfer is in flight (draft, approved, in transit, partially received): switching
 * off must never strand goods mid-flight nor re-open the legacy writer beside an unfinished Transfer.
 *
 * The write takes the per-tenant settings advisory lock the other settings writers take, then the row.
 */
import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { hasActiveTransitWarehouse } from '../../catalog';
import { latestConnectorEvidence } from '../../connector-health';
import { MembershipRepository } from '../../context';
import { PG_POOL } from '../../database';
import { CONNECTOR_HEARTBEAT_MAX_AGE_MS } from '../count-sessions/count-readiness';
import { writeAudit } from '../position-events/position-event.writer';

const AUDIT_ACTION = 'inventory.shipment_transfers.update';
const AUDIT_TARGET_TYPE = 'tenant_inventory_settings';
const REQUIRED_KINDS = ['transfer_dispatch', 'transfer_receive'] as const;
/** The states in which a Transfer still has an unfinished life: switching off while one exists is refused. */
const IN_FLIGHT_TRANSFER_STATES = ['draft', 'approved', 'in_transit', 'partially_received'] as const;

type TransferReadinessCode =
  | 'connector_not_seen'
  | 'connector_version_unlisted'
  | 'erp_back_dated_role_unverified'
  | 'transit_warehouse_unmapped';

export interface UnmetTransferReadiness {
  readonly code: TransferReadinessCode;
  readonly message: string;
}

export interface TransferReadinessEvidence {
  readonly now: Date;
  readonly hasTransitWarehouse: boolean;
  readonly connector: {
    readonly lastSeenAt: Date | null;
    readonly acceptedKinds: readonly string[] | null;
    readonly backDatedRoleStatus: string | null;
    readonly backDatedRoleReportedAt: Date | null;
  };
}

function isFresh(at: Date | null, now: Date): boolean {
  return at !== null && now.getTime() - at.getTime() <= CONNECTOR_HEARTBEAT_MAX_AGE_MS;
}

/** Every unmet boundary; empty means ready. Pure. */
export function evaluateTransferReadiness(e: TransferReadinessEvidence): UnmetTransferReadiness[] {
  const out: UnmetTransferReadiness[] = [];
  if (!isFresh(e.connector.lastSeenAt, e.now)) {
    out.push({ code: 'connector_not_seen', message: 'No recent Connector heartbeat.' });
  }
  const accepted = e.connector.acceptedKinds;
  if (accepted === null || !REQUIRED_KINDS.every((k) => accepted.includes(k))) {
    out.push({
      code: 'connector_version_unlisted',
      message: 'The Connector has not reported that it accepts both transfer work items (transfer_dispatch, transfer_receive).',
    });
  }
  if (!(e.connector.backDatedRoleStatus === 'verified' && isFresh(e.connector.backDatedRoleReportedAt, e.now))) {
    out.push({
      code: 'erp_back_dated_role_unverified',
      message: 'The Connector has not reported a fresh verification of the ERP back-dated stock role.',
    });
  }
  if (!e.hasTransitWarehouse) {
    out.push({ code: 'transit_warehouse_unmapped', message: 'The tenant has no active transit warehouse mapping.' });
  }
  return out;
}

export interface TransferActivationCaller {
  readonly tenantId: string;
  readonly userId: string;
  readonly isPlatformAdmin: boolean;
}

export interface TransferActivationState {
  readonly enabled: boolean;
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly delayedTransferThresholdDays: number;
  readonly unmetReadiness: UnmetTransferReadiness[];
}

interface SwitchRow {
  readonly shipment_transfers_enabled: boolean;
  readonly shipment_transfers_changed_at: Date | null;
  readonly shipment_transfers_changed_by: string | null;
  readonly delayed_transfer_threshold_days: number;
}

async function readSwitch(client: PoolClient, tenantId: string, forUpdate: boolean): Promise<SwitchRow | undefined> {
  const r = await client.query<SwitchRow>(
    `SELECT shipment_transfers_enabled, shipment_transfers_changed_at, shipment_transfers_changed_by,
            delayed_transfer_threshold_days
       FROM tenant_inventory_settings WHERE tenant_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenantId],
  );
  return r.rows[0];
}

async function gatherEvidence(client: PoolClient, tenantId: string, now: Date): Promise<TransferReadinessEvidence> {
  return {
    now,
    hasTransitWarehouse: await hasActiveTransitWarehouse(client, tenantId),
    connector: await latestConnectorEvidence(client, tenantId),
  };
}

function stateOf(row: SwitchRow | undefined, unmet: UnmetTransferReadiness[]): TransferActivationState {
  return {
    enabled: row?.shipment_transfers_enabled ?? false,
    changedAt: row?.shipment_transfers_changed_at ? row.shipment_transfers_changed_at.toISOString() : null,
    changedBy: row?.shipment_transfers_changed_by ?? null,
    delayedTransferThresholdDays: row?.delayed_transfer_threshold_days ?? 3,
    unmetReadiness: unmet,
  };
}

@Injectable()
export class ShipmentTransferActivationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  private async requireOwnerOrAdmin(client: PoolClient, caller: TransferActivationCaller): Promise<void> {
    if (caller.isPlatformAdmin) return;
    const role = await this.memberships.findRoleCodeForUserInTenant(caller.userId, caller.tenantId, client);
    if (role !== 'owner' && role !== 'tenant_admin') {
      throw new ForbiddenException({ code: 'forbidden', message: 'Only an owner or tenant_admin can read or change this switch.' });
    }
  }

  getState(caller: TransferActivationCaller, now: Date = new Date()): Promise<TransferActivationState> {
    return runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, async (client) => {
      await this.requireOwnerOrAdmin(client, caller);
      const row = await readSwitch(client, caller.tenantId, false);
      return stateOf(row, evaluateTransferReadiness(await gatherEvidence(client, caller.tenantId, now)));
    });
  }

  setEnabled(caller: TransferActivationCaller, enabled: boolean, now: Date = new Date()): Promise<TransferActivationState> {
    return runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, async (client) => {
      await this.requireOwnerOrAdmin(client, caller);
      // The same exclusive lock the other settings writers take; the readers hold it shared, so an operation that read
      // the switch ON cannot commit after a concurrent switch-off has counted the Transfers in flight.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`, [
        caller.tenantId,
      ]);
      const existing = await readSwitch(client, caller.tenantId, true);
      const before = existing?.shipment_transfers_enabled ?? false;
      const evidence = await gatherEvidence(client, caller.tenantId, now);
      if (before === enabled) return stateOf(existing, evaluateTransferReadiness(evidence));
      if (enabled) this.assertReady(evidence);
      else await this.assertNoneInFlight(client, caller.tenantId);
      const r = await client.query<SwitchRow>(
        `INSERT INTO tenant_inventory_settings
           (tenant_id, shipment_transfers_enabled, shipment_transfers_changed_at, shipment_transfers_changed_by, updated_by)
         VALUES ($1, $2, now(), $3, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET shipment_transfers_enabled = EXCLUDED.shipment_transfers_enabled,
               shipment_transfers_changed_at = EXCLUDED.shipment_transfers_changed_at,
               shipment_transfers_changed_by = EXCLUDED.shipment_transfers_changed_by,
               updated_by = EXCLUDED.updated_by
         RETURNING shipment_transfers_enabled, shipment_transfers_changed_at, shipment_transfers_changed_by,
                   delayed_transfer_threshold_days`,
        [caller.tenantId, enabled, caller.userId],
      );
      const row = r.rows[0];
      if (!row) throw new Error('ShipmentTransferActivationService: settings upsert returned no row');
      await writeAudit(client, {
        tenantId: caller.tenantId,
        userId: caller.userId,
        action: AUDIT_ACTION,
        targetType: AUDIT_TARGET_TYPE,
        targetId: caller.tenantId,
        metadata: { old: before, new: row.shipment_transfers_enabled },
      });
      return stateOf(row, evaluateTransferReadiness(evidence));
    });
  }

  private assertReady(evidence: TransferReadinessEvidence): void {
    const unmet = evaluateTransferReadiness(evidence);
    if (unmet.length === 0) return;
    throw new ConflictException({
      code: 'shipment_transfers_readiness_unmet',
      message: `Shipment transfers cannot be switched on: ${unmet[0]!.message}`,
      details: { boundary: unmet[0]!.code, unmet },
    });
  }

  private async assertNoneInFlight(client: PoolClient, tenantId: string): Promise<void> {
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM shipment_transfers WHERE tenant_id = $1 AND state = ANY($2::text[])`,
      [tenantId, IN_FLIGHT_TRANSFER_STATES],
    );
    if (Number(r.rows[0]?.n ?? '0') > 0) {
      throw new ConflictException({
        code: 'shipment_transfers_in_flight',
        message: 'Shipment transfers cannot be switched off while a Transfer is in flight.',
      });
    }
  }
}
