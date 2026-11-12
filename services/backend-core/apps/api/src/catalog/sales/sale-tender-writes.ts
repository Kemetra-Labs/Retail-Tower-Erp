/**
 * RT-77 / RT-360 sale tender writes and checks, run on the capture's
 * tenant-context transaction client (RLS). Moved unchanged from
 * `sales.service.ts` (RT-1295).
 *
 *   - {@link assertTendersMatchTotal}: the tenders sum to the POS total exactly
 *     (Postgres numeric), else 422.
 *   - {@link insertTenders}: one `sale_tenders` row per tender line.
 *   - {@link assertSameTenders}: a provenance replay carries the recorded
 *     tenders (multiset comparison), else 409.
 *   - {@link assertVoucherTendersRedeemed} (RT-1114): every `voucher` tender
 *     names a live, unused redemption of this tenant and store, for exactly its
 *     amount in the sale's currency, else 422.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import type { SaleTenderDto } from "./dto/capture-sale-request.dto";
import { minorUnitExponent } from "./iso4217-minor-units";
import { SaleTenderMismatchError, SaleTenderReplayConflictError, SaleVoucherTenderInvalidError } from "./sale-errors";

/** RT-77: Σ tender amounts = posTotal exactly, in Postgres numeric; else 422. */
export async function assertTendersMatchTotal(
  client: PoolClient,
  tenders: ReadonlyArray<SaleTenderDto>,
  posTotal: string,
): Promise<void> {
  const r = await client.query<{ matches: boolean }>(
    `SELECT (SELECT SUM(a) FROM unnest($1::numeric[]) a) = $2::numeric AS matches`,
    [tenders.map((t) => t.amount), posTotal],
  );
  if (r.rows[0]?.matches !== true) throw new SaleTenderMismatchError();
}

/** RT-77: write the sale's tenders in its capture transaction (one row per tender line). */
export async function insertTenders(
  client: PoolClient,
  sale: {
    readonly saleId: string;
    readonly tenantId: string;
    readonly storeId: string;
    readonly currencyCode: string;
    readonly tenders: ReadonlyArray<SaleTenderDto>;
  },
): Promise<void> {
  const { tenders } = sale;
  await client.query(
    `INSERT INTO sale_tenders
       (id, sale_id, tenant_id, store_id, method, amount, currency_code, reference,
        tender_ref, sequence, redemption_id)
     SELECT t.id, $1, $2, $3, t.method, t.amount, $4, t.reference, t.tender_ref, t.sequence, t.redemption_id
       FROM unnest($5::uuid[], $6::text[], $7::numeric[], $8::text[], $9::uuid[], $10::smallint[], $11::uuid[])
            AS t(id, method, amount, reference, tender_ref, sequence, redemption_id)`,
    [
      sale.saleId,
      sale.tenantId,
      sale.storeId,
      sale.currencyCode,
      tenders.map(() => newId()),
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map(tenderReference),
      tenders.map((t) => t.tenderRef ?? null),
      tenders.map((t) => t.sequence ?? null),
      tenders.map(tenderRedemption),
    ],
  );
}

/**
 * RT-77: a provenance replay must carry the tenders that were recorded —
 * compared by (method, numeric amount, reference, tenderRef, sequence and,
 * RT-1114, the voucher's redemption), so
 * "10.5" and "10.5000" are the same tender. RT-360: compared as a MULTISET
 * (`EXCEPT ALL`) with the line identity included, so tenders that share a
 * method can neither swap amounts nor collapse into one another unnoticed.
 * A difference is a different payload (409).
 * The stored `tender_count` settles the common cases without reading
 * sale_tenders: both empty (every legacy replay) is the same payload, and a
 * different count is a conflict.
 */
