/**
 * Loads the returns of one sale as the replay of `offers/evaluator/offer-return-history.ts` needs them (spec 048 §9,
 * OD-11): the promoted lines of the sale with the discount of one unit, and each recorded return's returned units and
 * clawbacks in `return_seq` order. Used by admission (all returns of the sale, serialised under the sale lock) and by
 * the feed projection (up to and including the stored return).
 */
import type { PoolClient } from "pg";

import { scaled, wholeUnits } from "../../offers/evaluator/offer-decimal";
import { replayReturns, type HistoryLine, type HistoryStep, type ReplayResult } from "../../offers/evaluator/offer-return-history";

/** A promoted line of a sale that does not divide into whole units (never reachable from valid data). */
class SaleReturnHistoryInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleReturnHistoryInvariantError";
  }
}

/**
 * The replay of the sale's returns with `return_seq` up to `upToSeq` (all of them when null). Reads nothing of a sale
 * that has no clawback recorded in that range: with no outstanding clawback there is no give-back, so the replay is empty.
 */
export async function replaySaleReturns(
  client: PoolClient,
  args: { readonly saleId: string; readonly tenantId: string; readonly minorUnit: number; readonly upToSeq: number | null },
): Promise<ReplayResult & { readonly steps: number }> {
  const claws = await client.query<{ return_seq: number; offer_id: string; offer_version: number; amount: string }>(
    `SELECT r.return_seq, c.offer_id::text AS offer_id, c.offer_version, c.amount::text AS amount
       FROM sale_return_promotion_clawbacks c JOIN sale_returns r ON r.id = c.return_id
      WHERE r.sale_id = $1::uuid AND r.tenant_id = $2::uuid AND c.tenant_id = $2::uuid
        AND ($3::int IS NULL OR r.return_seq <= $3::int)
      ORDER BY r.return_seq`,
    [args.saleId, args.tenantId, args.upToSeq],
  );
  if (claws.rows.length === 0) return { outstanding: new Map(), giveBacks: [], steps: 0 };

  const promoted = await client.query<{ line_ref: string; sold: string; discount: string; offer_id: string; offer_version: number }>(
    `SELECT sl.id::text AS line_ref, sl.quantity::text AS sold, lp.discount_amount::text AS discount,
            lp.offer_id::text AS offer_id, lp.offer_version
       FROM sale_line_promotions lp JOIN sale_lines sl ON sl.id = lp.sale_line_id
      WHERE lp.sale_id = $1::uuid AND lp.tenant_id = $2::uuid AND sl.tenant_id = $2::uuid`,
    [args.saleId, args.tenantId],
  );
  const lines: HistoryLine[] = promoted.rows.map((l) => {
    const sold = wholeUnits(l.sold);
    const discount = scaled(l.discount, args.minorUnit);
    if (sold === null || sold === 0n || discount % sold !== 0n) {
      throw new SaleReturnHistoryInvariantError(`sale ${args.saleId} line ${l.line_ref} is not a whole promoted quantity`);
    }
    return { lineRef: l.line_ref, offerKey: `${l.offer_id}:${l.offer_version}`, sold, unitDiscount: discount / sold };
  });
  const promotedRefs = new Set(lines.map((l) => l.lineRef));

  const returned = await client.query<{ return_seq: number; line_ref: string; quantity: string }>(
    `SELECT r.return_seq, rl.sale_line_id::text AS line_ref, rl.quantity::text AS quantity
       FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id
      WHERE r.sale_id = $1::uuid AND r.tenant_id = $2::uuid AND rl.tenant_id = $2::uuid
        AND ($3::int IS NULL OR r.return_seq <= $3::int)
      ORDER BY r.return_seq`,
    [args.saleId, args.tenantId, args.upToSeq],
  );
  const seqs = [...new Set(returned.rows.map((r) => r.return_seq))].sort((a, b) => a - b);
  const steps: HistoryStep[] = seqs.map((seq) => ({
    returned: new Map(
      returned.rows
        .filter((r) => r.return_seq === seq && promotedRefs.has(r.line_ref))
        .map((r) => [r.line_ref, wholeUnits(r.quantity) ?? 0n] as const),
    ),
    clawback: new Map(
      claws.rows.filter((c) => c.return_seq === seq).map((c) => [`${c.offer_id}:${c.offer_version}`, scaled(c.amount, args.minorUnit)] as const),
    ),
  }));
  return { ...replayReturns(lines, steps), steps: steps.length };
}
