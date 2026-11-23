import type { JSX } from 'react';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import { AvailabilityBadge } from './AvailabilityParts';

/**
 * Display-only awareness badges; each carries its own text so meaning never rests on colour. The Rx and
 * controlled-substance flags read first (pharmacy safety); the availability badge (RT-1578, spec 013) follows
 * them in the same slot when a `productId` is given. No badge here can block or confirm a sale.
 */
export function SaleProductFlags({
  product,
  productId,
}: Readonly<{
  product:
    | Pick<ProductSnapshotDisplay, 'controlled_substance' | 'prescription_required'>
    | undefined;
  productId?: string | undefined;
}>): JSX.Element | null {
  const flagged = product?.controlled_substance === true || product?.prescription_required === true;
  if (!flagged && productId === undefined) return null;
  return (
    <span className="v5-live-flags">
      {product?.controlled_substance === true && (
        <span className="v5-live-flag v5-live-flag--controlled">مادة خاضعة للرقابة</span>
      )}
      {product?.prescription_required === true && (
        <span className="v5-live-flag v5-live-flag--rx">بوصفة طبية</span>
      )}
      <AvailabilityBadge productId={productId} />
    </span>
  );
}
