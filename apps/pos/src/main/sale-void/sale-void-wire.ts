/**
 * RT-530 — the `recordVoid` request body (`pos-sales/sales.yaml` 1.8.0-draft,
 * Backend-Core PR "manager-approved sale void").
 *
 * The body is REBUILT from the journal row and the sale's stored server
 * reference on every send, with a fixed key order, so every retry is the
 * byte-identical request under the same Idempotency-Key (the journal row's
 * `external_id`). It carries the bound approval evidence only: ids, the
 * policy version, times, the sale total as an exact decimal and the business
 * day. Never a PIN, an envelope or a name.
 */
import { SOURCE_SYSTEM } from '../sales-sync/capture-payload.js';
import { exponentFor, minorUnitsToDecimalString } from '../sales-sync/create-sale-sync-client.js';
import type { VoidEntry } from './sale-void-repository.js';

/** The only action a void approval is bound to. */
export const SALE_VOID_APPROVAL_ACTION = 'sale.void' as const;

export interface VoidApprovalWire {
  approvalId: string;
  action: typeof SALE_VOID_APPROVAL_ACTION;
  saleRef: string;
  amount: string;
  requesterUserId: string;
  approverUserId: string;
  policyVersion: string;
  approvedAt: string;
}

export interface RecordVoidWireBody {
  sourceSystem: string;
  externalId: string;
  businessDate: string;
  approval: VoidApprovalWire;
  /**
   * RT-1403 (RT-530 c12029): the requesting cashier's `users.id`, present ONLY on the device
   * path (a cashier's void is sent with the device bearer). Its presence is what selects that
   * credential on Backend-Core, so an envelope body never carries it.
   */
  operatorUserId?: string;
}

/** Which credential carries the void: the requester's envelope, or the device bearer (cashier). */
export type VoidCredentialPath = 'envelope' | 'device';

/** The request body of one journaled void, for the sale's server reference. */
export function buildVoidBody(
  entry: VoidEntry,
  saleRef: string,
  path: VoidCredentialPath = 'envelope',
): RecordVoidWireBody {
  const body: RecordVoidWireBody = {
    sourceSystem: SOURCE_SYSTEM,
    externalId: entry.externalId,
    businessDate: entry.businessDate,
    approval: {
      approvalId: entry.approvalId,
      action: SALE_VOID_APPROVAL_ACTION,
      saleRef,
      amount: minorUnitsToDecimalString(entry.amountMinor, exponentFor(entry.currencyCode)),
      requesterUserId: entry.requesterUserId,
      approverUserId: entry.approverUserId,
      policyVersion: entry.policyVersion,
      approvedAt: entry.approvedAt,
    },
  };
  // Appended last: the envelope bytes are unchanged and the device bytes differ only by this key.
  if (path === 'device') body.operatorUserId = entry.requesterUserId;
  return body;
}

/** The exact bytes sent (stable key order: the object literal order above). */
export function buildVoidBodyJson(
  entry: VoidEntry,
  saleRef: string,
  path: VoidCredentialPath = 'envelope',
): string {
  return JSON.stringify(buildVoidBody(entry, saleRef, path));
}
