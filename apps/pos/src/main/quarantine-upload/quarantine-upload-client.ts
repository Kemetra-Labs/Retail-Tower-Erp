/**
 * RT-1312 Phase 3(c) — the Backend-Core `posQuarantineSale` client
 * (`POST /api/pos/v1/quarantined-sales`, `pos-sales/sale-quarantine.yaml`
 * 1.0.0-draft, Backend-Core runtime RT-1312 Phase 3(b)).
 *
 * Built on the RT-880 shared transport. Auth is the paired terminal's DEVICE
 * bearer (`PosDeviceAuthGuard`); no token → no request. There is no
 * `Idempotency-Key`: the upload is naturally idempotent on the sale's
 * provenance `(tenant, sourceSystem, externalId)`, so a re-send is always safe.
 *
 * Status table (the contract's "What the till does with the answer"):
 *   200 / 201                          → uploaded: Backend-Core holds the sale
 *   400 / 409 / 413                    → refused: terminal for this upload
 *   401 / 404 / 408 / 425 / 429 / 5xx  → retry (404: an older Backend-Core
 *                                        without the route; 429: the answer's
 *                                        `Retry-After`)
 *   no answer (network, timeout)       → unreachable
 * Only 400 / 409 / 413 are final. A status the contract does not name (a WAF or
 * proxy 403, a 405 from a half-deployed Backend-Core, a 422) is retried, so a
 * paid sale is never given up on a surprise: a refusal is never retried.
 *
 * Never throws; never logs or stores the token. The request body holds the
 * sale (money, receipt operator name): nothing here logs it.
 */
import { createBackendTransport, statusOutcome, type FetchLike } from '../http/transport.js';
import { parseRetryAfterMs } from '../sales-sync/retry-after.js';

const QUARANTINE_PATH = '/api/pos/v1/quarantined-sales';
/** The upload carries a capture body up to ~250 kB; the answer is a small receipt. */
const QUARANTINE_REQUEST_TIMEOUT_MS = 20_000;
const QUARANTINE_MAX_BODY_BYTES = 64 * 1024;

/** `QuarantineReason` (`kind` / `httpStatus` / `errorCode`). */
export interface QuarantineUploadReason {
  readonly kind:
    | 'refused'
    | 'payload_divergence'
    | 'cashier_claim_refused'
    | 'held_previous_pairing';
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
}

/** `QuarantineSaleUpload`: closed; the till sends exactly these keys. */
export interface QuarantineUploadBody {
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly idempotencyKey: string;
  readonly reason: QuarantineUploadReason;
  readonly tillRecordedAt: string;
  /** The earlier pairing's device id; required for a held sale, else null. */
  readonly previousTerminalId: string | null;
  /** The capture request body as the till builds it for `captureSale` (the wire body). */
  readonly saleBody: Readonly<Record<string, unknown>>;
}

export interface QuarantineReceipt {
  readonly quarantineRef: string;
  readonly state: string;
}

export type QuarantineUploadOutcome =
  | {
      readonly kind: 'uploaded';
      readonly status: number;
      readonly receipt: QuarantineReceipt | null;
    }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'retry'; readonly status: number; readonly retryAfterMs?: number }
  | { readonly kind: 'unreachable' };

export interface QuarantineUploadClient {
  upload(deviceToken: string, body: QuarantineUploadBody): Promise<QuarantineUploadOutcome>;
}

interface QuarantineUploadClientDeps {
  readonly baseUrl: string;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly fetch: FetchLike;
  /** The local clock, for an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
}

type Kind = 'uploaded' | 'refused' | 'retry';

const STATUS_TABLE: Readonly<Partial<Record<number, Kind>>> = {
  200: 'uploaded',
  201: 'uploaded',
  400: 'refused',
  409: 'refused',
  413: 'refused',
  401: 'retry',
  404: 'retry',
  408: 'retry',
  425: 'retry',
  429: 'retry',
};

function kindOf(status: number): Kind {
  return statusOutcome<Kind>(status, STATUS_TABLE, 'retry');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The receipt of a 200 / 201, or null when the answer is not a readable `QuarantineReceipt`. */
function receiptOf(json: unknown): QuarantineReceipt | null {
  if (!isRecord(json)) return null;
  const { quarantineRef, state } = json;
  return typeof quarantineRef === 'string' && typeof state === 'string'
    ? { quarantineRef, state }
    : null;
}

export function createQuarantineUploadClient(
  deps: QuarantineUploadClientDeps,
): QuarantineUploadClient {
  const nowMs = deps.nowMs ?? Date.now;
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? QUARANTINE_REQUEST_TIMEOUT_MS,
    maxBodyBytes: QUARANTINE_MAX_BODY_BYTES,
  });

  return {
    async upload(deviceToken, body) {
      const answer = await transport.send({
        method: 'POST',
        path: QUARANTINE_PATH,
        bearer: deviceToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        readHeaders: ['retry-after'],
      });
      if (answer === null) return { kind: 'unreachable' };
      const { status } = answer;
      const kind = kindOf(status);
      if (kind === 'uploaded') {
        return { kind, status, receipt: receiptOf(answer.json) };
      }
      if (kind === 'refused') return { kind, status };
      const retryAfterMs =
        status === 429
          ? parseRetryAfterMs(answer.headers?.['retry-after'] ?? null, nowMs())
          : undefined;
      return retryAfterMs === undefined ? { kind, status } : { kind, status, retryAfterMs };
    },
  };
}
