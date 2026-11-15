import type { JSX, RefObject } from 'react';

import { FocusWhen } from './CheckoutActionBar.js';
import { FIRST_ENABLED_TENDER_TILE } from './payment-surface-logic.js';

/**
 * RT-1226 — where focus goes as PaymentSurface's stages change, moved out of
 * the surface body unchanged. The primary action changes under the cashier's
 * hands; keep focus with them. Each landing arms the matching I-9 key guard.
 */
export interface CheckoutFocusRulesProps {
  readonly arriving: boolean;
  readonly onTenderSelection: boolean;
  readonly hasAppliedLine: boolean;
  readonly fullyTendered: boolean;
  readonly zeroDue: boolean;
  readonly noCancelHold: boolean;
  readonly commitFocusedAtRef: RefObject<number>;
  readonly tileFocusedAtRef: RefObject<number>;
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function firstTile(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FIRST_ENABLED_TENDER_TILE);
}

export function CheckoutFocusRules(props: Readonly<CheckoutFocusRulesProps>): JSX.Element {
  const { arriving, onTenderSelection, hasAppliedLine, fullyTendered, zeroDue } = props;
  const armCommit = (): void => {
    props.commitFocusedAtRef.current = Date.now();
  };
  const armTile = (): void => {
    props.tileFocusedAtRef.current = Date.now();
  };
  return (
    <>
      <FocusWhen
        active={fullyTendered}
        find={() => byTestId('payment-surface-confirm')}
        onFocused={armCommit}
      />
      {/* RT-763: the refocus after a partial apply arms the same tile guard as arrival. */}
      <FocusWhen
        active={onTenderSelection && hasAppliedLine && !fullyTendered}
        find={firstTile}
        onFocused={armTile}
      />
      {/* RT-855: at 0 due there is no tile; arrival focus lands on «إتمام البيع», armed. */}
      <FocusWhen
        active={arriving && zeroDue && props.noCancelHold}
        find={() => byTestId('payment-surface-complete-zero')}
        onFocused={armCommit}
      />
      {/* RT-761 / freeze 15 §3.2: arriving at Checkout puts focus on the first method tile. */}
      <FocusWhen
        active={arriving && onTenderSelection && !hasAppliedLine && props.noCancelHold}
        find={firstTile}
        onFocused={armTile}
      />
    </>
  );
}
