/**
 * The read SQL and the keyset cursor of the voucher reads (RT-1108).
 *
 * The effective status is derived here, once (RT-922 section 5.4): a stored
 * `active` voucher whose `expires_at` has passed reads `expired`, and the
 * `status` filter compares against the same expression, so `status=active`
 * excludes an expired voucher and `status=expired` includes it. No statement
 * selects `code_hash`.
 *
 * Newest first by `(created_at, id)` DESC (`idx_vouchers_tenant_created`). The
 * cursor carries `created_at` as Postgres text at microsecond precision (a JS
 * Date would round to milliseconds and skip or repeat rows within a batch), with an
 * explicit `Z`, so it is independent of the session and process time zones.
 */
import { z } from "zod";

import { decodeOpaque, encodeOpaque, InvalidCursorError, isCalendarInstant } from "../common/cursor/opaque-cursor";

const EFFECTIVE_STATUS = `CASE WHEN v.status = 'active' AND v.expires_at IS NOT NULL AND v.expires_at <= now()
                               THEN 'expired' ELSE v.status END`;

const VOUCHER_COLUMNS = `v.id::text AS id, v.batch_id::text AS batch_id, v.amount_minor, v.currency_code,
       ${EFFECTIVE_STATUS} AS status, v.expires_at, v.applies_to_all_stores,
       ARRAY(SELECT e.store_id::text FROM voucher_eligible_stores e
              WHERE e.tenant_id = v.tenant_id AND e.voucher_id = v.id ORDER BY e.store_id) AS eligible_store_ids,
       v.note, v.created_at, v.cancelled_at`;

/**
 * RT-1108 review: the caller's store authority over a voucher ("the role never
 * widens a membership", RT-131). `allParam` is a boolean (tenant-wide scope) and
 * `storesParam` the scoped store ids. A tenant-wide caller has authority over
 * every voucher; a store-scoped one only over a subset voucher whose eligible
 * stores are ALL in scope. An all-stores voucher, or a subset voucher with any
 * out-of-scope store, is out of authority: it reads as absent (404, never listed).
 * In the SQL, so pagination stays correct.
 */
export function authoritySql(allParam: string, storesParam: string): string {
  return `(${allParam}::boolean OR (NOT v.applies_to_all_stores AND NOT EXISTS (
            SELECT 1 FROM voucher_eligible_stores a
             WHERE a.tenant_id = v.tenant_id AND a.voucher_id = v.id
               AND NOT (a.store_id = ANY(${storesParam}::uuid[])))))`;
}

/** $1 tenant, $2 voucher, $3 tenant-wide scope, $4 scoped store ids. */
export const GET_SQL = `SELECT ${VOUCHER_COLUMNS}
  FROM vouchers v
 WHERE v.tenant_id = $1 AND v.id = $2 AND ${authoritySql("$3", "$4")}`;

/** The cancel's re-read after a lost conditional update: $1 tenant, $2 voucher, $3 tenant-wide, $4 stores. */
export const RECHECK_SQL = `SELECT v.status, v.cancelled_at FROM vouchers v
 WHERE v.tenant_id = $1 AND v.id = $2 AND ${authoritySql("$3", "$4")}`;

/** The cancel's conditional update: $1 tenant, $2 voucher, $3 actor, $4 tenant-wide, $5 stores. */
export const CANCEL_SQL = `UPDATE vouchers v
    SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $3
  WHERE v.tenant_id = $1 AND v.id = $2 AND v.status = 'active' AND ${authoritySql("$4", "$5")}
  RETURNING v.batch_id::text AS batch_id, v.cancelled_at`;

/** $1 tenant, $2 status, $3 batch, $4 store, $5 expires_from, $6 expires_before, $7/$8 cursor, $9 limit + 1, $10 tenant-wide, $11 stores. */
export const LIST_SQL = `SELECT ${VOUCHER_COLUMNS},
       to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
  FROM vouchers v
 WHERE v.tenant_id = $1
   AND ($2::text IS NULL OR ${EFFECTIVE_STATUS} = $2::text)
   AND ($3::uuid IS NULL OR v.batch_id = $3::uuid)
   AND ($4::uuid IS NULL OR (
         EXISTS (SELECT 1 FROM stores s WHERE s.tenant_id = v.tenant_id AND s.id = $4::uuid)
         AND (v.applies_to_all_stores OR EXISTS (
               SELECT 1 FROM voucher_eligible_stores e
                WHERE e.tenant_id = v.tenant_id AND e.voucher_id = v.id AND e.store_id = $4::uuid))))
   AND ($5::timestamptz IS NULL OR v.expires_at >= $5::timestamptz)
   AND ($6::timestamptz IS NULL OR v.expires_at < $6::timestamptz)
   AND ($7::timestamptz IS NULL OR (v.created_at, v.id) < ($7::timestamptz, $8::uuid))
   AND ${authoritySql("$10", "$11")}
 ORDER BY v.created_at DESC, v.id DESC
 LIMIT $9`;

export class InvalidVoucherCursorError extends InvalidCursorError {}

const CursorSchema = z.object({ c: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), i: z.string().uuid() }).strict();

interface VoucherKeyset {
  readonly createdAtKey: string;
  readonly voucherId: string;
}

export function encodeVoucherCursor(createdAtKey: string, voucherId: string): string {
  return encodeOpaque({ c: createdAtKey, i: voucherId });
}

/** A cursor this list did not issue throws `InvalidVoucherCursorError` (a 400). */
export function decodeVoucherCursor(raw: string): VoucherKeyset {
  const payload = decodeOpaque(raw, CursorSchema, () => new InvalidVoucherCursorError());
  if (!isCalendarInstant(payload.c)) throw new InvalidVoucherCursorError();
  return { createdAtKey: payload.c, voucherId: payload.i };
}
