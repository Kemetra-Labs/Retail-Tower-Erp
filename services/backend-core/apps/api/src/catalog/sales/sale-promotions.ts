/**
 * Automatic-offer facts on a captured sale (spec 048 §8, §20, OD-5, OD-9;
 * contract `sales.yaml` `CaptureSaleLinePromotion`; Jira RT-1337).
 *
 * A line that took part in an offer carries `promotion` (offer, version, Pack
 * revision, `discountAmount`). On a FIRST capture this module:
 *
 *   1. REFUSES arithmetic that does not hold, as 422 `sale_line_pricing_invalid`
 *      (the RT-105 / RT-740 code, OD-9): an unknown offer version or Pack
 *      revision of the tenant, or a `discountAmount` above 0 that is not the
 *      cited version's `percentOff`% of `unitPrice` rounded half up once at the
 *      currency's minor unit. (The net invariant, the minor unit and quantity 1
 *      on a reward line are in `sale-line-pricing.ts`.)
 *   2. RE-EVALUATES the offer with the cited Pack revision (the materialised
 *      eligible set of the sale's store at that revision, the version's
 *      parameters, the §6 evaluator over the sale's lines). A rule-level
 *      difference (a cited product outside the eligible set, or a total
 *      discount other than the server's) is ACCEPTED and flagged for review
 *      (OD-9): the sale happened, so its frozen facts are kept and it is never
 *      re-priced.
 *   3. STORES the fact per line (`sale_line_promotions`, append-only).
 *
 * The review flag is an `audit_events` row (`sale.offer_review_flagged`)
 * written in the capture transaction: it names the sale, the offer and what
 * differed. There is no sale-review queue table yet (RT-1336 added none).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import { OfferDecimalError, formatMinor, percentOf, scaled, wholeUnits } from "../../offers/evaluator/offer-decimal";
import { MAX_EVALUATED_UNITS, evaluateOffer, type CartLine } from "../../offers/evaluator/offer-evaluator";
import type { CaptureSaleLineDto, CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";
import { minorUnitExponent } from "./iso4217-minor-units";
import { SaleLinePricingInvalidError } from "./sale-errors";

export const SALE_OFFER_REVIEW_ACTION = "sale.offer_review_flagged";

type PromotedLine = CaptureSaleLineDto & { readonly promotion: NonNullable<CaptureSaleLineDto["promotion"]> };

type PromotionReviewReason = "cited_product_not_in_eligible_set" | "discount_differs_from_server_evaluation" | "participant_not_cited";

interface PromotionReviewFinding {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly packRevision: number;
  readonly recordedDiscount: string;
  readonly expectedDiscount: string;
  readonly reasons: ReadonlyArray<PromotionReviewReason>;
}

export interface PromotionPlan {
  /** Per line index, the fact to store. */
  readonly facts: ReadonlyArray<{
    readonly lineIndex: number;
    readonly offerId: string;
    readonly offerVersion: number;
    readonly packRevision: number;
    readonly discountAmount: string;
  }>;
  readonly findings: ReadonlyArray<PromotionReviewFinding>;
}

/** The server's §6 evaluation of the cart under a cited version; a cart it cannot evaluate is a till defect (422). */
function evaluateCited(facts: VersionFacts, minorUnit: number, cart: ReadonlyArray<CartLine>) {
  try {
    return evaluateOffer({
      offer: { buyQuantity: facts.buyQuantity, getQuantity: facts.getQuantity, percentOff: facts.percentOff, maxApplicationsPerSale: facts.maxApplicationsPerSale },
      minorUnit,
      cart,
    });
  } catch (err) {
    // A line priced beyond the promoted lines' minor unit (mixed currencies) cannot be evaluated.
    if (err instanceof OfferDecimalError) throw new SaleLinePricingInvalidError();
    throw err;
  }
}

/** The units of the lines that take part in an evaluation (whole quantities of eligible lines). */
const eligibleUnits = (cart: ReadonlyArray<CartLine>): bigint =>
  cart.reduce((sum, c) => sum + (c.eligible ? (wholeUnits(c.quantity) ?? 0n) : 0n), 0n);

/** An eligible line with at least one whole unit that none of the citing lines covers. */
const hasUncitedParticipant = (cart: ReadonlyArray<CartLine>, members: ReadonlyArray<{ readonly index: number }>): boolean => {
  const cited = new Set(members.map((m) => String(m.index)));
  return cart.some((c) => c.eligible && (wholeUnits(c.quantity) ?? 0n) > 0n && !cited.has(c.lineRef));
};

