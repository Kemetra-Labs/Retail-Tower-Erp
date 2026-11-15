import type { JSX } from 'react';

import { CompletionPanel } from '../../v5/checkout/CompletionPanel.js';
import { OperatorBadge } from '../operator/OperatorBadge.js';
import { DrawerNoticeInline } from '../receipts/DrawerNotice.js';
import { SettledScanOwner } from './checkout-parts.js';
import { BACK_REASON_COPY, COMPLETION_TEST_IDS } from './payment-surface-logic.js';

/**
 * RT-1226 — the settled stage of PaymentSurface (006 FR-031), moved out of the
 * surface body unchanged.
 *
 * 022 US4a — NFR-6 / P2, as REVISED by external review round 2.
 *
 * The original design split this phase in two: "payment taken, sale not
 * yet finalized" vs "sale finalized". That split required knowing the
 * finalized record belongs to THIS payment — and the terminal cannot know
 * that. `RecentSaleSummary` carries no attempt/handoff identifier and
 * `payments.confirm` returns only `settled_at`, so `finalized_at >=
 * settled_at` is the only available test and a PRIOR sale finalizing late
 * satisfies it.
 *
 * Round 1 dropped the receipt but kept the "sale complete" headline on
 * that same evidence — fixing the symptom while keeping the assertion.
 * So the states collapse to the ONE the terminal can actually support:
 * the payment was taken. No sale number or receipt is shown without a
 * correlation key tying the finalized sale to this attempt.
 *
 * T013a and T017 are both unticked, blocked on the same backend gap: an
 * identifier on the `recent` projection tying the finalized sale to this
 * payment. 011 already derives one from `envelope_handoff_action_id`.
 *
 * 022 US4a (T011) — the sale id is NO LONGER retained. It existed to mount
 * ReceiptPreview and to discriminate T013a's two settled states. External
 * review round 2 established that neither use is sound: the `recent` row
 * cannot be tied to THIS payment, so an id taken from it could belong to a
 * prior sale. Both the receipt (T017) and the completion claim (T013a) are
 * blocked on a correlating identifier, so holding the id would be dead state
 * inviting the same mistake again. Re-introduce it together with the
 * correlation key, not before. `settled_at` is no longer retained either: it
 * existed solely to discriminate the recent-sale poll's results, and that poll
 * is gone (round 3 below). It returns with the correlating identifier, if the
 * correlation ends up needing it.
 *
 * EXTERNAL REVIEW P1 (round 3) — "Stop polling until finalized sales can be
 * correlated". The recent-sale poll is REMOVED, not merely capped. Round 2
 * replaced a 10-attempt cap with a backoff that kept watching for the life of
 * the settled surface. That fixed "late finalization is never seen" and, in
 * doing so, widened the miscorrelation window from a bounded ~2s to UNBOUNDED:
 * any prior sale finalizing at any later point satisfies `finalized_at >=
 * settled_at` and would be adopted as this sale's number. The number rested on
 * exactly the evidence that already disqualified the receipt (T017) and the
 * completion claim (T013a) — a terminal-wide row with no tie to this payment.
 * It survived earlier rounds only on "no worse than `main`", and the uncapped
 * poll made that false: `main` was bounded. So the surface shows no sale
 * number, and nothing polls for one. This is a DELIBERATE REDUCTION below
 * `main` (it contradicts 006 invariant 13, which asserts the number displays)
 * accepted on safety grounds: a wrong cashier-quotable reference is worse than
 * none. It returns with the correlating identifier, alongside T013a and T017.
 */
export interface SettledStageProps {
  readonly paidMinor: number;
  readonly changeDueMinor: number;
  /** False when sale finalization is off: the receipt line warns none will be issued. */
  readonly saleFinalization: boolean;
  readonly cardVoidRequired: boolean;
  readonly hasAppliedCash: boolean;
  readonly displayName: string;
  readonly role: Parameters<typeof OperatorBadge>[0]['role'];
  readonly onNewSale: (() => void) | undefined;
}

export function SettledStage(props: Readonly<SettledStageProps>): JSX.Element {
  return (
    <>
      <SettledScanOwner />
      <CompletionPanel
        paidMinor={props.paidMinor}
        changeDueMinor={props.changeDueMinor}
        saleFinalization={props.saleFinalization}
        cardVoidCopy={props.cardVoidRequired ? BACK_REASON_COPY.card_void : null}
        // RT-241 (D-B1) — a drawer that did not open on this session's sale
        // shows here only inside CASH completion: the notice store knows the
        // failure happened this session, not that it belongs to this sale, so
        // a card or voucher completion must not say "open it manually".
        drawerNotice={props.hasAppliedCash ? <DrawerNoticeInline /> : null}
        operator={<OperatorBadge display_name={props.displayName} role={props.role} />}
        onNewSale={props.onNewSale}
        testIds={COMPLETION_TEST_IDS}
      />
    </>
  );
}
