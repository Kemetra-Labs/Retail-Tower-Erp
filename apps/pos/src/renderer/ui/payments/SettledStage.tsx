import type { JSX } from 'react';

import { CompletionPanel } from '../../v5/checkout/CompletionPanel.js';
import { OperatorBadge } from '../operator/OperatorBadge.js';
import { DrawerNoticeInline } from '../receipts/DrawerNotice.js';
import { SettledScanOwner } from './checkout-parts.js';
import { BACK_REASON_COPY, COMPLETION_TEST_IDS } from './payment-surface-logic.js';
import type { SettledSaleNumber } from './useSettledSaleNumber.js';

/**
 * RT-1226 — the settled stage of PaymentSurface (006 FR-031), moved out of the
 * surface body unchanged.
 *
 * 022 US4a — NFR-6 / P2 (truthfulness), as revised by external review rounds
 * 2 and 3: a terminal-wide `recent` row cannot be tied to THIS payment, so
 * the surface claimed only that the payment was taken.
 *
 * RT-1322 (RT-249 N-S2, doc 20 §5.3) restores the sale number on an exact
 * key. While main answers `pending` nothing more is shown or claimed; on
 * `ok` the number and «اكتمل البيع» show (M-C1); at the 15 s bound, or on a
 * refusal, the neutral M-N5 line shows and nothing says the sale was saved.
 * The receipt (T017) is a separate slice on the same key.
 */
export interface SettledStageProps {
  readonly paidMinor: number;
  readonly changeDueMinor: number;
  /** False when sale finalization is off: the receipt line warns none will be issued. */
  readonly saleFinalization: boolean;
  /** RT-1322 — this sale's number, read on the exact handoff key. */
  readonly settledSaleNumber: SettledSaleNumber;
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
        saleNumber={
          props.settledSaleNumber.status === 'ok' ? props.settledSaleNumber.saleNumber : undefined
        }
        saleNumberUnavailable={props.settledSaleNumber.status === 'unavailable'}
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
