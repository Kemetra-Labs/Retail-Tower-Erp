/**
 * RT-1490 — the Backend-Core `posCaptureItem` client
 * (`POST /api/pos/v1/catalog/unknown-items`, `catalog/unknown-items.yaml`).
 *
 * Built on the RT-880 shared transport. Auth is the `pos_operator` envelope
 * (the route is guarded by `PosOperatorAuthGuard`, not the device bearer); no
 * envelope → no request. Every send carries the row's key as
 * `Idempotency-Key`, so a resend replays the first answer server-side, and the
 * contract body only: `identifier_type = barcode` and the value. The principal
 * supplies tenant, store and device; `source_system` must be null for a
 * barcode; `sale_context` is held back in v1.
 *
 * Status table:
 *   200 / 201                       → accepted (resolved, or a pending row)
 *   401 / 403                       → unauthorized (the envelope is stale or
 *                                     its operator lost access; the row is
 *                                     fine and waits for a good envelope)
 *   404 / 408 / 425 / 429 / 5xx     → retry (404: a Backend-Core or edge
 *                                     without the route must not lose reports)
 *   any other status (400, 409 key conflict, 422, …) → refused for good
 *   no answer (network, timeout)    → unreachable
 *
 * Never throws; never logs or stores the envelope.
 */
import { createBackendTransport, statusOutcome, type FetchLike } from '../http/transport.js';

const CAPTURE_PATH = '/api/pos/v1/catalog/unknown-items';
const CAPTURE_REQUEST_TIMEOUT_MS = 10_000;
/** The answers are small; nothing in them is read. */
const CAPTURE_MAX_BODY_BYTES = 64 * 1024;

export type CaptureSendOutcome =
  | {
      readonly kind: 'accepted' | 'refused' | 'retry' | 'unauthorized';
      readonly status: number;
    }
  | { readonly kind: 'unreachable' };

export interface CaptureSendInput {
  readonly captureId: string;
  readonly barcode: string;
  /** The current operator envelope; empty → no request. */
  readonly envelope: string;
}

export interface UnknownItemCaptureClient {
  send(input: CaptureSendInput): Promise<CaptureSendOutcome>;
}

export interface UnknownItemCaptureClientDeps {
  readonly baseUrl: string;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

type Kind = 'accepted' | 'refused' | 'retry' | 'unauthorized';

const STATUS_TABLE: Readonly<Partial<Record<number, Kind>>> = {
  200: 'accepted',
  201: 'accepted',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'retry',
  408: 'retry',
  425: 'retry',
  429: 'retry',
};

function kindOf(status: number): Kind {
  if (status >= 500) return 'retry';
  return statusOutcome(status, STATUS_TABLE, 'refused');
}

export function createUnknownItemCaptureClient(
  deps: UnknownItemCaptureClientDeps,
): UnknownItemCaptureClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? CAPTURE_REQUEST_TIMEOUT_MS,
    maxBodyBytes: CAPTURE_MAX_BODY_BYTES,
  });

  return {
    async send(input) {
      const answer = await transport.send({
        method: 'POST',
        path: CAPTURE_PATH,
        bearer: input.envelope,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.captureId },
        body: JSON.stringify({ identifier_type: 'barcode', identifier_value: input.barcode }),
      });
      if (answer === null) return { kind: 'unreachable' };
      return { kind: kindOf(answer.status), status: answer.status };
    },
  };
}
