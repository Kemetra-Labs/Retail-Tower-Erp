import type { JSX } from 'react';

import type { BrandingSnapshot } from '../../../shared/branding/types';
import { BrandSlot, PoweredBy } from '../../branding/BrandSlot';
import { EntryBand } from './EntryBand';
import { SIGN_IN_COPY } from './entry-copy';

/**
 * RT-1092 (RT-1042 S3) — the sign-in screen's Ink band: the one entry band
 * (`EntryBand`, RT-1096) with what sign-in adds on it. It keeps the former
 * strip's test ids (`entry-strip`, `entry-terminal-label`).
 *
 * - No logo: the band's own mark and «Retail Tower» (OD-8).
 * - With a logo: the RT-832 `sign_in` slot replaces them, always on the white
 *   card on Ink (OD-10, sign-in.css), and the powered-by line sits at the
 *   inline end.
 * - The terminal label is admin free text, isolated with `<bdi>`.
 * - The band never changes with state (Brand-Yields-To-Truth).
 */
export function SignInBand({
  terminalLabel,
  branding,
}: Readonly<{ terminalLabel?: string; branding?: BrandingSnapshot }>): JSX.Element {
  const branded = branding?.kind === 'logo';
  return (
    <EntryBand
      testId="entry-strip"
      {...(branded ? { brand: <BrandSlot slot="sign_in" snapshot={branding} /> } : {})}
    >
      {terminalLabel !== undefined && terminalLabel.length > 0 && (
        <>
          <span className="v5-signin__sep" aria-hidden="true" />
          <span className="v5-signin__context" data-testid="entry-terminal-label">
            {SIGN_IN_COPY.terminal}{' '}
            <b>
              <bdi>{terminalLabel}</bdi>
            </b>
          </span>
        </>
      )}
      <PoweredBy snapshot={branding} className="v5-signin__powered-by" />
    </EntryBand>
  );
}
