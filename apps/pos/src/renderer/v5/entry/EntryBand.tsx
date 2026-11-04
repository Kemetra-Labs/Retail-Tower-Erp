import type { JSX } from 'react';

import { RetailTowerMark } from '../brand/RetailTowerMark';
import './entry-band.css';

/**
 * RT-1096 (RT-1042 S7, OD-1 / OD-8) — the Ink band that pairing, Ready and
 * boot share: the three-bar mark on a Mint tile and the «Retail Tower»
 * wordmark. It never changes with state (DESIGN.md "Colour on the entry
 * screens"): the tenant logo, the terminal label and the powered-by line live
 * in the card or the stage, never on Ink, so OD-10's white card is not needed
 * here. No ornament: that is the sign-in band only (OD-5).
 *
 * The roles come from `[data-entry-surface]`, so a screen opts in on its own
 * root before it renders this band.
 */
export function EntryBand(): JSX.Element {
  return (
    <header className="v5-entry-band" data-testid="entry-band">
      <span className="v5-entry-band__mark" aria-hidden="true">
        <RetailTowerMark />
      </span>
      <span className="v5-entry-band__name" dir="ltr">
        Retail Tower
      </span>
    </header>
  );
}
