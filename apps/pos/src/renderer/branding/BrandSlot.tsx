import type { JSX } from 'react';

import type { BrandingSlot, BrandingSnapshot } from '../../shared/branding/types';
import { dropUndecodableBranding } from './branding-store';
import './brand-slot.css';

/**
 * RT-475 — one tenant-logo slot (RT-832 §1–§2, spec 039 FR-34).
 *
 * - `logo`: the 1x rendition at its own size (srcset 1x/2x), centred or at the
 *   inline start of a fixed box, never stretched, cropped or upscaled. On a
 *   white card when `card` is set, and always under forced colours.
 * - `none` or not read yet: nothing at all. The slot collapses and the screen
 *   is exactly today's (RT-832 "No logo"; owner decision 2026-11-01: there is
 *   no name-as-text state).
 *
 * A rendition that fails to decode drops the snapshot for every screen, so no
 * broken image and no stray powered-by line is ever shown.
 */
export function BrandSlot({
  slot,
  snapshot,
}: Readonly<{ slot: BrandingSlot; snapshot: BrandingSnapshot | undefined }>): JSX.Element | null {
  if (snapshot?.kind !== 'logo') return null;
  const image = snapshot.slots[slot];
  return (
    <div
      className={`v5-brand-slot v5-brand-slot--${slot}${snapshot.card ? ' v5-brand-slot--card' : ''}`}
      data-testid={`brand-slot-${slot}`}
    >
      <div className="v5-brand-slot__box">
        <img
          className="v5-brand-slot__img"
          src={image.src1x}
          srcSet={`${image.src1x} 1x, ${image.src2x} 2x`}
          width={image.width}
          height={image.height}
          alt={snapshot.displayName}
          draggable={false}
          onError={() => {
            dropUndecodableBranding(snapshot);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The powered-by line «بدعم من Retail Tower» (OD-12, RT-832 §2): shown only
 * with a logo, never as a placeholder. The product name is isolated LTR.
 */
export function PoweredBy({
  snapshot,
  className,
}: Readonly<{ snapshot: BrandingSnapshot | undefined; className?: string }>): JSX.Element | null {
  if (snapshot?.kind !== 'logo') return null;
  return (
    <p
      className={`v5-powered-by${className === undefined ? '' : ` ${className}`}`}
      data-testid="powered-by"
    >
      بدعم من{' '}
      <bdi dir="ltr" className="v5-powered-by__name">
        Retail Tower
      </bdi>
    </p>
  );
}
