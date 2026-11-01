/**
 * RT-475 — the tenant branding bridge contract (spec 039 FR-33).
 *
 * Two channels: `branding:get` (invoke, `{}` only) and `branding:changed`
 * (push, main → renderer). Both carry one `BrandingSnapshot` built from the
 * local cache. The logo reaches the renderer only as `data:image/png;base64,…`
 * URIs of the server-encoded renditions: never a file path, never a network
 * URL, never the receipt rendition, never an identifier.
 *
 * Kinds (RT-832 §2; owner decision 2026-11-01: no name-as-text state):
 *  - `logo`: a valid cached logo. The screens show it, and the powered-by line.
 *    `displayName` is the image's alt text only.
 *  - `none`: no usable logo (`logo: null`, a missing or corrupt cache, first
 *    boot) or the terminal is not paired. Every screen is exactly today's.
 */

export const BRANDING_IPC_CHANNELS = {
  GET: 'branding:get',
  CHANGED: 'branding:changed',
} as const;

/** The four screen slots (`ScreenRendition.slot`, OD-7). */
export const BRANDING_SLOTS = ['boot', 'pairing', 'sign_in', 'lock'] as const;
export type BrandingSlot = (typeof BRANDING_SLOTS)[number];

/** The approved slot boxes in CSS px, including the 8% clear space (RT-832 §1). */
export const BRANDING_SLOT_BOXES: Readonly<
  Record<BrandingSlot, { readonly width: number; readonly height: number }>
> = {
  boot: { width: 240, height: 120 },
  pairing: { width: 200, height: 80 },
  sign_in: { width: 128, height: 32 },
  lock: { width: 200, height: 80 },
};

/** One slot's renditions: the 1x size in CSS px and the two image sources. */
export interface BrandingSlotImage {
  readonly width: number;
  readonly height: number;
  readonly src1x: string;
  readonly src2x: string;
}

export type BrandingSnapshot =
  | { readonly v: 1; readonly kind: 'none' }
  | {
      readonly v: 1;
      readonly kind: 'logo';
      readonly displayName: string;
      /** `presentation.card`: the logo sits on a white card. */
      readonly card: boolean;
      readonly slots: Readonly<Record<BrandingSlot, BrandingSlotImage>>;
    };

export const BRANDING_NONE: BrandingSnapshot = { v: 1, kind: 'none' };

/** `branding:get` with anything but `{}` (INP-1). */
export const BRANDING_INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
export type BrandingInvalid = typeof BRANDING_INVALID;

/** Longest display name the bridge carries (OD-10: 80, the POS ellipsises). */
export const BRANDING_NAME_MAX = 80;

const DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function isPngDataUri(value: unknown): value is string {
  return typeof value === 'string' && DATA_URI.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= BRANDING_NAME_MAX;
}

function isDimension(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function parseSlotImage(value: unknown, slot: BrandingSlot): BrandingSlotImage | null {
  if (!isRecord(value)) return null;
  const { width, height, src1x, src2x } = value;
  const box = BRANDING_SLOT_BOXES[slot];
  if (!isDimension(width, box.width) || !isDimension(height, box.height)) return null;
  if (!isPngDataUri(src1x) || !isPngDataUri(src2x)) return null;
  return { width, height, src1x, src2x };
}

function parseSlots(value: unknown): Record<BrandingSlot, BrandingSlotImage> | null {
  if (!isRecord(value)) return null;
  const slots: Partial<Record<BrandingSlot, BrandingSlotImage>> = {};
  for (const slot of BRANDING_SLOTS) {
    const image = parseSlotImage(value[slot], slot);
    if (image === null) return null;
    slots[slot] = image;
  }
  return slots as Record<BrandingSlot, BrandingSlotImage>;
}

function parseLogo(payload: Record<string, unknown>): BrandingSnapshot | null {
  const { displayName, card } = payload;
  if (!isDisplayName(displayName) || typeof card !== 'boolean') return null;
  const slots = parseSlots(payload.slots);
  return slots === null ? null : { v: 1, kind: 'logo', displayName, card, slots };
}

const PARSERS: Readonly<
  Record<BrandingSnapshot['kind'], (payload: Record<string, unknown>) => BrandingSnapshot | null>
> = {
  none: () => BRANDING_NONE,
  logo: parseLogo,
};

function isKind(value: unknown): value is BrandingSnapshot['kind'] {
  return value === 'none' || value === 'logo';
}

/**
 * The snapshot rebuilt from known fields only; null when anything fails.
 * Used by the preload on every answer and push, so the renderer never sees an
 * unchecked value (a non-PNG URI, an oversized box, an unknown kind).
 */
export function parseBrandingSnapshot(payload: unknown): BrandingSnapshot | null {
  if (!isRecord(payload) || payload.v !== 1) return null;
  return isKind(payload.kind) ? PARSERS[payload.kind](payload) : null;
}
