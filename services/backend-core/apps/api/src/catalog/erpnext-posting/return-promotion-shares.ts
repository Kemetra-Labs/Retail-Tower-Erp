/**
 * The per-line promotion clawback and give-back of a stored return, for the posting feed
 * (`posting-feed.yaml` 1.13.0-draft `ReturnLine.promotionClawbackAmount` /
 * `promotionGiveBackAmount`; spec 048 §9, OD-11 option A + Hybrid).
 *
 * NO PERSISTED SPLIT, NO MIGRATION. `sale_return_promotion_clawbacks` holds the clawback of each
 * offer; the split over the return lines and the give-back are DERIVED from rows that never change
 * after the return is recorded, by the pure rule in `offers/evaluator/offer-return-allocation.ts`:
 *
 *   - the clawback of each offer version: `sale_return_promotion_clawbacks` (append only);
 *   - the give-back of each offer version O: the discount of the O units returned now less
 *     `disc_ret`, with `D_held` = the discount on the O units not returned by EARLIER returns of
 *     the sale (`return_seq` below this one) less the clawbacks of O on those earlier returns
 *     (`sale-return-promotions.ts`, spec 048 §9). It is 0 unless an earlier clawback of O exists;
 *   - the returned lines and the frozen discount of each: `sale_return_lines`, `sale_lines`,
 *     `sale_line_promotions` (append only).
 *
 * Cross-check: `return_total` = Σ `lineAmount` − Σ clawback + Σ give-back (the rule the return was
 * admitted under, `sale-returns.service.ts`), compared at the column scale 4, because a line that
 * is not on an offer may be priced below the currency minor unit (RT-740). A mismatch is an
 * invariant error, never a silently wrong feed item.
 *
 * The same stored rows give the same shares on every re-pull, so the feed stays byte-identical.
 * A return with no clawback and no give-back (every return until the RT-1337 refusals lift) yields
 * an empty map, and its work item has none of the new fields.
 */
import type { PoolClient } from "pg";

import { formatColumnAmount, scaled, wholeUnits } from "../../offers/evaluator/offer-decimal";
import {
  allocateReturnPromotion,
  allocationLineOf,
  ReturnPromotionInvariantError,
  type AllocationLine,
} from "../../offers/evaluator/offer-return-allocation";
import { minorUnitExponent } from "../sales/iso4217-minor-units";

/** The `NonNegativeDecimalAmount` scale of the feed (4 fractional digits). */
const FEED_SCALE = 4;

export interface ReturnLinePromotionShare {
  /** Non-negative, feed scale; absent when 0. */
  readonly promotionClawbackAmount?: string;
  readonly promotionGiveBackAmount?: string;
}

export { ReturnPromotionInvariantError };

const sumOf = (m: ReadonlyMap<string, bigint>): bigint => [...m.values()].reduce((a, v) => a + v, 0n);

/** The give-back of each offer version `offerId:offerVersion` of a stored return, in minor units, above 0 only. */
async function deriveGiveBacks(
  client: PoolClient,
  returnId: string,
  minorUnit: number,
  returnedNow: ReadonlyArray<AllocationLine>,
): Promise<Map<string, bigint>> {
  const earlier = await client.query<{ offer_id: string; offer_version: number; total: string }>(
    `SELECT c.offer_id::text AS offer_id, c.offer_version, SUM(c.amount)::text AS total
       FROM sale_return_promotion_clawbacks c
       JOIN sale_returns e ON e.id = c.return_id
       JOIN sale_returns r ON r.id = $1 AND r.sale_id = e.sale_id AND e.return_seq < r.return_seq
      GROUP BY c.offer_id, c.offer_version`,
    [returnId],
  );
  // No earlier clawback means D_held covers every unit returned now: no give-back.
  if (earlier.rows.length === 0) return new Map();
  const clawbackBefore = new Map<string, bigint>(earlier.rows.map((c) => [`${c.offer_id}:${c.offer_version}`, scaled(c.total, minorUnit)] as const));

  const sale = await client.query<{ line_ref: string; sold: string; discount: string; offer_id: string; offer_version: number; before: string }>(
    `SELECT sl.id::text AS line_ref, sl.quantity::text AS sold, lp.discount_amount::text AS discount,
            lp.offer_id::text AS offer_id, lp.offer_version,
            COALESCE((SELECT SUM(x.quantity) FROM sale_return_lines x JOIN sale_returns xr ON xr.id = x.return_id
                       WHERE x.sale_line_id = sl.id AND xr.return_seq < r.return_seq), 0)::text AS before
       FROM sale_returns r
       JOIN sale_line_promotions lp ON lp.sale_id = r.sale_id
       JOIN sale_lines sl ON sl.id = lp.sale_line_id
      WHERE r.id = $1`,
    [returnId],
  );
  const held = new Map<string, bigint>();
  for (const l of sale.rows) {
    const sold = wholeUnits(l.sold);
    const before = wholeUnits(l.before);
    const discount = scaled(l.discount, minorUnit);
    if (sold === null || sold === 0n || before === null || discount % sold !== 0n) {
      throw new ReturnPromotionInvariantError(`return ${returnId} line ${l.line_ref} is not a whole promoted quantity`);
    }
    const key = `${l.offer_id}:${l.offer_version}`;
    held.set(key, (held.get(key) ?? 0n) + (discount / sold) * (sold - before));
  }
  const giveBacks = new Map<string, bigint>();
  for (const key of new Set(returnedNow.map((l) => l.offerKey))) {
    const discNow = returnedNow.filter((l) => l.offerKey === key).reduce((a, l) => a + l.discountReturned, 0n);
    const dHeld = (held.get(key) ?? 0n) - (clawbackBefore.get(key) ?? 0n);
    const discReturned = discNow < dHeld ? discNow : dHeld;
    if (discNow - discReturned > 0n) giveBacks.set(key, discNow - discReturned);
  }
  return giveBacks;
}