export async function assertSameTenders(
  client: PoolClient,
  winner: { readonly id: string; readonly tender_count: number },
  tenders: ReadonlyArray<SaleTenderDto>,
): Promise<void> {
  if (winner.tender_count !== tenders.length) throw new SaleTenderReplayConflictError();
  if (tenders.length === 0) return;
  const saleId = winner.id;
  const r = await client.query<{ same: boolean }>(
    `WITH req AS (
       SELECT * FROM unnest($2::text[], $3::numeric[], $4::text[], $5::uuid[], $6::smallint[], $7::uuid[])
              AS r(method, amount, reference, tender_ref, sequence, redemption_id)
     ), stored AS (
       SELECT method, amount::numeric AS amount, reference, tender_ref, sequence, redemption_id
         FROM sale_tenders WHERE sale_id = $1
     )
     SELECT NOT EXISTS (
       (SELECT method, amount, reference, tender_ref, sequence, redemption_id FROM req
        EXCEPT ALL SELECT method, amount, reference, tender_ref, sequence, redemption_id FROM stored)
       UNION ALL
       (SELECT method, amount, reference, tender_ref, sequence, redemption_id FROM stored
        EXCEPT ALL SELECT method, amount, reference, tender_ref, sequence, redemption_id FROM req)
     ) AS same`,
    [
      saleId,
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map(tenderReference),
      tenders.map((t) => t.tenderRef ?? null),
      tenders.map((t) => t.sequence ?? null),
      tenders.map(tenderRedemption),
    ],
  );
  if (r.rows[0]?.same !== true) throw new SaleTenderReplayConflictError();
}

/** A tender's reference, or null — only card_external carries one. */
function tenderReference(t: SaleTenderDto): string | null {
  return t.method === "card_external" ? (t.reference ?? null) : null;
}

/** RT-1114: a tender's redemption, or null — only a voucher carries one. */
function tenderRedemption(t: SaleTenderDto): string | null {
  return t.method === "voucher" ? t.redemptionId : null;
}

/**
 * RT-1114 (RT-1098 R-4a, acceptance 1): every `voucher` tender references a
 * redemption that is, at this capture:
 *   - of this tenant (RLS and an explicit `tenant_id`) and of the sale's store;
 *   - un-reversed (`reversed_at IS NULL`);
 *   - not already paying another sale tender (one redemption, one tender);
 *   - for a voucher in the sale's currency, with `applied_amount_minor` equal
 *     to the tender's amount in that currency's minor units (exact numeric).
 * Any miss is one 422 `sale_voucher_tender_invalid`, never naming which, and
 * nothing is recorded. Runs only on a first capture (a replay compares the
 * recorded tenders instead) and only when the sale has a voucher tender.
 *
 * Concurrency: the redemption rows are locked first, in id order
 * (`FOR NO KEY UPDATE`, the domain role's column-level UPDATE allows it), so
 * two captures naming one redemption run one after the other. The checks are
 * a SEPARATE statement, so under READ COMMITTED they see a competing capture
 * that committed while this one waited on the lock.
 * `uq_sale_tenders_tenant_redemption` (0102) stays the database backstop.
 * NOT covered here: a reverse (R-3) of the same redemption only waits for
 * this capture to end, then still succeeds. Refusing to reverse a redemption
 * that a sale tender uses is a recorded follow-up (RT-1114 c16673, 3c) that
 * must land before `POS_SALE_VOUCHER_TENDER_ENABLED` is turned on.
 */
export async function assertVoucherTendersRedeemed(
  client: PoolClient,
  sale: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly currencyCode: string;
    readonly tenders: ReadonlyArray<SaleTenderDto>;
  },
): Promise<void> {
  const vouchers = sale.tenders.flatMap((t) => (t.method === "voucher" ? [t] : []));
  if (vouchers.length === 0) return;
  const exponent = minorUnitExponent(sale.currencyCode);
  if (exponent === null) throw new SaleVoucherTenderInvalidError();
  const ids = vouchers.map((t) => t.redemptionId);
  await client.query(
    `SELECT id FROM voucher_redemptions
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
        FOR NO KEY UPDATE`,
    [sale.tenantId, ids],
  );
  const r = await client.query<{ valid: number }>(
    `SELECT count(*)::int AS valid
       FROM unnest($2::uuid[], $3::numeric[]) AS q(redemption_id, amount)
       JOIN voucher_redemptions r ON r.tenant_id = $1 AND r.id = q.redemption_id
       JOIN vouchers v ON v.tenant_id = r.tenant_id AND v.id = r.voucher_id
      WHERE r.store_id = $4
        AND r.reversed_at IS NULL
        AND v.currency_code = $5
        AND q.amount * power(10::numeric, $6::int) = r.applied_amount_minor
        AND NOT EXISTS (
          SELECT 1 FROM sale_tenders t WHERE t.tenant_id = $1 AND t.redemption_id = r.id)`,
    [sale.tenantId, ids, vouchers.map((t) => t.amount), sale.storeId, sale.currencyCode, exponent],
  );
  if (r.rows[0]?.valid !== vouchers.length) throw new SaleVoucherTenderInvalidError();
}
