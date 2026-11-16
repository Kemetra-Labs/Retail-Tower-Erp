/**
 * Opaque keyset cursors of the Count Session lists (RT-1420). Each cursor is
 * bound to the operation, the store, the session (when the path has one) and
 * the filter it was issued for; a cursor presented anywhere else, or a
 * malformed one, is a 400 (`InvalidCursorError`).
 */
import { z } from 'zod';

import { decodeOpaque, encodeOpaque, InvalidCursorError } from '../../common/cursor/opaque-cursor';

type CountCursorOperation = 'sessions' | 'lines' | 'findings';

export interface CountCursorBinding {
  readonly operation: CountCursorOperation;
  readonly storeId: string;
  readonly sessionId: string | null;
  /** The filter the page was read with (`state`, `flagged`), or null. */
  readonly filter: string | null;
}

export interface CountCursorPosition {
  /** Timestamp text or product id: the first sort key. */
  readonly a: string;
  /** The row id, or empty for the lines list. */
  readonly b: string;
}

const PayloadSchema = z
  .object({
    o: z.enum(['sessions', 'lines', 'findings']),
    s: z.string().uuid(),
    n: z.string().uuid().nullable(),
    f: z.string().max(64).nullable(),
    a: z.string().min(1).max(64),
    b: z.string().max(64),
  })
  .strict();

export function encodeCountCursor(
  binding: CountCursorBinding,
  position: CountCursorPosition,
): string {
  return encodeOpaque({
    o: binding.operation,
    s: binding.storeId.toLowerCase(),
    n: binding.sessionId?.toLowerCase() ?? null,
    f: binding.filter,
    a: position.a,
    b: position.b,
  });
}

export function decodeCountCursor(token: string, binding: CountCursorBinding): CountCursorPosition {
  const d = decodeOpaque(token, PayloadSchema, () => new InvalidCursorError());
  const sameBinding =
    d.o === binding.operation &&
    d.s === binding.storeId.toLowerCase() &&
    d.n === (binding.sessionId?.toLowerCase() ?? null) &&
    d.f === binding.filter;
  if (!sameBinding) throw new InvalidCursorError();
  return { a: d.a, b: d.b };
}