const isPromoted = (line: CaptureSaleLineDto): line is PromotedLine => line.promotion !== undefined;

interface VersionFacts {
  readonly percentOff: string;
  readonly buyQuantity: number;
  readonly getQuantity: number;
  readonly maxApplicationsPerSale: number | null;
}

/**
 * Steps 1 and 2: everything that can refuse or flag, with nothing written. A
 * sale with no promoted line returns null without a query.
 */
export async function planSalePromotions(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  body: CaptureSaleRequestDto,
): Promise<PromotionPlan | null> {
  const promoted = body.lines.flatMap((line, index) => (isPromoted(line) ? [{ line, index }] : []));
  if (promoted.length === 0) return null;

  const versions = await loadCitedVersions(client, scope.tenantId, promoted.map((p) => p.line.promotion));
  await assertPackRevisionsExist(client, scope.tenantId, promoted.map((p) => p.line.promotion.packRevision));

  for (const { line } of promoted) {
    const facts = versions.get(versionKey(line.promotion.offerId, line.promotion.offerVersion))!;
    const exponent = minorUnitExponent(line.currencyCode)!; // the price invariant already refused a currency with none
    const discount = scaled(line.promotion.discountAmount, exponent);
    if (discount > 0n && discount !== percentOf(scaled(line.unitPrice, exponent), facts.percentOff)) {
      throw new SaleLinePricingInvalidError();
    }
  }

  const groups = new Map<string, Array<{ line: PromotedLine; index: number }>>();
  for (const p of promoted) {
    const key = `${p.line.promotion.offerId}:${p.line.promotion.offerVersion}:${p.line.promotion.packRevision}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const findings: PromotionReviewFinding[] = [];
  let work = 0n;
  for (const members of groups.values()) {
    const cited = members[0]!.line.promotion;
    const facts = versions.get(versionKey(cited.offerId, cited.offerVersion))!;
    const eligible = await eligibleAt(client, scope, cited);
    const exponent = minorUnitExponent(members[0]!.line.currencyCode)!;
    const reasons = new Set<PromotionReviewReason>();
    if (members.some((m) => m.line.tenantProductRef === undefined || !eligible.has(m.line.tenantProductRef.toLowerCase()))) {
      reasons.add("cited_product_not_in_eligible_set");
    }
    // The server's evaluation over the whole sale: every line whose product is in the set takes part,
    // unless it carries a manual discount (OD-5).
    const cart: CartLine[] = body.lines.map((l, i) => ({
      lineRef: String(i),
      productId: l.tenantProductRef?.toLowerCase() ?? "",
      unitPrice: l.unitPrice,
      quantity: l.quantity,
      eligible: l.tenantProductRef !== undefined && eligible.has(l.tenantProductRef.toLowerCase()) && l.discount === undefined,
    }));
    // One request-wide budget of expanded units: every distinct citation re-evaluates the whole cart, so a request
    // citing many offers or Pack revisions could otherwise repeat the per-call bound once per citation.
    work += eligibleUnits(cart);
    if (work > MAX_EVALUATED_UNITS) throw new SaleLinePricingInvalidError();
    const expected = evaluateCited(facts, exponent, cart);
    const recorded = members.reduce((sum, m) => sum + scaled(m.line.promotion.discountAmount, exponent), 0n);
    if (formatMinor(recorded, exponent) !== expected.totalDiscount) reasons.add("discount_differs_from_server_evaluation");
    // A unit the server counted as taking part but the till did not cite has no fact row: its later return would
    // settle without the offer. Flagged for review (OD-9), the sale is accepted.
    if (expected.applications > 0 && hasUncitedParticipant(cart, members)) reasons.add("participant_not_cited");
    if (reasons.size > 0) {
      findings.push({
        offerId: cited.offerId,
        offerVersion: cited.offerVersion,
        packRevision: cited.packRevision,
        recordedDiscount: formatMinor(recorded, exponent),
        expectedDiscount: expected.totalDiscount,
        reasons: [...reasons],
      });
    }
  }
  return {
    facts: promoted.map(({ line, index }) => ({
      lineIndex: index,
      offerId: line.promotion.offerId,
      offerVersion: line.promotion.offerVersion,
      packRevision: line.promotion.packRevision,
      discountAmount: line.promotion.discountAmount,
    })),
    findings,
  };
}

/** Step 3: the stored facts, then the review flag. Runs after the lines are inserted. */
export async function writeSalePromotions(
  client: PoolClient,
  sale: { readonly saleId: string; readonly tenantId: string; readonly storeId: string; readonly actorUserId: string },
  lineIds: ReadonlyArray<string>,
  plan: PromotionPlan,
): Promise<void> {
  await client.query(
    `INSERT INTO sale_line_promotions
       (sale_line_id, sale_id, tenant_id, store_id, offer_id, offer_version, pack_revision, discount_amount)
     SELECT f.line_id, $2::uuid, $3::uuid, $4::uuid, f.offer_id, f.offer_version, f.pack_revision, f.discount_amount
       FROM unnest($1::uuid[], $5::uuid[], $6::int[], $7::bigint[], $8::numeric[])
              AS f(line_id, offer_id, offer_version, pack_revision, discount_amount)`,
    [
      plan.facts.map((f) => lineIds[f.lineIndex]!),
      sale.saleId,
      sale.tenantId,
      sale.storeId,
      plan.facts.map((f) => f.offerId),
      plan.facts.map((f) => f.offerVersion),
      plan.facts.map((f) => f.packRevision),
      plan.facts.map((f) => f.discountAmount),
    ],
  );
  if (plan.findings.length > 0) {
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, $3, $4, $5, 'sale', $6, NULL, $7::jsonb)`,
      [newId(), sale.actorUserId, sale.tenantId, sale.storeId, SALE_OFFER_REVIEW_ACTION, sale.saleId, JSON.stringify({ sale_id: sale.saleId, findings: plan.findings })],
    );
  }
}

