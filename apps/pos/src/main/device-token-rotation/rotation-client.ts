/**
 * RT-373 — the `posRotateTerminalToken` client (POST /api/pos/v1/terminals/rotate,
 * `pos-terminal-pairing.openapi.yaml`, RT-369).
 *
 * Built on the shared Backend-Core transport (RT-880). The bearer is the token
 * the terminal still holds; no request body is read. Every call carries a NEW
 * `Idempotency-Key`: the route is non-replayable (a reused key is 409 and never
 * returns a token), so the caller mints one per attempt.
 *
 * The answer, mapped for the coordinator:
 *   200 with a token → `rotated` (the new token is SECRET: main process only,
 *       never logged); a 200 without a usable token is a lost response;
 *   401 → `unauthorized`: revoked, retired, an unknown token or past the
 *       grace; to the POS every 401 here means "re-pair" (RT-138 L6);
 *   429 → `rate_limited` for `Retry-After`;
 *   5xx, 425 or no answer → `retryable` with the held token and a new key;
 *   anything else (400, 409, ...) → `rejected`, not retried in a loop.
 *
 * Never throws; never logs.
 */
import {
  createBackendTransport,
  type BackendTransport,
  type FetchLike,
} from '../http/transport.js';

export const ROTATE_PATH = '/api/pos/v1/terminals/rotate';

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 16 * 1024;
/** When a 429 carries no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;

export type RotationResult =
  | { kind: 'rotated'; token: string; expiresAt: string | null }
  | { kind: 'unauthorized' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'retryable' }
  | { kind: 'rejected'; status: number };

export interface RotationClient {
  rotate(token: string, idempotencyKey: string): Promise<RotationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rotatedFrom(json: unknown): RotationResult {
  if (!isRecord(json)) return { kind: 'retryable' };
  const token = json['device_token'];
  if (typeof token !== 'string' || token.length === 0) return { kind: 'retryable' };
  const expires = json['expires_at'];
  const expiresAt =
    typeof expires === 'string' && !Number.isNaN(Date.parse(expires)) ? expires : null;
  return { kind: 'rotated', token, expiresAt };
}

function retryAfterMs(header: string | undefined): number {
  const seconds = Number(header);
  return header !== undefined && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_RETRY_AFTER_MS;
}

function resultOf(status: number, json: unknown, retryAfter: string | undefined): RotationResult {
  if (status === 200) return rotatedFrom(json);
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 429) return { kind: 'rate_limited', retryAfterMs: retryAfterMs(retryAfter) };
  if (status >= 500 || status === 425) return { kind: 'retryable' };
  return { kind: 'rejected', status };
}

export function createRotationClient(deps: { transport: BackendTransport }): RotationClient {
  return {
    async rotate(token, idempotencyKey) {
      const answer = await deps.transport.send({
        method: 'POST',
        path: ROTATE_PATH,
        bearer: token,
        headers: { 'Idempotency-Key': idempotencyKey },
        readHeaders: ['Retry-After'],
      });
      if (answer === null) return { kind: 'retryable' };
      return resultOf(answer.status, answer.json, answer.headers?.['retry-after']);
    },
  };
}

/** The production client on the shared `backendFetch`. */
export function createBackendRotationClient(baseUrl: string, fetch: FetchLike): RotationClient {
  return createRotationClient({
    transport: createBackendTransport({
      baseUrl,
      fetch,
      timeoutMs: TIMEOUT_MS,
      maxBodyBytes: MAX_BODY_BYTES,
    }),
  });
}
