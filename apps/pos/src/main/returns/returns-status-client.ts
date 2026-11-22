/**
 * RT-1498 close slice — the Backend-Core return status read (`readReturnStatusByProvenance`, RT-1548,
 * `pos-sales/sales.yaml` 1.28.0-draft):
 *
 *   readStatus  GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status?sourceSystem=…&externalId=…
 *
 * Backend-Core only; never ERPNext / Frappe / the Connector. Auth is the `operatorAuthorization` scheme
 * (the same as `readSale`): `Authorization: Bearer <pos_operator envelope>`, the admitted authorization
 * snapshot's own envelope as an explicit argument (RT-197 A5). The client never reads a session or a
 * token, and never logs, stores or bridges one. No envelope, no request. Built on the shared transport
 * (RT-880): bearer, timeout, byte-capped body, faults to `null`.
 *
 * A VERDICT is only a 200 that reads as `recorded` or `not_recorded` (BR-2). Nothing else is one:
 *
 *   200 recorded / not_recorded  → that verdict
 *   404                          → `unavailable`: the returns gate or the status read's own rollout gate
 *                                  is off, or the sale is out of the caller's scope. One non-disclosing
 *                                  body. NEVER `not_recorded`: a close stays unavailable.
 *   401 / 403                    → no verdict (`unauthorized`)
 *   429 / 5xx / any other status → no verdict (`server`)
 *   200 off-contract body        → no verdict (`unreadable`)
 *   network / timeout            → no verdict (`offline`)
 *
 * Never throws.
 */
import { createBackendTransport, statusOutcome, type FetchLike } from '../http/transport.js';
import { isUuid, readReturnStatusBody, type WireSaleReturn } from './returns-wire.js';

const SALES_PATH = '/api/pos/v1/sales';

/** The request timeout of the status read: the returns client's (15 s). */
const RETURNS_STATUS_REQUEST_TIMEOUT_MS = 15_000;

/** The largest answer body read: a `SaleReturn` with its lines, with plenty of margin. */
const MAX_STATUS_BODY_BYTES = 512 * 1024;

/** Why a read gave no verdict (a closed set: never a body, a status text or an envelope). */
type StatusReadCause = 'offline' | 'unauthorized' | 'server' | 'unreadable';

export type StatusReadOutcome =
  | {
      readonly kind: 'recorded';
      readonly creditLinked: boolean;
      readonly saleReturn: WireSaleReturn;
    }
  | { readonly kind: 'not_recorded' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'no_verdict'; readonly cause: StatusReadCause };

interface StatusReadRequest {
  readonly saleRef: string;
  /** The return's provenance, as journaled before it was sent. */
  readonly sourceSystem: string;
  readonly externalId: string;
}

/** The opaque operator envelope the call authenticates with, or null (→ no request). */
type OperatorEnvelope = string | null;

export interface ReturnsStatusClient {
  readStatus(request: StatusReadRequest, envelope: OperatorEnvelope): Promise<StatusReadOutcome>;
}

export interface CreateReturnsStatusClientDeps {
  /** Backend-Core base URL. */
  readonly baseUrl: string;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

const NO_VERDICT_BY_STATUS: Readonly<Record<number, StatusReadOutcome>> = {
  401: { kind: 'no_verdict', cause: 'unauthorized' },
  403: { kind: 'no_verdict', cause: 'unauthorized' },
  404: { kind: 'unavailable' },
};

const SERVER: StatusReadOutcome = { kind: 'no_verdict', cause: 'server' };

function toOutcome(status: number, json: unknown): StatusReadOutcome {
  if (status !== 200) return statusOutcome(status, NO_VERDICT_BY_STATUS, SERVER);
  const body = readReturnStatusBody(json);
  if (body === null) return { kind: 'no_verdict', cause: 'unreadable' };
  if (body.status === 'not_recorded') return { kind: 'not_recorded' };
  return { kind: 'recorded', creditLinked: body.creditLinked, saleReturn: body.saleReturn };
}

export function createReturnsStatusClient(
  deps: CreateReturnsStatusClientDeps,
): ReturnsStatusClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? RETURNS_STATUS_REQUEST_TIMEOUT_MS,
    maxBodyBytes: MAX_STATUS_BODY_BYTES,
  });

  return {
    async readStatus(request, envelope) {
      if (!isUuid(request.saleRef)) return { kind: 'unavailable' };
      if (envelope === null || envelope.length === 0) {
        return { kind: 'no_verdict', cause: 'unauthorized' };
      }
      const query = new URLSearchParams({
        sourceSystem: request.sourceSystem,
        externalId: request.externalId,
      });
      const answer = await transport.send({
        method: 'GET',
        path: `${SALES_PATH}/${request.saleRef}/returns/by-provenance/status?${query.toString()}`,
        bearer: envelope,
      });
      if (answer === null) return { kind: 'no_verdict', cause: 'offline' };
      return toOutcome(answer.status, answer.json);
    },
  };
}
