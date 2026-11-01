/**
 * RT-475 — the `posGetTenantBranding` body (RT-473 `tenant-branding.openapi.yaml`)
 * read strictly, plus the two local checks the cache needs (spec 039 FR-18,
 * FR-35a): the ETag recomputed from the name and the revision, and a PNG
 * header check that stands in for "the rendition decodes" (main has no image
 * decoder; the renderer's `<img onError>` is the last line).
 *
 * Every function is pure and never throws on untrusted input.
 */

import { createHash } from 'node:crypto';

import {
  BRANDING_SLOTS,
  BRANDING_SLOT_BOXES,
  type BrandingSlot,
} from '../../shared/branding/types.js';

export const LOGO_WARNINGS = [
  'low_contrast',
  'receipt_high_black_coverage',
  'receipt_thin_strokes',
] as const;
export type LogoWarning = (typeof LOGO_WARNINGS)[number];

export interface WireScreenRendition {
  readonly slot: BrandingSlot;
  readonly scale: 1 | 2;
  readonly width_px: number;
  readonly height_px: number;
  readonly png_base64: string;
}

export interface WireReceiptRendition {
  readonly width_px: number;
  readonly height_px: number;
  readonly dpi: number;
  readonly png_base64: string;
}

export interface WireLogo {
  readonly version: string;
  readonly card: boolean;
  readonly warnings: readonly LogoWarning[];
  readonly screen: readonly WireScreenRendition[];
  readonly receipt: WireReceiptRendition;
  readonly updated_at: string;
}

export interface WireBranding {
  readonly tenant_display_name: string;
  readonly revision: number;
  readonly logo: WireLogo | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** The FR-18 ETag: `"` + hex SHA-256 of `UTF8(name) 0x00 ASCII(revision)` + `"`. */
export function brandingEtag(name: string, revision: number): string {
  const digest = createHash('sha256')
    .update(Buffer.from(name, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(String(revision), 'ascii'))
    .digest('hex');
  return `"${digest}"`;
}

/**
 * True when the base64 is a PNG whose IHDR (the first chunk) states exactly
 * this width and height. A truncated, re-typed or mis-sized rendition fails.
 */
export function isPngOfSize(base64: string, width: number, height: number): boolean {
  if (!BASE64.test(base64)) return false;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  return bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height;
}

function readScreenRendition(value: unknown): WireScreenRendition | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ['slot', 'scale', 'width_px', 'height_px', 'png_base64'])) return null;
  const { slot, scale, width_px, height_px, png_base64 } = value;
  if (typeof slot !== 'string' || !(BRANDING_SLOTS as readonly string[]).includes(slot)) {
    return null;
  }
  if (scale !== 1 && scale !== 2) return null;
  const box = BRANDING_SLOT_BOXES[slot as BrandingSlot];
  // Contain-fitted inside the box × scale (OD-7), never larger.
  if (!isInt(width_px, 1, box.width * scale) || !isInt(height_px, 1, box.height * scale)) {
    return null;
  }
  if (typeof png_base64 !== 'string' || !isPngOfSize(png_base64, width_px, height_px)) {
    return null;
  }
  return { slot: slot as BrandingSlot, scale, width_px, height_px, png_base64 };
}

/** Exactly one rendition per (slot, scale) pair: 8 in all. */
export function readScreenSet(value: unknown): WireScreenRendition[] | null {
  if (!Array.isArray(value) || value.length !== BRANDING_SLOTS.length * 2) return null;
  const seen = new Set<string>();
  const out: WireScreenRendition[] = [];
  for (const item of value) {
    const rendition = readScreenRendition(item);
    if (rendition === null) return null;
    const key = `${rendition.slot}@${String(rendition.scale)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(rendition);
  }
  return out;
}

export function readReceiptRendition(value: unknown): WireReceiptRendition | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['width_px', 'height_px', 'dpi', 'png_base64'])) {
    return null;
  }
  const { width_px, height_px, dpi, png_base64 } = value;
  if (!isInt(width_px, 1, 1133) || !isInt(height_px, 1, 354) || !isInt(dpi, 100, 600)) {
    return null;
  }
  if (typeof png_base64 !== 'string' || !isPngOfSize(png_base64, width_px, height_px)) {
    return null;
  }
  return { width_px, height_px, dpi, png_base64 };
}

export function readWarnings(value: unknown): LogoWarning[] | null {
  if (!Array.isArray(value)) return null;
  const out: LogoWarning[] = [];
  for (const item of value) {
    if (!(LOGO_WARNINGS as readonly unknown[]).includes(item)) return null;
    if (out.includes(item as LogoWarning)) return null;
    out.push(item as LogoWarning);
  }
  return out;
}

function readLogo(value: unknown): WireLogo | null {
  if (!isRecord(value)) return null;
  const keys = ['version', 'presentation', 'warnings', 'screen', 'receipt', 'updated_at'];
  if (!hasOnlyKeys(value, keys)) return null;
  const { version, presentation, updated_at } = value;
  if (typeof version !== 'string' || !HEX64.test(version)) return null;
  if (!isRecord(presentation) || typeof presentation.card !== 'boolean') return null;
  if (typeof updated_at !== 'string' || Number.isNaN(Date.parse(updated_at))) return null;
  const warnings = readWarnings(value.warnings);
  const screen = readScreenSet(value.screen);
  const receipt = readReceiptRendition(value.receipt);
  if (warnings === null || screen === null || receipt === null) return null;
  // FR-11: low_contrast forces the card.
  if (warnings.includes('low_contrast') && !presentation.card) return null;
  return { version, card: presentation.card, warnings, screen, receipt, updated_at };
}

/** The 200 body, or null when it is off-contract in any way. */
export function readBrandingBody(value: unknown): WireBranding | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tenant_display_name', 'revision', 'logo'])) {
    return null;
  }
  const { tenant_display_name, revision } = value;
  if (typeof tenant_display_name !== 'string' || tenant_display_name.length === 0) return null;
  if (!isInt(revision, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (value.logo === null) return { tenant_display_name, revision, logo: null };
  const logo = readLogo(value.logo);
  // A stored logo means at least one write happened.
  if (logo === null || revision < 1) return null;
  return { tenant_display_name, revision, logo };
}
