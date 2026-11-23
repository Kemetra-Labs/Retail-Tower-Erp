/**
 * RT-1578 (RT-1511 S3) — the Backend-Core store-availability client (`posGetStoreAvailability`,
 * `inventory/pos-availability.yaml`, RT-1577):
 *
 *   GET /api/pos/v1/inventory/availability?branch_id=&cursor=&limit=
 *
 * GET only: this client has no write, reservation or stock call of any kind (spec 013 FR-6). Auth is the
 * device bearer (FR-8), read in-process through the injected reader and never logged or bridged. The HTTP
 * exchange runs on the shared Backend-Core transport (RT-880).
 *
 * Outcome mapping: 200 readable → ok · 200 off-contract → failed · 401 → unauthorized · any other status →
 * failed · network, timeout or no credential → unreachable. Never throws.
 */

import { createBackendTransport, type FetchLike } from '../http/transport.js';

export const AVAILABILITY_PATH = '/api/pos/v1/inventory/availability';
const REQUEST_TIMEOUT_MS = 30_000;
/** 1000 items at roughly 150 bytes each is far below this; it bounds memory on an untrusted answer. */
const MAX_BODY_BYTES = 2_000_000;
const PAGE_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?\d{1,15}(\.\d{1,4})?$/;

export type WireBand = 'in_stock' | 'low' | 'out';

export interface WireAvailabilityItem {
  readonly productId: string;
  readonly availableToSell: string;
  readonly band: WireBand;
}

export interface WireAvailabilityPage {
  readonly storeId: string;
  readonly asOf: string;
  readonly items: readonly WireAvailabilityItem[];
  readonly nextCursor: string | null;
}

export type PageOutcome =
  | { readonly kind: 'ok'; readonly page: WireAvailabilityPage }
  | { readonly kind: 'unauthorized' | 'failed' | 'unreachable' };

export interface AvailabilityClient {
  fetchPage(branchId: string, cursor: string | null): Promise<PageOutcome>;
}

export interface CreateAvailabilityClientDeps {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** The sendable device token (null when unpaired or revoked → no request). */
  readonly readToken: () => Promise<string | null>;
}

function isBand(value: unknown): value is WireBand {
  return value === 'in_stock' || value === 'low' || value === 'out';
}

function readItem(raw: unknown): WireAvailabilityItem | null {
  const v = (raw ?? {}) as Record<string, unknown>;
  const { productId, availableToSell, band } = v;
  if (typeof productId !== 'string' || !UUID.test(productId)) return null;
  if (typeof availableToSell !== 'string' || !DECIMAL.test(availableToSell)) return null;
  if (!isBand(band)) return null;
  return { productId, availableToSell, band };
}

/** The page when the body matches the contract, else null (a malformed page fails the whole refresh). */
function readAvailabilityPage(json: unknown): WireAvailabilityPage | null {
  const v = (json ?? {}) as Record<string, unknown>;
  const { storeId, asOf, items, nextCursor } = v;
  if (typeof storeId !== 'string' || typeof asOf !== 'string') return null;
  if (Number.isNaN(Date.parse(asOf)) || !Array.isArray(items)) return null;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) {
    return null;
  }
  const read = items.map(readItem);
  if (read.includes(null)) return null;
  return { storeId, asOf, items: read as WireAvailabilityItem[], nextCursor };
}

export function createAvailabilityClient(deps: CreateAvailabilityClientDeps): AvailabilityClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBodyBytes: MAX_BODY_BYTES,
  });

  return {
    async fetchPage(branchId, cursor) {
      const query = new URLSearchParams({ branch_id: branchId, limit: String(PAGE_LIMIT) });
      if (cursor !== null) query.set('cursor', cursor);
      let token: string | null = null;
      try {
        token = await deps.readToken();
      } catch {
        token = null;
      }
      const answer = await transport.send({
        method: 'GET',
        path: `${AVAILABILITY_PATH}?${query.toString()}`,
        bearer: token ?? '',
      });
      if (answer === null) return { kind: 'unreachable' };
      if (answer.status === 401) return { kind: 'unauthorized' };
      if (answer.status !== 200) return { kind: 'failed' };
      const page = readAvailabilityPage(answer.json);
      return page === null ? { kind: 'failed' } : { kind: 'ok', page };
    },
  };
}
