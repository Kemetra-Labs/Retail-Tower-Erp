/**
 * The outstanding clawback of an offer across the returns of one sale — spec 048 §9, OD-3, OD-11 Hybrid. PURE.
 *
 * `D_held` of a return is the discount still held on the offer's units not returned before, LESS the
 * OUTSTANDING clawback of the offer: the clawbacks recorded on earlier returns, net of the give-backs those
 * earlier returns made. (Subtracting the recorded clawbacks alone double-counts them once a returned reward
 * unit has given its discount back: a buy-1-get-2 sale of 300 + 2 × 200 at 40% claws back 160.00 on the trigger
 * return, and without the net the third return would read `D_held` = 80 − 160 = −80 and give back 160.00 on an
 * 80.00 discount.) With the outstanding clawback, `D_held` is never negative.
 *
 * Replaying the returns in order, for each offer version O and return k:
 *
 *   held_k        = Σ unit discount of the O units not returned before k
 *   D_held_k      = held_k − outstanding_(k−1)
 *   disc_ret_k    = min( Σ discount of the O units returned in k, D_held_k )
 *   giveBack_k    = Σ discount of the O units returned in k − disc_ret_k
 *   outstanding_k = outstanding_(k−1) + clawback_k − giveBack_k
 *
 * Admission (`sale-return-promotions.ts`) replays the sale's recorded returns to get `outstanding` before the
 * return it settles; the feed projection (`erpnext-posting/return-promotion-shares.ts`) replays up to and
 * including the stored return to get that return's give-back. One rule, so the two cannot drift.
 */

/** One sale line that cites an offer version, with the discount of ONE of its units (the whole line's is divisible). */
export interface HistoryLine {
  readonly lineRef: string;
  /** `offerId:offerVersion`. */
  readonly offerKey: string;
  readonly sold: bigint;
  /** Minor units of discount per unit (0 on an eligible line that is not a reward). */
  readonly unitDiscount: bigint;
}

/** One recorded return of the sale, in `return_seq` order. */
export interface HistoryStep {
  /** Units returned per `lineRef` (promoted lines only). */
  readonly returned: ReadonlyMap<string, bigint>;
  /** The clawback recorded on this return per `offerKey`, in minor units (above 0 only). */
  readonly clawback: ReadonlyMap<string, bigint>;
}

export interface ReplayResult {
  /** The outstanding clawback per `offerKey` after the last step (0 when none). */
  readonly outstanding: ReadonlyMap<string, bigint>;
  /** The give-back of each step per `offerKey` (above 0 only). */
  readonly giveBacks: ReadonlyArray<ReadonlyMap<string, bigint>>;
}

export function replayReturns(lines: ReadonlyArray<HistoryLine>, steps: ReadonlyArray<HistoryStep>): ReplayResult {
  const returnedBefore = new Map<string, bigint>();
  const outstanding = new Map<string, bigint>();
  const offerKeys = [...new Set(lines.map((l) => l.offerKey))];
  const giveBacks: Array<Map<string, bigint>> = [];

  for (const step of steps) {
    const stepGiveBacks = new Map<string, bigint>();
    for (const key of offerKeys) {
      let held = 0n;
      let discNow = 0n;
      for (const l of lines) {
        if (l.offerKey !== key) continue;
        held += l.unitDiscount * (l.sold - (returnedBefore.get(l.lineRef) ?? 0n));
        discNow += l.unitDiscount * (step.returned.get(l.lineRef) ?? 0n);
      }
      const open = outstanding.get(key) ?? 0n;
      const dHeld = held - open;
      const discReturned = discNow < dHeld ? discNow : dHeld > 0n ? dHeld : 0n;
      const giveBack = discNow - discReturned;
      if (giveBack > 0n) stepGiveBacks.set(key, giveBack);
      const next = open + (step.clawback.get(key) ?? 0n) - giveBack;
      outstanding.set(key, next > 0n ? next : 0n);
    }
    for (const [lineRef, q] of step.returned) returnedBefore.set(lineRef, (returnedBefore.get(lineRef) ?? 0n) + q);
    giveBacks.push(stepGiveBacks);
  }
  return { outstanding, giveBacks };
}