const versionKey = (offerId: string, version: number): string => `${offerId}:${version}`;

/** The cited offer versions of the tenant; one that does not exist is a till defect (422). */
async function loadCitedVersions(
  client: PoolClient,
  tenantId: string,
  cites: ReadonlyArray<{ readonly offerId: string; readonly offerVersion: number }>,
): Promise<Map<string, VersionFacts>> {
  const distinct = [...new Map(cites.map((c) => [versionKey(c.offerId, c.offerVersion), c])).values()];
  const r = await client.query<{ offer_id: string; version: number; percent_off: number; buy_quantity: number; get_quantity: number; max_applications_per_sale: number | null }>(
    `SELECT v.offer_id::text AS offer_id, v.version, v.percent_off::int AS percent_off, v.buy_quantity, v.get_quantity,
            v.max_applications_per_sale
       FROM offer_versions v
       JOIN unnest($2::uuid[], $3::int[]) AS c(offer_id, version)
         ON v.offer_id = c.offer_id AND v.version = c.version
      WHERE v.tenant_id = $1::uuid`,
    [tenantId, distinct.map((c) => c.offerId), distinct.map((c) => c.offerVersion)],
  );
  const found = new Map(
    r.rows.map((v) => [
      versionKey(v.offer_id, v.version),
      { percentOff: String(v.percent_off), buyQuantity: v.buy_quantity, getQuantity: v.get_quantity, maxApplicationsPerSale: v.max_applications_per_sale },
    ]),
  );
  if (distinct.some((c) => !found.has(versionKey(c.offerId, c.offerVersion)))) throw new SaleLinePricingInvalidError();
  return found;
}

async function assertPackRevisionsExist(client: PoolClient, tenantId: string, revisions: ReadonlyArray<number>): Promise<void> {
  const distinct = [...new Set(revisions)];
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM offer_pack_revisions WHERE tenant_id = $1::uuid AND revision = ANY($2::bigint[])`,
    [tenantId, distinct],
  );
  if ((r.rows[0]?.n ?? 0) !== distinct.length) throw new SaleLinePricingInvalidError();
}

/** The eligible product ids of the offer version in this store at the cited Pack revision (0101 frozen ranges). */
async function eligibleAt(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
  cite: { readonly offerId: string; readonly offerVersion: number; readonly packRevision: number },
): Promise<Set<string>> {
  const r = await client.query<{ product_id: string }>(
    `SELECT product_id::text AS product_id
       FROM offer_pack_eligible_products
      WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND offer_id = $3::uuid AND offer_version = $4::int
        AND from_revision <= $5::bigint AND (to_revision IS NULL OR to_revision > $5::bigint)`,
    [scope.tenantId, scope.storeId, cite.offerId, cite.offerVersion, cite.packRevision],
  );
  return new Set(r.rows.map((x) => x.product_id));
}
