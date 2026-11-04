import type { JSX } from 'react';

import { BrandSlot, PoweredBy } from '../../branding/BrandSlot';
import { useBranding } from '../../branding/branding-store';
import { EntryBand } from '../entry/EntryBand';
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
 *
 * RT-1096 (RT-1042 S7): the root opts into the entry-surface roles and carries
 * the Ink band above the stage. The logo stays in the stage on the light
 * canvas, never on Ink.
 */
export function RouteLoading(): JSX.Element {
  const branding = useBranding();
  return (
    <main
      className="v5-route-state v5-route-state--entry"
      data-testid="route-loading"
      data-entry-surface=""
      aria-busy="true"
      dir="rtl"
      lang="ar"
    >
      <EntryBand />
      <div className="v5-route-state__stage">
        <div className="v5-route-state__stack">
          <BrandSlot slot="boot" snapshot={branding} />
          <output className="v5-route-state__status">
            <span className="v5-route-state__spinner" aria-hidden="true" />
            جارٍ التحميل…
          </output>
          <PoweredBy snapshot={branding} />
        </div>
      </div>
    </main>
  );
}
