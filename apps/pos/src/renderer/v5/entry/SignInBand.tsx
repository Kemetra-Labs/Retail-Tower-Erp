import type { JSX } from 'react';

import type { BrandingSnapshot } from '../../../shared/branding/types';
import { BrandSlot, PoweredBy } from '../../branding/BrandSlot';
import { SIGN_IN_COPY } from './entry-copy';

/**
 * RT-1092 (RT-1042 S3) — the sign-in screen's Ink band (B-lite, DESIGN.md
 * "Entry screens"). It replaces the sign-in screen's light context strip; the
 * Ready and pairing screens keep `EntryStrip` until their own slice (S7).
 *
 * - No logo: the three-bar placeholder mark on a Mint tile and «Retail Tower»
 *   (OD-8), until the owner supplies the new product logo.
 * - With a logo: the RT-832 `sign_in` slot, always on the white card on Ink
 *   (OD-10, styled in sign-in.css), and the powered-by line at the inline end.
 * - The terminal label is admin free text, isolated with `<bdi>`.
 * - The band never changes with state (Brand-Yields-To-Truth). It keeps the
 *   strip's test ids, and its content sits in one inner row so the S4 ornament
 *   (RT-1093) can sit behind it.
 */
export function SignInBand({
  terminalLabel,
  branding,
}: Readonly<{ terminalLabel?: string; branding?: BrandingSnapshot }>): JSX.Element {
  const branded = branding?.kind === 'logo';
  return (
    <header className="v5-signin__band" data-testid="entry-strip">
      <div className="v5-signin__band-row">
        {branded ? (
          <BrandSlot slot="sign_in" snapshot={branding} />
        ) : (
          <span className="v5-signin__brand">
            <span className="v5-signin__mark" aria-hidden="true">
              <PlaceholderMark />
            </span>
            <span className="v5-signin__product v5-ltr">Retail Tower</span>
          </span>
        )}
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
      </div>
    </header>
  );
}

/** The three rising bars: a placeholder until the new product logo exists (OD-8). */
function PlaceholderMark(): JSX.Element {
  return (
    <svg
      className="v5-signin__mark-glyph"
      viewBox="0 0 64 64"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="8" y="36" width="12" height="20" rx="3" />
      <rect x="26" y="22" width="12" height="34" rx="3" />
      <rect x="44" y="8" width="12" height="48" rx="3" />
    </svg>
  );
}
