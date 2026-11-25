/**
 * RT-1597 — create a Draft shipment Transfer on the CALLER's client (RT-1513 create, 800-802, 962, 963, G7-4).
 *
 * `ShipmentTransfersService.create` opens its own transaction, so a caller that must make a draft atomic with its own
 * writes (W9 redistribution accept, RT-1596 §3.1) could not use it. This port is that same logic, run inside whatever
 * transaction the client is in: if the caller rolls back, the Transfer, its lines and its audit row go with it. The
 * HTTP `create` path calls this port inside its own `runWithTenantContext`, so both paths are one implementation.
 *
 * Order (unchanged from RT-1513): the pure input rules (two different stores, 1..TRANSFER_LINE_MAX lines, each product
 * and identity once, a stocking unit) → the dark gate → the caller's access → authority over both stores → the
 * legal-entity rule → quantities, tracking shape and units → the inserts → the audit.
 *
 * Errors are the HTTP errors of the existing envelope (`toHttp`): the non-disclosing 404, a 400 `validation_error`,
 * a 403 `forbidden` or a 409 with the rule's code, so a caller that is itself an HTTP command answers exactly as the
 * Transfer endpoint would. No idempotency key is kept here: the caller owns replay safety for its own command.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { trackingModesOfProducts } from '../../catalog';
import { formatQuantity, parseQuantity } from '../../common/quantity/decimal-quantity';
import type { MembershipRepository } from '../../context';
import { authorizeDestinationStoreAccess } from '../destination-store-access';
import { assertReferencesInTenant, assertUnitMatchesEstablished } from '../inventory-write.helpers';
import {
  assertShipmentTransfersEnabled,
  auditTransfer,
  lockedTransferOr404,
  readAccess,
  requireStoreAuthority,
  tenantOnlyLegalEntity,
  toHttp,
  transferBodyOr404,
  type CreateTransferInput,
  type TransferCaller,
} from './shipment-transfer.access';
import { TRANSFER_LINE_MAX, TransferRuleError, assertErpQuantity, assertSameLegalEntity } from './shipment-transfer.rules';
import type { TransferBody } from './shipment-transfer.store';

/** What the port needs besides the client: the membership reads behind the caller's role and store scope. */
export interface DraftTransferDeps {
  readonly memberships: MembershipRepository;
}

/** The pure input rules of a Draft (no database): run before any transaction is opened on the HTTP path. */
export function assertDraftInputShape(input: CreateTransferInput): void {
  if (input.sourceStoreId === input.destinationStoreId) {
    throw new BadRequestException({ code: 'validation_error', message: 'source and destination stores must differ' });
  }
  if (input.lines.length < 1 || input.lines.length > TRANSFER_LINE_MAX) {
    throw new BadRequestException({ code: 'validation_error', message: `a Transfer has 1..${TRANSFER_LINE_MAX} lines` });
  }
  const keys = new Set<string>();
  for (const l of input.lines) {
    const key = `${l.tenantProductRef}:${l.trackingIdentityId ?? ''}`;
    if (keys.has(key)) {
      throw new BadRequestException({ code: 'validation_error', message: 'a product (and identity) may appear once per Transfer' });
    }
    keys.add(key);
    if (l.stockingUnit.trim().length === 0) {
      throw new BadRequestException({ code: 'validation_error', message: 'stockingUnit is required' });
    }
  }
}

/**
 * Create one Draft Transfer on `client`, in the client's current transaction and tenant context. Reserves nothing and
 * moves no quantity (806). Returns the Transfer's wire body.
 */
