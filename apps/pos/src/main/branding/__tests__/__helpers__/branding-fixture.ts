/**
 * RT-475 — test fixtures for the branding cache: contract-shaped
 * `posGetTenantBranding` bodies with real PNG headers, a fake pairing store and
 * a fetch that answers from a script.
 */
import type { PairingStatus } from '../../../../shared/pairing-types.js';
import type { BrandingSlot } from '../../../../shared/branding/types.js';
import type { FetchLike } from '../../../http/transport.js';

/** A minimal PNG (signature, IHDR, IEND) of this size; `tag` makes the bytes distinct. */
export function pngBase64(width: number, height: number, tag = 0): string {
  const bytes = Buffer.alloc(8 + 25 + 12 + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  bytes.writeUInt8(6, 25);
  bytes.writeUInt32BE(0, 33);
  bytes.write('IEND', 37, 'ascii');
  bytes.writeUInt8(tag & 0xff, 45);
  return bytes.toString('base64');
}

/** 1x sizes of a 4:1 logo contain-fitted in each box (RT-832 §1). */
const WIDE_1X: Record<BrandingSlot, [number, number]> = {
  boot: [240, 60],
  pairing: [200, 50],
  sign_in: [128, 32],
  lock: [200, 50],
};

export const VERSION_A = 'a'.repeat(64);
export const VERSION_B = 'b'.repeat(64);

export interface BodyOptions {
  name?: string;
  revision?: number;
  version?: string;
  card?: boolean;
  warnings?: string[];
  tag?: number;
}

export function screenSet(tag: number): Record<string, unknown>[] {
  return (Object.keys(WIDE_1X) as BrandingSlot[]).flatMap((slot) => {
    const [w, h] = WIDE_1X[slot];
    return [1, 2].map((scale) => ({
      slot,
      scale,
      width_px: w * scale,
      height_px: h * scale,
      png_base64: pngBase64(w * scale, h * scale, tag),
    }));
  });
}

export function logoBody(options: BodyOptions = {}): Record<string, unknown> {
  const tag = options.tag ?? 1;
  return {
    tenant_display_name: options.name ?? 'صيدلية النور',
    revision: options.revision ?? 1,
    logo: {
      version: options.version ?? VERSION_A,
      presentation: { card: options.card ?? false },
      warnings: options.warnings ?? [],
      screen: screenSet(tag),
      receipt: { width_px: 383, height_px: 119, dpi: 203, png_base64: pngBase64(383, 119, tag) },
      updated_at: '2026-11-01T08:00:00.000Z',
    },
  };
}

export function noLogoBody(name = 'صيدلية النور', revision = 2): Record<string, unknown> {
  return { tenant_display_name: name, revision, logo: null };
}

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';

export function paired(tenantId: string, pairedAt: number): PairingStatus {
  return {
    kind: 'paired',
    tenant_id: tenantId,
    branch_id: 'branch-1',
    terminal_id: 'terminal-1',
    terminal_label: 'POS-03',
    paired_at: pairedAt,
  };
}

/** A mutable fake pairing store. */
export function fakePairing(initial: PairingStatus, storedEpoch: number | null = null) {
  const state = { status: initial, storedEpoch };
  return {
    state,
    getStatus: () => Promise.resolve(state.status),
    getStoredPairingEpoch: () => state.storedEpoch,
  };
}

export interface ScriptedFetch {
  fetch: FetchLike;
  /** The `If-None-Match` header of each request, in order (null when absent). */
  readonly sent: (string | null)[];
}

/** Each call takes the next answer: a body + status, or 'offline' (rejects). */
export function scriptedFetch(
  answers: ({ status: number; body?: unknown } | 'offline')[],
): ScriptedFetch {
  const sent: (string | null)[] = [];
  const fetch: FetchLike = (_input, init) => {
    const headers = new Headers(init?.headers);
    sent.push(headers.get('If-None-Match'));
    const next = answers.shift();
    if (next === undefined || next === 'offline') {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const body = next.body === undefined ? null : JSON.stringify(next.body);
    return Promise.resolve(new Response(body, { status: next.status }));
  };
  return { fetch, sent };
}

export const silentLogger = { info: () => undefined, warn: () => undefined };
