/**
 * Returns of a sale that took part in automatic offers — spec 048 §9, OD-3,
 * OD-10, OD-11 (Jira RT-1337, RT-286 S4; the rule of `sales.yaml`
 * `recordReturn`, the pure arithmetic in `offers/evaluator/offer-return-settlement.ts`).
 *
 * A return uses the FROZEN offer version and unit prices of the sale
 * (`sale_line_promotions`, `offer_versions`), never the current offers, and
 * counts every earlier return of the sale (units returned, clawbacks recorded).
 * For each offer version O with a returned unit:
 *
 *   - `refund_O` below 0 is REFUSED, 422 `promotion_clawback_exceeds_refund`
 *     (OD-10): the till asks the cashier to add the reward units; a return
 *     never charges the customer;
 *   - `clawback_O` above 0, a return that would GIVE BACK an earlier clawback
 *     (golden sequence S3, step 2) and the return of a REWARD line
 *     (`discountAmount` above 0) are REFUSED, 422 `promotion_return_requires_clawback`,
 *     fail closed (coordinator decision, RT-1337 validation). OD-11 is decided
 *     (option A plus the Hybrid give-back) and the posting feed now carries the
 *     per-line clawback and give-back (1.13.0-draft; the shares are derived by
 *     `erpnext-posting/return-promotion-shares.ts`), but the Connector cannot post
 *     them yet (RT-1340 phase 2), so such a return would be permanently rejected at
 *     ERPNext. The refusal lifts when the Connector supports both feed fields;
 *     `insertReturnClawbacks` and the net-of-clawback-plus-give-back tender rule are
 *     ready for that lift.
 *
 * A return of a non-reward promoted line that changes no discount (clawback 0)
 * is accepted as an ordinary return.
 */
import type { PoolClient } from "pg";

import { formatColumnAmount, scaled, wholeUnits } from "../../offers/evaluator/offer-decimal";
import {
  allocateReturnPromotion,
  allocationLineOf,
  ReturnPromotionOverflowError,
  type AllocationLine,
} from "../../offers/evaluator/offer-return-allocation";
import { settleOfferReturn, type SaleOfferLine } from "../../offers/evaluator/offer-return-settlement";
import { minorUnitExponent } from "./iso4217-minor-units";
import { replaySaleReturns } from "./sale-return-history";
import { PromotionClawbackExceedsRefundError, PromotionReturnRequiresClawbackError } from "./sale-reversal";

export interface ReturnClawback {
  readonly offerId: string;
  readonly offerVersion: number;
  /** A positive exact-decimal at the column scale (4). */
  readonly amount: string;
}

interface PromotedSaleLine extends SaleOfferLine {
  readonly offerId: string;
  readonly offerVersion: number;
}

/**
 * PR 1 of the OD-11 contract slice keeps the fail-closed refusals: the posting feed now CARRIES the clawback and the
 * give-back (1.13.0-draft), but the Connector cannot post them yet (RT-1340 phase 2). The second PR deletes this
 * constant and the guard below it.
 */
const CONNECTOR_POSTS_PROMOTION_RETURNS = false;

export interface ReturnPromotionSettlement {
  /** One per offer version with a clawback above 0. */
  readonly clawbacks: ReturnClawback[];
  /** Σ give-back of the return at the column scale (4), "0.0000" when none: a reward unit of an earlier clawback. */
  readonly giveBack: string;
}

const NO_PROMOTION_SETTLEMENT: ReturnPromotionSettlement = { clawbacks: [], giveBack: "0.0000" };

/** Records `value` under `key` when it is above 0. */
function setWhenPositive(into: Map<string, bigint>, key: string, value: bigint): void {
  if (value > 0n) into.set(key, value);
}

/** The promoted lines of the sale grouped by offer version `offerId:offerVersion`, in sale line order. */
function groupByOffer(lines: ReadonlyArray<PromotedSaleLine>): Map<string, PromotedSaleLine[]> {
  const groups = new Map<string, PromotedSaleLine[]>();
  for (const l of lines) groups.set(`${l.offerId}:${l.offerVersion}`, [...(groups.get(`${l.offerId}:${l.offerVersion}`) ?? []), l]);
  return groups;
}