export async function createDraftTransfer(
  client: PoolClient,
  caller: TransferCaller,
  input: CreateTransferInput,
  deps: DraftTransferDeps,
): Promise<TransferBody> {
  try {
    assertDraftInputShape(input);
    await assertShipmentTransfersEnabled(client, caller.tenantId);
    const a = await readAccess(client, deps.memberships, caller);
    // Both stores resolve inside the tenant (RLS): a store of another tenant is the non-disclosing 404.
    await assertReferencesInTenant(client, { storeIds: [input.sourceStoreId, input.destinationStoreId] });
    // Authority over BOTH stores (962): the source in the caller's scope, the destination within its membership.
    requireStoreAuthority(a, input.sourceStoreId);
    authorizeDestinationStoreAccess(caller.context, input.destinationStoreId);
    assertSameLegalEntity(tenantOnlyLegalEntity(caller.tenantId), input.sourceStoreId, input.destinationStoreId);

    const parsed = input.lines.map((l) => {
      const q = parseQuantity(l.quantity, 'quantity');
      if (q <= 0n) throw new BadRequestException({ code: 'validation_error', message: 'quantity must be strictly positive' });
      assertErpQuantity(q, 'quantity');
      return { ...l, scaled: q, stockingUnit: l.stockingUnit.trim() };
    });
    await assertTrackingShape(client, parsed);
    for (const l of parsed) {
      await assertReferencesInTenant(client, { storeIds: [input.sourceStoreId], tenantProductRef: l.tenantProductRef });
      await assertUnitMatchesEstablished(client, input.sourceStoreId, l.tenantProductRef, l.stockingUnit);
      await assertUnitMatchesEstablished(client, input.destinationStoreId, l.tenantProductRef, l.stockingUnit);
    }

    const id = newId();
    await client.query(
      `INSERT INTO shipment_transfers (id, tenant_id, source_store_id, destination_store_id, state, reason, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
      [id, caller.tenantId, input.sourceStoreId, input.destinationStoreId, input.reason, caller.userId],
    );
    for (let i = 0; i < parsed.length; i += 1) {
      const l = parsed[i]!;
      await client.query(
        `INSERT INTO shipment_transfer_lines
           (id, tenant_id, transfer_id, line_seq, tenant_product_ref, stocking_unit, tracking_identity_id, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric(19,4))`,
        [newId(), caller.tenantId, id, i + 1, l.tenantProductRef, l.stockingUnit, l.trackingIdentityId, formatQuantity(l.scaled)],
      );
    }
    const row = await lockedTransferOr404(client, id);
    await auditTransfer(client, caller, 'create', row, { lineCount: parsed.length });
    return await transferBodyOr404(client, id);
  } catch (err) {
    throw toHttp(err);
  }
}

/** G7-4: one tracking identity per tracked line; serial is refused until the serial gate. */
async function assertTrackingShape(
  client: PoolClient,
  lines: readonly { tenantProductRef: string; trackingIdentityId: string | null }[],
): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.tenantProductRef))];
  const mode = await trackingModesOfProducts(client, ids);
  if (mode.size !== ids.length) throw new NotFoundException('Not Found');
  for (const l of lines) {
    const m = mode.get(l.tenantProductRef)!;
    if (m === 'serial') {
      throw new TransferRuleError('serial_transfer_not_supported', 'Serial products cannot be transferred until the serial gate.');
    }
    if (m === 'batch' && l.trackingIdentityId === null) {
      throw new TransferRuleError('tracking_identity_required', 'A tracked product needs one tracking identity per line.');
    }
    if (m === 'none' && l.trackingIdentityId !== null) {
      throw new TransferRuleError('validation_error', 'trackingIdentityId must be null for an untracked product.');
    }
  }
  const identityIds = lines.flatMap((l) => (l.trackingIdentityId ? [l.trackingIdentityId] : []));
  if (identityIds.length > 0) {
    const found = await client.query<{ id: string; tenant_product_ref: string }>(
      `SELECT id, tenant_product_ref FROM tracking_identities WHERE id = ANY($1::uuid[])`,
      [identityIds],
    );
    const owner = new Map(found.rows.map((r) => [r.id, r.tenant_product_ref] as const));
    for (const l of lines) {
      if (l.trackingIdentityId !== null && owner.get(l.trackingIdentityId) !== l.tenantProductRef) {
        throw new TransferRuleError('validation_error', "trackingIdentityId is not an identity of the line's product.");
      }
    }
  }
}
