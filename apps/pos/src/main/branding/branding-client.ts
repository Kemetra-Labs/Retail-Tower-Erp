/**
 * RT-475 — the Backend-Core tenant branding client (RT-473
 * `tenant-branding.openapi.yaml`):
 *
 *   read  GET /api/pos/v1/tenant/branding   (device bearer, If-None-Match)
 *
 * Backend-Core only; never ERPNext / Frappe / the Connector. The device token
 * is an explicit argument read by the caller in-process; the client never
 * reads, logs, stores or bridges it. No token → no request.
 *
 * Outcome mapping:
 *   200 readable       → ok
 *   200 off-contract, not JSON or over the body cap → unreadable
 *   304                → not_modified (only when a conditional ETag was sent)
 *   401                → unauthorized
 *   any other status   → server_error (the server answered)
 *   network / timeout / no token → unreachable
 * Never throws.
 *
 * The answer's ETag header is not read: the transport returns status and body
 * only, and the ETag is a pure function of the body (FR-18), which the cache
 * recomputes.
 */

import { createBackendTransport, type FetchLike } from '../http/transport.js';
import { readBrandingBody, type WireBranding } from './branding-wire.js';

export const BRANDING_PATH = '/api/pos/v1/tenant/branding';
export const BRANDING_REQUEST_TIMEOUT_MS = 15_000;
/** 8 base64 screen renditions plus the receipt: far under this cap. */
export const BRANDING_MAX_BODY_BYTES = 4 * 1024 * 1024;

export type BrandingReadOutcome =
  | { readonly kind: 'ok'; readonly branding: WireBranding }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'server_error' }
  | { readonly kind: 'unreachable' };

export interface BrandingClient {
  read(deviceToken: string, ifNoneMatch: string | null): Promise<BrandingReadOutcome>;
}

export interface BrandingClientDeps {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
}

export function createBrandingClient(deps: BrandingClientDeps): BrandingClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: BRANDING_REQUEST_TIMEOUT_MS,
    maxBodyBytes: BRANDING_MAX_BODY_BYTES,
  });

  return {
    async read(deviceToken, ifNoneMatch) {
      const answer = await transport.send({
        method: 'GET',
        path: BRANDING_PATH,
        bearer: deviceToken,
        headers: {
          Accept: 'application/json',
          ...(ifNoneMatch === null ? {} : { 'If-None-Match': ifNoneMatch }),
        },
      });
      if (answer === null) return { kind: 'unreachable' };
      if (answer.status === 200) {
        const branding = readBrandingBody(answer.json);
        return branding === null ? { kind: 'unreadable' } : { kind: 'ok', branding };
      }
      // A 304 to an unconditional read is off-contract: never trust it as "unchanged".
      if (answer.status === 304) {
        return ifNoneMatch === null ? { kind: 'unreadable' } : { kind: 'not_modified' };
      }
      if (answer.status === 401) return { kind: 'unauthorized' };
      return { kind: 'server_error' };
    },
  };
}
