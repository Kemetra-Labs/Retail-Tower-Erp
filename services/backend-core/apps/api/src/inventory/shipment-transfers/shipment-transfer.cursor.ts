/**
 * Opaque keyset cursors of the shipment Transfer lists (RT-1513). Each cursor is bound to the operation, the
 * tenant, the Transfer (for the receipt list) and the filters it was issued for; a cursor presented anywhere
 * else, or a malformed one, is a 400 (`InvalidCursorError`).
 */
import { z } from 'zod';

import { decodeOpaque, encodeOpaque, InvalidCursorError } from '../../common/cursor/opaque-cursor';

type TransferCursorOperation = 'transfers' | 'receipts';

export interface TransferCursorBinding {
  readonly operation: TransferCursorOperation;
  readonly tenantId: string;
  /** The Transfer of a receipt list; null for the Transfer list. */
  readonly transferId: string | null;
  /** The filters the page was read with, joined, or null. */
  readonly filter: string | null;
}

export interface TransferCursorPosition {
  /** UTC ISO text of the first sort key (`created_at`, or `received_at` for receipts). */
  readonly a: string;
  /** The row id. */
  readonly b: string;
}

const PayloadSchema = z
  .object({
    o: z.enum(['transfers', 'receipts']),
    t: z.string().uuid(),
    n: z.string().uuid().nullable(),
    f: z.string().max(200).nullable(),
    a: z.string().min(1).max(40),
    b: z.string().uuid(),
  })
  .strict();

export function encodeTransferCursor(binding: TransferCursorBinding, position: TransferCursorPosition): string {
  return encodeOpaque({
    o: binding.operation,
    t: binding.tenantId.toLowerCase(),
    n: binding.transferId?.toLowerCase() ?? null,
    f: binding.filter,
    a: position.a,
    b: position.b,
  });
}

export function decodeTransferCursor(token: string, binding: TransferCursorBinding): TransferCursorPosition {
  const d = decodeOpaque(token, PayloadSchema, () => new InvalidCursorError());
  const same =
    d.o === binding.operation &&
    d.t === binding.tenantId.toLowerCase() &&
    d.n === (binding.transferId?.toLowerCase() ?? null) &&
    d.f === binding.filter;
  // The position must parse as an instant, or the SQL cast would be a 500 instead of the 400.
  if (!same || Number.isNaN(Date.parse(d.a))) throw new InvalidCursorError();
  return { a: d.a, b: d.b };
}

