import { useState, type JSX } from 'react';

import type { BrandingSlot, BrandingSnapshot } from '../../shared/branding/types';
import './brand-slot.css';

/**
 * RT-475 — one tenant-logo slot (RT-832 §1–§2, spec 039 FR-34/FR-35).
 *
 * - `logo`: the 1x rendition at its own size (srcset 1x/2x), centred or at the
 *   inline start of a fixed box, never stretched, cropped or upscaled. On a
 *   white card when `card` is set, and always under forced colours.
 * - `name` (or a logo that fails to decode): the tenant name as text in the
 *   same box, ellipsised.
 * - `none` or not read yet: nothing at all. The slot collapses and the screen
 *   is exactly today's (RT-832 "No logo").
 */
export function BrandSlot({
  slot,
  snapshot,
}: Readonly<{ slot: BrandingSlot; snapshot: BrandingSnapshot | undefined }>): JSX.Element | null {
  const [broken, setBroken] = useState<string | null>(null);
  if (snapshot === undefined || snapshot.kind === 'none') return null;
  const image = snapshot.kind === 'logo' ? snapshot.slots[slot] : null;
  const showImage = image !== null && broken !== image.src1x;
  const card = snapshot.kind === 'logo' && snapshot.card;
  return (
    <div
      className={`v5-brand-slot v5-brand-slot--${slot}${card ? ' v5-brand-slot--card' : ''}`}
      data-testid={`brand-slot-${slot}`}
      data-brand-kind={showImage ? 'logo' : 'name'}
    >
      <div className="v5-brand-slot__box">
        {showImage ? (
          <img
            className="v5-brand-slot__img"
            src={image.src1x}
            srcSet={`${image.src1x} 1x, ${image.src2x} 2x`}
            width={image.width}
            height={image.height}
            alt={snapshot.displayName}
            draggable={false}
            onError={() => {
              setBroken(image.src1x);
            }}
          />
        ) : (
          <span className="v5-brand-slot__name" dir="auto">
            {snapshot.displayName}
          </span>
        )}
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
