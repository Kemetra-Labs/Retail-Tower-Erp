/**
 * Return clawback and give-back allocation to return lines — spec 048 §9, OD-11
 * (option A + Hybrid, owner decision 2026-11-12). PURE: no I/O, no clock, no float.
 *
 * `settleOfferReturn` yields, per offer version O, one clawback and (across the
 * return) one give-back, both in minor units. The posting feed (`ReturnLine.
 * promotionClawbackAmount` / `promotionGiveBackAmount`) carries them PER LINE, so
 * the Connector can post the clawback as a reduced credit-note rate (option A) and
 * the give-back as a non-stock "promotion give-back" row (Hybrid). This module is
 * the one allocation rule that `sales.yaml` `recordReturn` writes down.
 *
 * Clawback of O: spread over the returned lines of O, in TWO tiers.
 *   1. the returned NON-reward lines (`discountAmount` = 0) of O;
 *   2. only for what tier 1 cannot hold, the returned reward lines of O.
 * Within a tier the spread is proportional to the returned `lineAmount`, in whole
 * minor units, largest remainder first, ties by line order. No line takes more than
 * its returned `lineAmount`. A clawback that the returned lines of O cannot hold is
 * refused (`ReturnPromotionOverflowError`): the customer would pay back.
 *
 * Give-back of O: spread over the returned REWARD lines of O, proportional to the
 * discount of the units returned now, in whole minor units, largest remainder first,
 * ties by line order. No line takes more than that discount. It never overflows,
 * because a give-back is at most the discount of the reward units of O returned now
 * (`settleOfferReturn`: `giveBack = discNow − discReturned`). Each offer's give-back
 * stays on that offer's own lines.
 *
 * Both outputs are non-negative whole minor units and add up exactly to their totals.
 */

import { scaled, wholeUnits } from "./offer-decimal";

/** A stored return or sale line breaks an invariant the capture guard enforces (never reachable from valid data). */
export class ReturnPromotionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnPromotionInvariantError";
  }
}

/** One returned line of a sale that cites an offer version, in sale line order. */
export interface AllocationLine {
  readonly lineRef: string;
  /** `offerId:offerVersion` of the line's frozen promotion. */
  readonly offerKey: string;
  /** The returned `lineAmount`, in minor units. */
  readonly lineAmount: bigint;
  /** The frozen discount of the units returned now, in minor units (0 on a non-reward line). */
  readonly discountReturned: bigint;
}

/**
 * The one builder of an `AllocationLine`, used by admission (`sale-return-promotions.ts`) and by the feed
 * projection (`erpnext-posting/return-promotion-shares.ts`) so both read the same inputs: only a promoted
 * line is read at the minor unit, and it must divide exactly (capture guard).
 */
export function allocationLineOf(args: {
  readonly lineRef: string;
  readonly offerKey: string;
  /** Units sold on the sale line, and units returned now (exact-decimal strings). */
  readonly sold: string;
  readonly returned: string;
  /** The returned `lineAmount` and the promotion's frozen discount of the WHOLE sale line. */
  readonly lineAmount: string;
  readonly discountAmount: string;
  readonly minorUnit: number;
}): AllocationLine {
  const sold = wholeUnits(args.sold);
  const now = wholeUnits(args.returned);
  const discount = scaled(args.discountAmount, args.minorUnit);
  if (sold === null || sold === 0n || now === null || discount % sold !== 0n) {
    throw new ReturnPromotionInvariantError(`line ${args.lineRef} is not a whole promoted quantity`);
  }
  return {
    lineRef: args.lineRef,
    offerKey: args.offerKey,
    lineAmount: scaled(args.lineAmount, args.minorUnit),
    discountReturned: (discount / sold) * now,
  };
}

export interface ReturnAllocationInput {
  /** The returned lines that cite an offer, in sale line order. */
  readonly lines: ReadonlyArray<AllocationLine>;
  /** The clawback of each offer version (`offerKey`), in minor units, above 0 only. */
  readonly clawbackByOffer: ReadonlyMap<string, bigint>;
  /** The give-back of each offer version (`offerKey`), in minor units, above 0 only. */
  readonly giveBackByOffer: ReadonlyMap<string, bigint>;
}

export interface ReturnAllocation {
  /** Minor units per `lineRef`; only lines with a share above 0. */
  readonly clawback: ReadonlyMap<string, bigint>;
  readonly giveBack: ReadonlyMap<string, bigint>;
}

/** The returned lines cannot hold the clawback or the give-back (the OD-10 "customer pays back" case). */
export class ReturnPromotionOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnPromotionOverflowError";
  }
}

/**
 * `total` split in proportion to `weights` (non-negative), in whole units: floor shares, then one
 * extra unit to the largest remainders, ties by index. The shares add up to `total`, and a share
 * never exceeds its weight when `total` <= Σ weights.
 */
export function spreadProportionally(total: bigint, weights: ReadonlyArray<bigint>): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (total < 0n || total > sum) throw new ReturnPromotionOverflowError("the amount exceeds what the lines can hold");
  if (total === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sum);
  let left = total - shares.reduce((a, s) => a + s, 0n);
  const order = weights
    .map((w, index) => ({ index, remainder: (total * w) % sum }))
    .filter((r) => r.remainder > 0n)
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of order) {
    if (left === 0n) break;
    shares[index]! += 1n;
    left -= 1n;
  }
  return shares;
}

function addShares(into: Map<string, bigint>, lines: ReadonlyArray<AllocationLine>, shares: ReadonlyArray<bigint>): void {
  lines.forEach((line, i) => {
    const share = shares[i]!;
    if (share > 0n) into.set(line.lineRef, (into.get(line.lineRef) ?? 0n) + share);
  });
}

export function allocateReturnPromotion(input: ReturnAllocationInput): ReturnAllocation {
  const clawback = new Map<string, bigint>();
  for (const [offerKey, amount] of input.clawbackByOffer) {
    if (amount <= 0n) continue;
    const ofOffer = input.lines.filter((l) => l.offerKey === offerKey);
    const plain = ofOffer.filter((l) => l.discountReturned === 0n);
    const rewards = ofOffer.filter((l) => l.discountReturned > 0n);
    const plainCapacity = plain.reduce((a, l) => a + l.lineAmount, 0n);
    const rewardCapacity = rewards.reduce((a, l) => a + l.lineAmount, 0n);
    if (amount > plainCapacity + rewardCapacity) {
      throw new ReturnPromotionOverflowError(`the clawback of ${offerKey} exceeds the returned lines of the offer`);
    }
    const inPlain = amount < plainCapacity ? amount : plainCapacity;
    addShares(clawback, plain, spreadProportionally(inPlain, plain.map((l) => l.lineAmount)));
    addShares(clawback, rewards, spreadProportionally(amount - inPlain, rewards.map((l) => l.lineAmount)));
  }

  const giveBack = new Map<string, bigint>();
  for (const [offerKey, amount] of input.giveBackByOffer) {
    if (amount <= 0n) continue;
    const rewards = input.lines.filter((l) => l.offerKey === offerKey && l.discountReturned > 0n);
    addShares(giveBack, rewards, spreadProportionally(amount, rewards.map((l) => l.discountReturned)));
  }
  return { clawback, giveBack };
}
