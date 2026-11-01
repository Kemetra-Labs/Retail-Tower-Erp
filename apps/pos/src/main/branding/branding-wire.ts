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

/** A plain object holding no key outside `keys`; null otherwise. */
function recordOf(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => keys.includes(key)) ? record : null;
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isSlot(value: unknown): value is BrandingSlot {
  return typeof value === 'string' && (BRANDING_SLOTS as readonly string[]).includes(value);
}

function isScale(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

interface Size {
  readonly width_px: number;
  readonly height_px: number;
}

/** A width and height within 1…max each; null otherwise. */
function readSize(width: unknown, height: unknown, maxW: number, maxH: number): Size | null {
  if (!isInt(width, 1, maxW)) return null;
  return isInt(height, 1, maxH) ? { width_px: width, height_px: height } : null;
}

/** The base64 when it is a PNG of exactly this size; null otherwise. */
function readPng(value: unknown, size: Size): string | null {
  if (typeof value !== 'string') return null;
  return isPngOfSize(value, size.width_px, size.height_px) ? value : null;
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

const SCREEN_KEYS = ['slot', 'scale', 'width_px', 'height_px', 'png_base64'];
const RECEIPT_KEYS = ['width_px', 'height_px', 'dpi', 'png_base64'];
const LOGO_KEYS = ['version', 'presentation', 'warnings', 'screen', 'receipt', 'updated_at'];
const BODY_KEYS = ['tenant_display_name', 'revision', 'logo'];

function readScreenRendition(value: unknown): WireScreenRendition | null {
  const record = recordOf(value, SCREEN_KEYS);
  if (record === null) return null;
  const { slot, scale } = record;
  if (!isSlot(slot) || !isScale(scale)) return null;
  // Contain-fitted inside the box × scale (OD-7), never larger.
  const box = BRANDING_SLOT_BOXES[slot];
  const size = readSize(record.width_px, record.height_px, box.width * scale, box.height * scale);
  const png = size === null ? null : readPng(record.png_base64, size);
  return png === null || size === null ? null : { slot, scale, ...size, png_base64: png };
}

/** Exactly one rendition per (slot, scale) pair: 8 in all. */
export function readScreenSet(value: unknown): WireScreenRendition[] | null {
  if (!Array.isArray(value) || value.length !== BRANDING_SLOTS.length * 2) return null;
  const out: WireScreenRendition[] = [];
  for (const item of value) {
    const rendition = readScreenRendition(item);
    if (rendition === null) return null;
    out.push(rendition);
  }
  const pairs = new Set(out.map((r) => `${r.slot}@${String(r.scale)}`));
  return pairs.size === out.length ? out : null;
}

export function readReceiptRendition(value: unknown): WireReceiptRendition | null {
  const record = recordOf(value, RECEIPT_KEYS);
  if (record === null || !isInt(record.dpi, 100, 600)) return null;
  const size = readSize(record.width_px, record.height_px, 1133, 354);
  const png = size === null ? null : readPng(record.png_base64, size);
  return png === null || size === null ? null : { ...size, dpi: record.dpi, png_base64: png };
}

function isWarning(value: unknown): value is LogoWarning {
  return (LOGO_WARNINGS as readonly unknown[]).includes(value);
}

export function readWarnings(value: unknown): LogoWarning[] | null {
  if (!Array.isArray(value) || !value.every(isWarning)) return null;
  return new Set(value).size === value.length ? value : null;
}

/** The version, card and save time; null when any is off-contract. */
function readLogoHeader(
  record: Record<string, unknown>,
): Omit<WireLogo, 'warnings' | 'screen' | 'receipt'> | null {
  const { version, presentation, updated_at } = record;
  if (typeof version !== 'string' || !HEX64.test(version)) return null;
  const card = recordOf(presentation, ['card'])?.card;
  if (typeof card !== 'boolean') return null;
  return isDateTime(updated_at) ? { version, card, updated_at } : null;
}

/** The warnings and renditions; null when any is off-contract. */
function readLogoAssets(
  record: Record<string, unknown>,
): Pick<WireLogo, 'warnings' | 'screen' | 'receipt'> | null {
  const warnings = readWarnings(record.warnings);
  const screen = readScreenSet(record.screen);
  const receipt = readReceiptRendition(record.receipt);
  if (warnings === null || screen === null) return null;
  return receipt === null ? null : { warnings, screen, receipt };
}

function readLogo(value: unknown): WireLogo | null {
  const record = recordOf(value, LOGO_KEYS);
  if (record === null) return null;
  const header = readLogoHeader(record);
  const assets = header === null ? null : readLogoAssets(record);
  if (header === null || assets === null) return null;
  // FR-11: low_contrast forces the card.
  const cardForced = assets.warnings.includes('low_contrast');
  return cardForced && !header.card ? null : { ...header, ...assets };
}

/** The 200 body, or null when it is off-contract in any way. */
export function readBrandingBody(value: unknown): WireBranding | null {
  const record = recordOf(value, BODY_KEYS);
  if (record === null) return null;
  const { tenant_display_name, revision } = record;
  if (typeof tenant_display_name !== 'string' || tenant_display_name.length === 0) return null;
  if (!isInt(revision, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (record.logo === null) return { tenant_display_name, revision, logo: null };
  // A stored logo means at least one write happened.
  const logo = revision < 1 ? null : readLogo(record.logo);
  return logo === null ? null : { tenant_display_name, revision, logo };
}
