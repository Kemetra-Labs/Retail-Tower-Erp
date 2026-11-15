import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { usePaymentStore } from '../../stores/payment-store.js';
import { TenderPicker, type TenderKind } from '../../v5/checkout/TenderPicker.js';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope.js';
import type { TenderApplyRequest, TenderBridgeAPI } from '../../../shared/bridge-api.js';
import { CashEntry } from './CashEntry.js';
import { ExternalCardTerminalEntry } from './ExternalCardTerminalEntry.js';
import { VoucherEntry } from './VoucherEntry.js';
import { ZeroDueTender } from './checkout-parts.js';

/**
 * RT-1226 — the tender stage of PaymentSurface: the method tiles (or, at 0 due,
 * why none is needed) and the entry for the chosen tender. Moved out of the
 * surface body unchanged; it holds no state of its own.
 */
export interface TenderEntryStageProps {
  readonly envelope: Readonly<PaymentIntentEnvelope>;
  readonly zeroDue: boolean;
  readonly selectedTender: TenderKind | null;
  readonly voucherEnabled: boolean;
  readonly cardEnabled: boolean;
  readonly onTileKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onTenderSelect: (tender: TenderKind) => void;
  /** S3d mode: an entry for the selected tender is open (bridge wired, attempt started). */
  readonly entryOpen: boolean;
  readonly remainingBalanceMinor: number;
  readonly paymentAttemptId: string | null;
  readonly sendTenderApply: (req: TenderApplyRequest) => ReturnType<TenderBridgeAPI['apply']>;
  readonly onDraftChange: (draftMinor: number | null) => void;
  /** An apply succeeded in main (or main holds tender this screen has not seen): read it. */
  readonly onLineApplied: () => void;
  readonly onOpenShift: (() => void) | undefined;
}

function TenderEntry(
  props: Readonly<TenderEntryStageProps & { paymentAttemptId: string }>,
): JSX.Element {
  const {
    selectedTender,
    remainingBalanceMinor,
    paymentAttemptId,
    sendTenderApply,
    onLineApplied,
  } = props;
  return (
    <div className="v5-checkout__entry" data-testid="payment-surface-entry">
      {selectedTender === 'cash' && (
        <CashEntry
          remainingBalanceMinor={remainingBalanceMinor}
          paymentAttemptId={paymentAttemptId}
          tenderApply={sendTenderApply}
          onDraftChange={props.onDraftChange}
          onApplied={onLineApplied}
          // RT-339: main holds tender this screen has not seen; read it.
          onNothingOwed={onLineApplied}
          onOpenShift={props.onOpenShift}
        />
      )}
      {selectedTender === 'external_card_terminal' && props.cardEnabled && (
        <ExternalCardTerminalEntry
          remainingBalanceMinor={remainingBalanceMinor}
          paymentAttemptId={paymentAttemptId}
          tenderApply={(req) => {
            // Recorded before the call: if main commits but the
            // response is lost, a later cancel still warns (RT-256).
            usePaymentStore.getState().recordCardApplyAttempted();
            return sendTenderApply(req);
          }}
          onApplied={(response) => {
            usePaymentStore.getState().recordCardApplied(response.tender_line_id);
            onLineApplied();
          }}
        />
      )}
      {selectedTender === 'internal_voucher' && props.voucherEnabled && (
        <VoucherEntry
          remainingBalanceMinor={remainingBalanceMinor}
          paymentAttemptId={paymentAttemptId}
          tenderApply={sendTenderApply}
          onApplied={onLineApplied}
        />
      )}
    </div>
  );
}

export function TenderEntryStage(props: Readonly<TenderEntryStageProps>): JSX.Element {
  return (
    <div className="v5-checkout__tender">
      {props.zeroDue ? (
        <ZeroDueTender />
      ) : (
        <TenderPicker
          envelope={props.envelope}
          selectedTender={props.selectedTender}
          voucherEnabled={props.voucherEnabled}
          cardEnabled={props.cardEnabled}
          onTileKeyDown={props.onTileKeyDown}
          onTenderSelect={props.onTenderSelect}
        />
      )}

      {/* S3d mode: entry component for the selected tender. */}
      {/* `entryOpen` already requires an attempt id; the second test only narrows the type. */}
      {props.entryOpen && props.paymentAttemptId !== null && (
        <TenderEntry {...props} paymentAttemptId={props.paymentAttemptId} />
      )}
    </div>
  );
}
