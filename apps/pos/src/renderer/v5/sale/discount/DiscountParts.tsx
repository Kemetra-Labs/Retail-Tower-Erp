import type { JSX } from 'react';

import { parseManualDiscountToken } from '../../../../shared/cart/manual-discount';
import { formatHumanMoney } from '../../../ui/format/human-format';
import { DISCOUNT_COPY } from './discount-copy';

/**
 * RT-855 — the discount's label, as OD-28-11 words it: «خصم 10%» for a
 * percent, «خصم» alone for an amount. The percent is its own LTR run
 * (`<bdi dir="ltr">`), so it reads «خصم 100%» on every surface and never
 * «خصم %100» (the correction the D1 sign-off asks of RT-855, comment 13740).
 * A token this renderer cannot read shows «خصم» alone: never a guessed value.
 */
export function DiscountKindLabel({ token }: Readonly<{ token: string | null }>): JSX.Element {
  const discount = token === null ? null : parseManualDiscountToken(token);
  return (
    <span className="v5-discount-kind">
      {DISCOUNT_COPY.discount}
      {discount?.kind === 'percent' && (
        <>
          {' '}
          <bdi dir="ltr">{`${String(discount.value)}%`}</bdi>
        </>
      )}
    </span>
  );
}

/** A discount amount as a money run with the minus sign (U+2212); «—» when unknown. */
export function DiscountAmount({
  minor,
  className,
}: Readonly<{ minor: number | null; className?: string }>): JSX.Element {
  return (
    <bdi dir="ltr" className={className}>
      {minor === null ? '—' : formatHumanMoney(-minor)}
    </bdi>
  );
}
