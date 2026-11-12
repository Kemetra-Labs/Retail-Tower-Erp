/**
 * RT-1339 (RT-286 S7) — the Backend-Core Offer Pack client
 * (`offers.openapi.yaml` `posGetOfferPack`):
 *
 *   read  GET /api/pos/v1/store/offer-pack   (device bearer, If-None-Match)
 *
 * Backend-Core only; never ERPNext / Frappe / the Connector. Built on the shared
 * transport. The device token is an explicit argument; the client never reads,
 * logs, stores or bridges it. The `ETag` and `X-Server-Time` headers are read
 * because the ETag is the Pack's identity (opaque to the till) and the server
 * time anchors trusted time (OD-8), on a 304 as well.
 *
 * Outcome mapping:
 *   200 with an ETag and a body → ok (the caller reads the body strictly)
 *   304 to a conditional read   → not_modified
 *   401                         → unauthorized
 *   any other answer            → unavailable (an older server answers 404: no Pack, no offer)
 *   network / timeout / no token → unreachable
 * Never throws.
 */
import { createBackendTransport, type FetchLike } from '../http/transport.js';

export const OFFER_PACK_PATH = '/api/pos/v1/store/offer-pack';
const OFFER_PACK_REQUEST_TIMEOUT_MS = 15_000;
/** 200 offers × 20 000 product ids is about 15 MB of JSON: the contract's ceiling. */
const OFFER_PACK_MAX_BODY_BYTES = 24 * 1024 * 1024;

export type OfferPackReadOutcome =
  | {
      readonly kind: 'ok';
      readonly body: unknown;
      readonly etag: string | null;
      readonly serverTime: string | null;
    }
  | { readonly kind: 'not_modified'; readonly serverTime: string | null }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unreachable' };

export interface OfferPackClient {
  read(deviceToken: string, ifNoneMatch: string | null): Promise<OfferPackReadOutcome>;
}

export interface OfferPackClientDeps {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
}

export function createOfferPackClient(deps: OfferPackClientDeps): OfferPackClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: OFFER_PACK_REQUEST_TIMEOUT_MS,
    maxBodyBytes: OFFER_PACK_MAX_BODY_BYTES,
  });

  return {
    async read(deviceToken, ifNoneMatch) {
      const answer = await transport.send({
        method: 'GET',
        path: OFFER_PACK_PATH,
        bearer: deviceToken,
        headers: {
          Accept: 'application/json',
          ...(ifNoneMatch === null ? {} : { 'If-None-Match': ifNoneMatch }),
        },
        readHeaders: ['etag', 'x-server-time'],
      });
      if (answer === null) return { kind: 'unreachable' };
      const etag = answer.headers?.['etag'] ?? null;
      const serverTime = answer.headers?.['x-server-time'] ?? null;
      if (answer.status === 200) {
        return answer.json === undefined
          ? { kind: 'unavailable' }
          : { kind: 'ok', body: answer.json, etag, serverTime };
      }
      // A 304 to an unconditional read is off-contract: never trust it as "unchanged".
      if (answer.status === 304) {
        return ifNoneMatch === null
          ? { kind: 'unavailable' }
          : { kind: 'not_modified', serverTime };
      }
      return answer.status === 401 ? { kind: 'unauthorized' } : { kind: 'unavailable' };
    },
  };
}