/** The clawbacks and the give-back of one return (none when the sale has no promoted line or the return needs none). */
export async function settleReturnPromotions(
  client: PoolClient,
  args: {
    readonly saleRef: string;
    readonly tenantId: string;
    readonly currencyCode: string;
    readonly lines: ReadonlyArray<{ readonly lineRef: string; readonly quantity: string; readonly lineAmount: string }>;
  },
): Promise<ReturnPromotionSettlement> {
  const promoted = await client.query<{
    line_ref: string; product: string | null; unit_price: string; quantity: string; line_amount: string;
    discount: string; offer_id: string; offer_version: number;
  }>(
    `SELECT sl.id::text AS line_ref, sl.tenant_product_ref::text AS product, sl.unit_price::text AS unit_price,
            sl.quantity::text AS quantity, sl.line_amount::text AS line_amount, lp.discount_amount::text AS discount,
            lp.offer_id::text AS offer_id, lp.offer_version
       FROM sale_line_promotions lp JOIN sale_lines sl ON sl.id = lp.sale_line_id
      WHERE lp.sale_id = $1::uuid AND lp.tenant_id = $2::uuid AND sl.tenant_id = $2::uuid
      ORDER BY sl.line_seq NULLS LAST, sl.line_name, sl.id`,
    [args.saleRef, args.tenantId],
  );
  if (promoted.rows.length === 0) return NO_PROMOTION_SETTLEMENT;
  const exponent = minorUnitExponent(args.currencyCode);
  if (exponent === null) throw new Error(`sale currency ${args.currencyCode} has no minor unit`);

  const lines: PromotedSaleLine[] = promoted.rows.map((r) => ({
    lineRef: r.line_ref,
    // The tie-break key of the §6 order; a line with no product falls back to its own id.
    productId: r.product ?? r.line_ref,
    unitPrice: r.unit_price,
    quantity: r.quantity,
    lineAmount: r.line_amount,
    discountAmount: r.discount,
    offerId: r.offer_id,
    offerVersion: r.offer_version,
  }));
  const returnedNow = new Map(
    args.lines.filter((l) => lines.some((p) => p.lineRef === l.lineRef)).map((l) => [l.lineRef, wholeUnits(l.quantity)!] as const),
  );
  if (returnedNow.size === 0) return NO_PROMOTION_SETTLEMENT;

  const before = await client.query<{ line_ref: string; returned: string }>(
    `SELECT rl.sale_line_id::text AS line_ref, SUM(rl.quantity)::text AS returned
       FROM sale_return_lines rl WHERE rl.tenant_id = $2::uuid AND rl.sale_line_id = ANY($1::uuid[]) GROUP BY rl.sale_line_id`,
    [lines.map((l) => l.lineRef), args.tenantId],
  );
  const returnedBefore = new Map(before.rows.map((r) => [r.line_ref, wholeUnits(r.returned) ?? 0n] as const));

  const groups = groupByOffer(lines);
  const history = await replaySaleReturns(client, { saleId: args.saleRef, tenantId: args.tenantId, minorUnit: exponent, upToSeq: null });
  const clawbacks: ReturnClawback[] = [];
  const clawbackByOffer = new Map<string, bigint>();
  const giveBackByOffer = new Map<string, bigint>();
  let giveBack = 0n;
  for (const members of groups.values()) {
    if (!members.some((m) => returnedNow.has(m.lineRef))) continue;
    const first = members[0]!;
    const offer = await loadVersionParameters(client, args.tenantId, first.offerId, first.offerVersion);
    // The OUTSTANDING clawback of this offer: recorded clawbacks net of the give-backs of earlier returns.
    const clawbacksBefore = history.outstanding.get(`${first.offerId}:${first.offerVersion}`) ?? 0n;
    const s = settleOfferReturn({
      offer,
      minorUnit: exponent,
      saleLines: members,
      returnedBefore,
      clawbacksBefore,
      returnedNow,
    });
    if (s.refund < 0n) throw new PromotionClawbackExceedsRefundError();
    giveBack += s.giveBack;
    setWhenPositive(giveBackByOffer, `${first.offerId}:${first.offerVersion}`, s.giveBack);
    setWhenPositive(clawbackByOffer, `${first.offerId}:${first.offerVersion}`, s.clawback ?? 0n);
  }

  for (const [key, amount] of clawbackByOffer) {
    const [offerId, offerVersion] = key.split(":");
    clawbacks.push({ offerId: offerId!, offerVersion: Number(offerVersion), amount: formatColumnAmount(amount, exponent) });
  }
  const rewardReturned = lines.some((l) => returnedNow.has(l.lineRef) && scaled(l.discountAmount, exponent) > 0n);
  assertReturnedLinesHold({ lines, returned: args.lines, returnedNow, exponent, clawbackByOffer, giveBackByOffer });

  // Fail closed until the Connector posts it (RT-1340 phase 2): a clawback, a give-back and the return of a reward
  // line (the Connector's return builder needs unitPrice x quantity = lineAmount) are all refused.
  if (!CONNECTOR_POSTS_PROMOTION_RETURNS && (rewardReturned || giveBack > 0n || clawbacks.length > 0)) {
    throw new PromotionReturnRequiresClawbackError();
  }
  return { clawbacks, giveBack: formatColumnAmount(giveBack, exponent) };
}

