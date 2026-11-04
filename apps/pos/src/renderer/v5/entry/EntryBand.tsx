import type { JSX, ReactNode } from 'react';

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
 *
 * RT-1092 (RT-1042 S3) — the sign-in screen renders the same band, with three
 * optional additions; with none of them the band is exactly the one above:
 * - `brand` replaces the mark and the wordmark (the tenant logo, which the
 *   sign-in stylesheet puts on the white card, OD-10);
 * - `children` follow the brand (the terminal label and the powered-by line);
 * - `testId` replaces `entry-band` (sign-in keeps its strip's `entry-strip`).
 */
export function EntryBand({
  brand,
  children,
  testId = 'entry-band',
}: Readonly<{ brand?: ReactNode; children?: ReactNode; testId?: string }>): JSX.Element {
  return (
    <header className="v5-entry-band" data-testid={testId}>
      {brand ?? (
        <>
          <span className="v5-entry-band__mark" aria-hidden="true">
            <RetailTowerMark />
          </span>
          <span className="v5-entry-band__name" dir="ltr">
            Retail Tower
          </span>
        </>
      )}
      {children}
    </header>
  );
}
