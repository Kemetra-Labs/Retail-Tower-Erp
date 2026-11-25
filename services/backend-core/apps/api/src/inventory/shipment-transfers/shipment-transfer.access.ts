/**
 * The shared plumbing of the shipment Transfer commands (RT-1513), as module functions so that both
 * `ShipmentTransfersService` (the HTTP commands) and the `createDraftTransfer` port (RT-1597, run on a caller's client)
 * apply the SAME dark gate, access read, store authority, audit and error mapping. Nothing here opens a transaction:
 * every function runs on the client it is given, inside that client's tenant context (RLS).
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { InvalidCursorError } from '../../common/cursor/opaque-cursor';
import { MembershipRepository, callerStoreScope, findCallerRoleCode, type StoreScope, type TenantContextRequest } from '../../context';
import { writeAudit } from '../position-events/position-event.writer';
import { TransferRuleError, type LegalEntityOf } from './shipment-transfer.rules';
import { loadTransferRow, transferBodyOf, type TransferBody, type TransferRow } from './shipment-transfer.store';

const AUDIT_TARGET = 'shipment_transfer';
export const TENANT_WIDE_ROLES: ReadonlySet<string> = new Set(['owner', 'tenant_admin']);

export type TransferContext = NonNullable<TenantContextRequest['context']>;

export interface TransferCaller {
  readonly tenantId: string;
  readonly userId: string;
  readonly context: TransferContext;
}

export interface CreateTransferInput {
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly reason: string | null;
  readonly lines: readonly {
    readonly tenantProductRef: string;
    readonly quantity: string;
    readonly stockingUnit: string;
    readonly trackingIdentityId: string | null;
  }[];
}

/** The caller's role and store scope, read once per command. */
export interface Access {
  readonly role: string;
  readonly scope: StoreScope;
}

export const inScope = (scope: StoreScope, storeId: string): boolean =>
  scope.kind === 'tenant' || scope.storeIds.includes(storeId.toLowerCase());

/** Map a rule refusal to the HTTP error of the existing envelope. Idempotent: an HTTP error passes through unchanged. */
export function toHttp(err: unknown): unknown {
  if (err instanceof InvalidCursorError) return new BadRequestException({ code: 'validation_error', message: err.message });
  if (!(err instanceof TransferRuleError)) return err;
  if (err.code === 'validation_error') return new BadRequestException({ code: 'validation_error', message: err.message });
  if (err.code === 'forbidden') return new ForbiddenException({ code: 'forbidden', message: err.message });
  return new ConflictException({ code: err.code, message: err.message });
}

/** V1: a store's legal entity is its tenant (see `assertSameLegalEntity`). */
export const tenantOnlyLegalEntity = (tenantId: string): LegalEntityOf => () => tenantId;

/** Dark by default: until the tenant is switched on, every operation is the non-disclosing 404. */
export async function assertShipmentTransfersEnabled(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`, [tenantId]);
  const r = await client.query<{ on: boolean }>(
    `SELECT shipment_transfers_enabled AS on FROM tenant_inventory_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  if (r.rows[0]?.on !== true) throw new NotFoundException('Not Found');
}

/** The caller's role and scope in the tenant; a non-member is the non-disclosing 404. */
export async function readAccess(client: PoolClient, memberships: MembershipRepository, caller: TransferCaller): Promise<Access> {
  const role = await findCallerRoleCode(memberships, client, { tenantId: caller.tenantId, context: caller.context });
  if (role === null) throw new NotFoundException('Not Found');
  const scope = await callerStoreScope(client, memberships, { tenantId: caller.tenantId, context: caller.context });
  return { role, scope };
}

/** The authority to act on one store: owner / tenant_admin everywhere, a store_manager inside its scope. */
export function requireStoreAuthority(a: Access, storeId: string, other?: string): void {
  if (TENANT_WIDE_ROLES.has(a.role) && a.scope.kind === 'tenant') return;
  if (inScope(a.scope, storeId)) return;
  // A caller that cannot see this store but can see the Transfer through the other one: forbidden, not hidden.
  if (other !== undefined && inScope(a.scope, other)) {
    throw new TransferRuleError('forbidden', 'The caller has no authority over this store of the Transfer.');
  }
  throw new NotFoundException('Not Found');
}

/** The audit row of one Transfer command, written in the command's own transaction. */
export async function auditTransfer(
  client: PoolClient,
  caller: TransferCaller,
  action: string,
  transfer: TransferRow,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAudit(client, {
    tenantId: caller.tenantId,
    userId: caller.userId,
    action: `inventory.shipment_transfer.${action}`,
    targetType: AUDIT_TARGET,
    targetId: transfer.id,
    metadata: {
      sourceStoreId: transfer.source_store_id,
      destinationStoreId: transfer.destination_store_id,
      // The same person may create, approve and dispatch: the audit names each actor and says so (2026-11-19).
      selfActioned: transfer.created_by === caller.userId,
      ...metadata,
    },
  });
}

/** The Transfer row, locked (`FOR UPDATE`), or the non-disclosing 404. */
export async function lockedTransferOr404(client: PoolClient, id: string): Promise<TransferRow> {
  const row = await loadTransferRow(client, id, true);
  if (!row) throw new NotFoundException('Not Found');
  return row;
}

/** The Transfer's wire body, or the non-disclosing 404. */
export async function transferBodyOr404(client: PoolClient, id: string): Promise<TransferBody> {
  const body = await transferBodyOf(client, id);
  if (!body) throw new NotFoundException('Not Found');
  return body;
}