/** The shares of one return keyed by `lineRef`; empty when the return has none. */
export async function loadReturnPromotionShares(
  client: PoolClient,
  returnId: string,
): Promise<Map<string, ReturnLinePromotionShare>> {
  const claw = await client.query<{ offer_id: string; offer_version: number; amount: string }>(
    `SELECT offer_id::text AS offer_id, offer_version, amount::text AS amount
       FROM sale_return_promotion_clawbacks WHERE return_id = $1 ORDER BY offer_id, offer_version`,
    [returnId],
  );
  const lines = await client.query<{
    line_ref: string; line_amount: string; quantity: string; sold: string; discount: string;
    offer_id: string; offer_version: number; currency_code: string; return_total: string;
  }>(
    `SELECT rl.sale_line_id::text AS line_ref, rl.line_amount::text AS line_amount, rl.quantity::text AS quantity,
            sl.quantity::text AS sold, lp.discount_amount::text AS discount,
            lp.offer_id::text AS offer_id, lp.offer_version,
            r.currency_code, r.return_total::text AS return_total
       FROM sale_return_lines rl
       JOIN sale_returns r ON r.id = rl.return_id
       JOIN sale_lines sl ON sl.id = rl.sale_line_id
       JOIN sale_line_promotions lp ON lp.sale_line_id = sl.id
      WHERE rl.return_id = $1
      ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id`,
    [returnId],
  );
  if (lines.rows.length === 0) return new Map();

  const first = lines.rows[0]!;
  const minorUnit = minorUnitExponent(first.currency_code);
  if (minorUnit === null) throw new ReturnPromotionInvariantError(`return ${returnId} has a currency without a minor unit`);

  // The same builder as admission; only promoted lines are read at the minor unit.
  const allocationLines: AllocationLine[] = lines.rows.map((r) =>
    allocationLineOf({
      lineRef: r.line_ref,
      offerKey: `${r.offer_id}:${r.offer_version}`,
      sold: r.sold,
      returned: r.quantity,
      lineAmount: r.line_amount,
      discountAmount: r.discount,
      minorUnit,
    }),
  );

  const clawbackByOffer = new Map<string, bigint>(claw.rows.map((c) => [`${c.offer_id}:${c.offer_version}`, scaled(c.amount, minorUnit)] as const));
  const giveBackByOffer = await deriveGiveBacks(client, returnId, minorUnit, allocationLines);
  if (sumOf(clawbackByOffer) === 0n && sumOf(giveBackByOffer) === 0n) return new Map();

  // Cross-check at the column scale 4: return_total = Σ ALL lines − Σ clawback + Σ give-back.
  const all = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(line_amount), 0)::text AS total FROM sale_return_lines WHERE return_id = $1`,
    [returnId],
  );
  const toColumn = (minor: bigint): bigint => minor * 10n ** BigInt(FEED_SCALE - minorUnit);
  const expected = scaled(all.rows[0]!.total, FEED_SCALE) - toColumn(sumOf(clawbackByOffer)) + toColumn(sumOf(giveBackByOffer));
  if (scaled(first.return_total, FEED_SCALE) !== expected) {
    throw new ReturnPromotionInvariantError(`return ${returnId} total is not its lines net of the clawback plus the give-back`);
  }

  const allocation = allocateReturnPromotion({ lines: allocationLines, clawbackByOffer, giveBackByOffer });
  const shares = new Map<string, ReturnLinePromotionShare>();
  for (const l of allocationLines) {
    const c = allocation.clawback.get(l.lineRef);
    const g = allocation.giveBack.get(l.lineRef);
    if (c === undefined && g === undefined) continue;
    shares.set(l.lineRef, {
      ...(c === undefined ? {} : { promotionClawbackAmount: formatColumnAmount(c, minorUnit) }),
      ...(g === undefined ? {} : { promotionGiveBackAmount: formatColumnAmount(g, minorUnit) }),
    });
  }
  return shares;
}
