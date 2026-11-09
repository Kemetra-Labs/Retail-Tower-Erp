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
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import type { SaleTenderDto } from "./dto/capture-sale-request.dto";
import { SaleTenderMismatchError, SaleTenderReplayConflictError } from "./sale-errors";

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
        tender_ref, sequence)
     SELECT t.id, $1, $2, $3, t.method, t.amount, $4, t.reference, t.tender_ref, t.sequence
       FROM unnest($5::uuid[], $6::text[], $7::numeric[], $8::text[], $9::uuid[], $10::smallint[])
            AS t(id, method, amount, reference, tender_ref, sequence)`,
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
    ],
  );
}

/**
 * RT-77: a provenance replay must carry the tenders that were recorded —
 * compared by (method, numeric amount, reference, tenderRef, sequence), so
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
       SELECT * FROM unnest($2::text[], $3::numeric[], $4::text[], $5::uuid[], $6::smallint[])
              AS r(method, amount, reference, tender_ref, sequence)
     ), stored AS (
       SELECT method, amount::numeric AS amount, reference, tender_ref, sequence
         FROM sale_tenders WHERE sale_id = $1
     )
     SELECT NOT EXISTS (
       (SELECT method, amount, reference, tender_ref, sequence FROM req
        EXCEPT ALL SELECT method, amount, reference, tender_ref, sequence FROM stored)
       UNION ALL
       (SELECT method, amount, reference, tender_ref, sequence FROM stored
        EXCEPT ALL SELECT method, amount, reference, tender_ref, sequence FROM req)
     ) AS same`,
    [
      saleId,
      tenders.map((t) => t.method),
      tenders.map((t) => t.amount),
      tenders.map(tenderReference),
      tenders.map((t) => t.tenderRef ?? null),
      tenders.map((t) => t.sequence ?? null),
    ],
  );
  if (r.rows[0]?.same !== true) throw new SaleTenderReplayConflictError();
}

/** A tender's reference, or null — only card_external carries one. */
function tenderReference(t: SaleTenderDto): string | null {
  return t.method === "card_external" ? (t.reference ?? null) : null;
}
