import type { JSX } from 'react';

import { BrandSlot, PoweredBy } from '../../branding/BrandSlot';
import { useBranding } from '../../branding/branding-store';
import './route-states.css';

/**
 * RT-241 (VNext W1-A, VN-S2) — the boot loading surface. Never blank: the
 * screen says what it is doing while `pairing.getStatus()` decides the start
 * route. It renders before any frame exists, so it sets its own direction and
 * language. Routing semantics are unchanged; this is presentation only.
 *
 * RT-475 (RT-832 `boot`): with a cached tenant logo, the logo, 24px, the
 * status and the powered-by line 24px below, centred as one stack. Read from
 * the local cache only (FR-36); the load never waits on it.
 */
export function RouteLoading(): JSX.Element {
  const branding = useBranding();
  return (
    <main
      className="v5-route-state"
      data-testid="route-loading"
      aria-busy="true"
      dir="rtl"
      lang="ar"
    >
      <div className="v5-route-state__stack">
        <BrandSlot slot="boot" snapshot={branding} />
        <output className="v5-route-state__status">
          <span className="v5-route-state__spinner" aria-hidden="true" />
          جارٍ التحميل…
        </output>
        <PoweredBy snapshot={branding} />
      </div>
    </main>
  );
}