/** The per-line split the feed carries: refused when the returned lines cannot hold it (the customer would pay back, OD-10). */
function assertReturnedLinesHold(args: {
  readonly lines: ReadonlyArray<PromotedSaleLine>;
  readonly returned: ReadonlyArray<{ readonly lineRef: string; readonly lineAmount: string }>;
  readonly returnedNow: ReadonlyMap<string, bigint>;
  readonly exponent: number;
  readonly clawbackByOffer: ReadonlyMap<string, bigint>;
  readonly giveBackByOffer: ReadonlyMap<string, bigint>;
}): void {
  // Only the promoted lines: a non-promoted line (for example a manually discounted partial return) may be priced below the minor unit.
  const amountText = new Map(args.returned.filter((l) => args.returnedNow.has(l.lineRef)).map((l) => [l.lineRef, l.lineAmount] as const));
  const allocationLines: AllocationLine[] = args.lines
    .filter((l) => args.returnedNow.has(l.lineRef))
    .map((l) =>
      allocationLineOf({
        lineRef: l.lineRef,
        offerKey: `${l.offerId}:${l.offerVersion}`,
        sold: l.quantity,
        returned: String(args.returnedNow.get(l.lineRef)!),
        lineAmount: amountText.get(l.lineRef) ?? "0",
        discountAmount: l.discountAmount,
        minorUnit: args.exponent,
      }),
    );
  try {
    allocateReturnPromotion({ lines: allocationLines, clawbackByOffer: args.clawbackByOffer, giveBackByOffer: args.giveBackByOffer });
  } catch (error) {
    if (error instanceof ReturnPromotionOverflowError) throw new PromotionClawbackExceedsRefundError();
    throw error;
  }
}

async function loadVersionParameters(
  client: PoolClient,
  tenantId: string,
  offerId: string,
  offerVersion: number,
): Promise<{ buyQuantity: number; getQuantity: number; percentOff: string; maxApplicationsPerSale: number | null }> {
  const r = await client.query<{ buy_quantity: number; get_quantity: number; percent_off: number; max_applications_per_sale: number | null }>(
    `SELECT v.buy_quantity, v.get_quantity, v.percent_off::int AS percent_off, v.max_applications_per_sale
       FROM offer_versions v
      WHERE v.tenant_id = $1::uuid AND v.offer_id = $2::uuid AND v.version = $3::int`,
    [tenantId, offerId, offerVersion],
  );
  const v = r.rows[0];
  if (v === undefined) throw new Error(`offer ${offerId} version ${offerVersion} of a captured sale is missing`);
  return { buyQuantity: v.buy_quantity, getQuantity: v.get_quantity, percentOff: String(v.percent_off), maxApplicationsPerSale: v.max_applications_per_sale };
}

/** The clawback rows of a return, in the transaction that records it. */
export async function insertReturnClawbacks(
  client: PoolClient,
  args: { readonly returnId: string; readonly tenantId: string; readonly storeId: string; readonly clawbacks: ReadonlyArray<ReturnClawback> },
): Promise<void> {
  if (args.clawbacks.length === 0) return;
  await client.query(
    `INSERT INTO sale_return_promotion_clawbacks (return_id, tenant_id, store_id, offer_id, offer_version, amount)
     SELECT $1::uuid, $2::uuid, $3::uuid, c.offer_id, c.offer_version, c.amount
       FROM unnest($4::uuid[], $5::int[], $6::numeric[]) AS c(offer_id, offer_version, amount)`,
    [args.returnId, args.tenantId, args.storeId, args.clawbacks.map((c) => c.offerId), args.clawbacks.map((c) => c.offerVersion), args.clawbacks.map((c) => c.amount)],
  );
}

/** The `promotionClawbacks` of a stored return, ordered by offer for a replay-stable projection. */
export async function loadReturnClawbacks(client: PoolClient, tenantId: string, returnId: string): Promise<ReturnClawback[]> {
  const r = await client.query<{ offer_id: string; offer_version: number; amount: string }>(
    `SELECT offer_id::text AS offer_id, offer_version, amount::text AS amount
       FROM sale_return_promotion_clawbacks WHERE tenant_id = $2::uuid AND return_id = $1::uuid ORDER BY offer_id, offer_version`,
    [returnId, tenantId],
  );
  return r.rows.map((c) => ({ offerId: c.offer_id, offerVersion: c.offer_version, amount: c.amount }));
}
