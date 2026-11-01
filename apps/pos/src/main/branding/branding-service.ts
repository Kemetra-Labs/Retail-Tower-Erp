/**
 * RT-475 — what the screens may see of the branding cache (spec 039 FR-33,
 * FR-35; RT-832 §2).
 *
 * The scope comes from the pairing store at call time, never from the
 * renderer:
 *  - `paired`: the tenant and the pairing epoch;
 *  - `invalid / device_revoked`: the stored epoch only. Revocation keeps the
 *    cache (FR-32), so the pairing screen can still show the tenant's logo;
 *  - `unpaired`: the unpair path. The cache is purged and nothing is shown;
 *  - any other `invalid` reason: nothing is shown and nothing is deleted.
 *
 * The snapshot carries data URIs of the server renditions only, never a path,
 * a URL, the receipt rendition or an identifier.
 */

import {
  BRANDING_NAME_MAX,
  BRANDING_NONE,
  BRANDING_SLOTS,
  type BrandingSlot,
  type BrandingSlotImage,
  type BrandingSnapshot,
} from '../../shared/branding/types.js';
import type { PairingStatus } from '../../shared/pairing-types.js';
import type { BrandingCache, BrandingCacheRead, BrandingScope } from './branding-cache.js';
import type { WireScreenRendition } from './branding-wire.js';

export interface BrandingPairing {
  getStatus(): Promise<PairingStatus>;
  /** The stored epoch whatever the status (RT-215), when the store offers it. */
  getStoredPairingEpoch?(): number | null;
}

export type ScopeResolution =
  | { readonly kind: 'scope'; readonly scope: BrandingScope }
  | { readonly kind: 'unpaired' }
  | { readonly kind: 'hidden' };

export async function resolveBrandingScope(pairing: BrandingPairing): Promise<ScopeResolution> {
  const status = await pairing.getStatus();
  if (status.kind === 'paired') {
    return { kind: 'scope', scope: { tenant_id: status.tenant_id, paired_at: status.paired_at } };
  }
  if (status.kind === 'unpaired') return { kind: 'unpaired' };
  if (status.reason !== 'device_revoked') return { kind: 'hidden' };
  const epoch = pairing.getStoredPairingEpoch?.() ?? null;
  return epoch === null
    ? { kind: 'hidden' }
    : { kind: 'scope', scope: { tenant_id: null, paired_at: epoch } };
}

/** At most {@link BRANDING_NAME_MAX} UTF-16 units, cut on a code point. */
export function boundedDisplayName(name: string): string {
  if (name.length <= BRANDING_NAME_MAX) return name;
  const points = Array.from(name);
  let out = '';
  for (const point of points) {
    if (out.length + point.length > BRANDING_NAME_MAX) break;
    out += point;
  }
  return out;
}

function dataUri(rendition: WireScreenRendition): string {
  return `data:image/png;base64,${rendition.png_base64}`;
}

function slotImages(
  screen: readonly WireScreenRendition[],
): Record<BrandingSlot, BrandingSlotImage> | null {
  const out: Partial<Record<BrandingSlot, BrandingSlotImage>> = {};
  for (const slot of BRANDING_SLOTS) {
    const x1 = screen.find((r) => r.slot === slot && r.scale === 1);
    const x2 = screen.find((r) => r.slot === slot && r.scale === 2);
    if (x1 === undefined || x2 === undefined) return null;
    out[slot] = {
      width: x1.width_px,
      height: x1.height_px,
      src1x: dataUri(x1),
      src2x: dataUri(x2),
    };
  }
  return out as Record<BrandingSlot, BrandingSlotImage>;
}

/**
 * The fallback order (RT-832 §2 over FR-35, see the RT-475 PR):
 *  - a valid logo → `logo`;
 *  - the server said `logo: null` → `none` (the slot collapses, today's screen);
 *  - a logo was stored but its record failed validation → `name`;
 *  - nothing valid cached → `none`.
 */
export function snapshotFromCache(read: BrandingCacheRead): BrandingSnapshot {
  const { name, logo } = read;
  if (name === null) return BRANDING_NONE;
  const displayName = boundedDisplayName(name.display_name);
  if (logo !== null) {
    const slots = slotImages(logo.screen);
    if (slots !== null) return { v: 1, kind: 'logo', displayName, card: logo.card, slots };
  }
  return name.logo_state === 'present' ? { v: 1, kind: 'name', displayName } : BRANDING_NONE;
}

export interface BrandingService {
  /** The current snapshot for the screens. Never throws: any fault → `none`. */
  snapshot(): Promise<BrandingSnapshot>;
}

export interface BrandingServiceDeps {
  readonly cache: Pick<BrandingCache, 'load' | 'purge'>;
  readonly pairing: BrandingPairing;
  readonly onError?: (err: unknown) => void;
}

export function createBrandingService(deps: BrandingServiceDeps): BrandingService {
  return {
    async snapshot() {
      try {
        const resolution = await resolveBrandingScope(deps.pairing);
        if (resolution.kind === 'unpaired') {
          deps.cache.purge();
          return BRANDING_NONE;
        }
        if (resolution.kind === 'hidden') return BRANDING_NONE;
        return snapshotFromCache(deps.cache.load(resolution.scope));
      } catch (err) {
        deps.onError?.(err);
        return BRANDING_NONE;
      }
    },
  };
}
