import { useEffect, type JSX } from 'react';

import {
  AVAILABILITY_REFRESH_LABEL,
  availabilityBadge,
  availabilityStatus,
} from '../../availability/availability-copy';
import { focusScanOwner } from '../../scan/scan-anchor';
import {
  AVAILABILITY_REREAD_INTERVAL_MS,
  useAvailabilityStore,
} from '../../stores/availability-store';

/**
 * RT-1578 (RT-1511 S3, spec 013) — the availability badge and its status line, display only.
 *
 * Nothing here can block, hold or confirm a sale (FR-5): the badge is a `span` inside a row that already adds
 * directly (D-C1), and the status line's one button only asks main for a fresh read. Owner-approved UX
 * (RT-1578 comment 18614): band only, never the number; neutral «متوفر», warning tones never red; freshness
 * stated once, on the status line, never on every row; no live-region announcement and no motion.
 */

/** The badge of one product, in the `.v5-live-flag` slot after the Rx and controlled-substance flags. */
export function AvailabilityBadge({
  productId,
}: Readonly<{ productId: string | undefined }>): JSX.Element | null {
  const track = useAvailabilityStore((s) => s.track);
  const state = useAvailabilityStore((s) =>
    productId === undefined ? undefined : s.states[productId],
  );
  useEffect(() => {
    if (productId !== undefined) track(productId);
  }, [productId, track]);
  if (state === undefined) return null;
  const badge = availabilityBadge(state);
  return (
    <span
      className="v5-live-flag v5-live-flag--availability"
      data-availability={state}
      data-tone={badge.tone}
    >
      {badge.text}
    </span>
  );
}

/** The availability line under the command bar, beside the catalogue freshness, with «تحديث التوفر». */
export function AvailabilityBar(): JSX.Element {
  const freshness = useAvailabilityStore((s) => s.freshness);
  const refreshing = useAvailabilityStore((s) => s.refreshing);
  const reload = useAvailabilityStore((s) => s.reload);
  const refresh = useAvailabilityStore((s) => s.refresh);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      void reload();
    }, AVAILABILITY_REREAD_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [reload]);
  const status = availabilityStatus(freshness, refreshing);
  return (
    <div className="v5-live-availability" data-tone={status?.tone ?? 'neutral'}>
      {status !== null && <span>{status.text}</span>}
      <button
        type="button"
        className="v5-btn v5-btn--quiet v5-live-availability-refresh"
        disabled={refreshing}
        onClick={() => {
          void refresh();
          focusScanOwner();
        }}
      >
        {AVAILABILITY_REFRESH_LABEL}
      </button>
    </div>
  );
}
