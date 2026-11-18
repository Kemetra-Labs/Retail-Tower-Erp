/**
 * Opaque keyset cursor of `tenantAdminListErpnextItemMappings` (RT-1458, audit A-17).
 *
 * The list is ordered `suggested_at DESC, id` and a page ends at its last row, so the cursor
 * carries that row's `(suggested_at, id)`. `suggested_at` travels as the microsecond-precision
 * UTC text Postgres formatted (`to_char(... 'US')`): a JS `Date` keeps milliseconds only, and
 * rows suggested in one transaction share a `now()` to the microsecond, so a Date round trip
 * would skip or repeat rows at a page boundary. Shared codec: `common/cursor/opaque-cursor`
 * (RT-1213). The cursor holds no tenant: RLS scopes every query, so a cursor presented under
 * another tenant just continues that tenant's own list.
 */
import { z } from "zod";

import {
  decodeOpaque,
  encodeOpaque,
  InvalidCursorError,
  isCalendarInstant,
} from "../../common/cursor/opaque-cursor";

/** A cursor this list did not issue (a 400). */
export class InvalidItemMapCursorError extends InvalidCursorError {}

const CursorSchema = z
  .object({
    s: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    i: z.string().uuid(),
  })
  .strict();

export interface ItemMapKeyset {
  /** `suggested_at` as UTC text with microseconds, e.g. `2026-11-18T10:15:30.123456Z`. */
  readonly suggestedAtKey: string;
  readonly id: string;
}

export function encodeItemMapCursor(suggestedAtKey: string, id: string): string {
  return encodeOpaque({ s: suggestedAtKey, i: id });
}

/** A token this list did not issue throws `InvalidItemMapCursorError`. */
export function decodeItemMapCursor(raw: string): ItemMapKeyset {
  const payload = decodeOpaque(raw, CursorSchema, () => new InvalidItemMapCursorError());
  if (!isCalendarInstant(payload.s)) throw new InvalidItemMapCursorError();
  return { suggestedAtKey: payload.s, id: payload.i };
}
