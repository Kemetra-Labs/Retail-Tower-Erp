/**
 * Opaque keyset cursors of the inventory safety history lists — Jira RT-1081
 * (`listTrackingHolds`, `listInventoryRecalls`,
 * `listTrackingIdentityExpiryCorrections`; inventory.yaml 1.10.0-draft).
 *
 * Each list is ordered newest first by `(<instant> DESC, id DESC)`. The repo
 * convention (`movement-list.cursor.ts`, RT-731): unsigned base64url JSON bound
 * to the operation, the tenant and a digest of every (normalized) filter; any
 * other token is refused (`SafetyHistoryCursorError` → 400). It carries only
 * the keyset position. The caller's role is never in it: the controller checks
 * the role on every page and the service ANDs the position with the tenant and
 * the filters, so a hand-built token can only reposition the walk inside rows
 * the caller may already read.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { decodeOpaque, encodeOpaque } from '../../common/cursor/opaque-cursor';
import { KEY_INSTANT, LOWER_UUID, namesRealInstant } from '../../console-sales/console-sales.query';

export class SafetyHistoryCursorError extends Error {
  constructor() {
    super('cursor is not a valid continuation token for this query');
    this.name = 'SafetyHistoryCursorError';
  }
}

export type SafetyHistoryOperation = 'tracking_holds' | 'inventory_recalls' | 'expiry_corrections';

/** What a cursor is bound to: the tenant and the normalized filters, in a fixed order. */
export interface SafetyHistoryCursorBinding {
  readonly op: SafetyHistoryOperation;
  readonly tenantId: string;
  readonly filters: ReadonlyArray<string | null>;
}

/** The last row of a page: `atKey` is UTC with six fractional digits (microseconds). */
export interface SafetyHistoryKeyset {
  readonly atKey: string;
  readonly id: string;
}

/** The SQL that renders an instant column as a cursor key (microsecond, UTC). */
export function instantKeySql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const CursorPayload = z
  .object({
    op: z.enum(['tracking_holds', 'inventory_recalls', 'expiry_corrections']),
    tenant: z.string().regex(LOWER_UUID),
    digest: z.string().min(1),
    at: z.string().regex(KEY_INSTANT).refine(namesRealInstant),
    id: z.string().regex(LOWER_UUID),
  })
  .strict();

type CursorPayload = z.infer<typeof CursorPayload>;

function digestOf(binding: SafetyHistoryCursorBinding): string {
  const ordered = binding.filters.map((f) => (f === null ? null : f.toLowerCase()));
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('base64url').slice(0, 22);
}

export function encodeSafetyHistoryCursor(binding: SafetyHistoryCursorBinding, keyset: SafetyHistoryKeyset): string {
  const payload: CursorPayload = {
    op: binding.op,
    tenant: binding.tenantId.toLowerCase(),
    digest: digestOf(binding),
    at: keyset.atKey,
    id: keyset.id.toLowerCase(),
  };
  return encodeOpaque(payload);
}

/** The keyset position of `cursor`, or SafetyHistoryCursorError when it was not issued for `binding`. */
export function decodeSafetyHistoryCursor(binding: SafetyHistoryCursorBinding, cursor: string): SafetyHistoryKeyset {
  const p = decodeOpaque(cursor, CursorPayload, () => new SafetyHistoryCursorError());
  const boundHere =
    p.op === binding.op && p.tenant === binding.tenantId.toLowerCase() && p.digest === digestOf(binding);
  if (!boundHere) throw new SafetyHistoryCursorError();
  return { atKey: p.at, id: p.id };
}
