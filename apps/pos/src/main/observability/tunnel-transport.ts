/**
 * RT-1253 scope 3 / R1 — the request executor that sends a Sentry envelope to
 * the Backend-Core tunnel (`posForwardTelemetryEnvelope`, device bearer).
 *
 * It replaces the SDK's net executor, which fixes its headers once when it is
 * built (so a rotated device token would never be picked up) and gzips bodies
 * over 32 KiB (the tunnel answers 415 to any content encoding). It sits behind
 * the SDK's offline transport, which has two outcomes this executor relies on
 * (RT-1253 step 0, Q2):
 *
 *   resolves with a status      the offline layer is done with the envelope: 2xx
 *                               is sent, a status >= 400 without Retry-After is
 *                               DROPPED, a 429 with Retry-After delays the flush
 *   throws                      the offline layer QUEUES the envelope for a retry
 *
 * So "cannot send right now" (not wired yet, a network fault, a failed token
 * read, a 502/503/504 from the proxy, RT-1266) THROWS, and "must never be sent" (no sendable token, captured under
 * another terminal, kill switch) RESOLVES without a request.
 *
 * Nothing here reads or logs an envelope's content, the token or the URL.
 *
 * Deliberate exception to the shared-transport rule (RT-880, `apps/pos/CLAUDE.md`): this
 * does not use `createBackendTransport`. That transport maps every network fault to `null`
 * and drops the response headers, but the offline layer needs a THROW to queue an envelope
 * and the `Retry-After` of a 429 to back off. The request is still built on the shared base
 * fetch (request id, build identity), handed in as `deps.fetch`. The config read, which has
 * no such need, does use the shared transport (`telemetry-config.ts`).
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The contract path of `posForwardTelemetryEnvelope`, relative to the Backend-Core base URL. */
export const TELEMETRY_TUNNEL_PATH = '/api/pos/v1/telemetry/envelope';

/** The tag R1 records on each event, after the allowlist scrub, before the disk queue. */
export const CAPTURE_TERMINAL_TAG = 'capture_terminal_id';

export interface TunnelRequest {
  readonly body: string | Uint8Array;
}

export interface TunnelResponse {
  readonly statusCode: number;
  readonly headers: {
    readonly 'retry-after': string | null;
    readonly 'x-sentry-rate-limits': string | null;
  };
}

export interface TunnelExecutorDeps {
  /** False until the pairing store and token reader are wired (boot). */
  readonly isBound: () => boolean;
  /** The cached config says enabled. False is the kill switch, or never fetched. */
  readonly isEnabled: () => boolean;
  /** The absolute tunnel URL: the Backend-Core base URL plus the contract path. */
  readonly tunnelUrl: string;
  /** `readSendableDeviceToken`: read on EVERY send; null unless the pairing is `paired`. */
  readonly readToken: () => Promise<string | null>;
  /** The terminal id the device is paired as right now, or null. */
  readonly currentTerminalId: () => string | null;
  /** An UNOBSERVED fetch: a telemetry 401 never counts toward a device revocation. */
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
}

const DROPPED: TunnelResponse = {
  statusCode: 204,
  headers: { 'retry-after': null, 'x-sentry-rate-limits': null },
};

/** Bad gateway, service unavailable, gateway timeout: "Backend-Core cannot answer right now". */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function textOf(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLine(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined || line === '') return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The `capture_terminal_id` tag of the first event item of an envelope, or null.
 * The POS only ever produces envelopes of one error event; anything else reads
 * as "no capture terminal" and is dropped.
 */
export function captureTerminalIdOf(body: string | Uint8Array): string | null {
  const lines = textOf(body).split('\n');
  for (let i = 1; i < lines.length - 1; i += 2) {
    if (parseLine(lines[i])?.['type'] !== 'event') continue;
    const tags = parseLine(lines[i + 1])?.['tags'];
    const id = isRecord(tags) ? tags[CAPTURE_TERMINAL_TAG] : undefined;
    return typeof id === 'string' && id !== '' ? id : null;
  }
  return null;
}

async function readTokenOrThrow(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return await read();
  } catch {
    // Never carry the underlying error: a token read could include secret text.
    throw new Error('telemetry:token-read-failed');
  }
}

/**
 * RT-1266 (RT-1254 F1): a proxy answers 502/503/504 while Backend-Core is down. A resolved status
 * >= 400 is final for the offline layer, so unavailability must THROW to be queued. 500 is
 * deliberately NOT here: it is a server bug, retrying it would only fill the queue.
 */
function toTunnelResponse(response: Response): TunnelResponse {
  if (UNAVAILABLE_STATUSES.has(response.status)) throw new Error('telemetry:tunnel-unavailable');
  return {
    statusCode: response.status,
    headers: {
      'retry-after': response.headers.get('retry-after'),
      'x-sentry-rate-limits': null,
    },
  };
}

export function createTunnelRequestExecutor(
  deps: TunnelExecutorDeps,
): (request: TunnelRequest) => Promise<TunnelResponse> {
  return async (request) => {
    if (!deps.isBound()) throw new Error('telemetry:not-ready');
    if (!deps.isEnabled()) return DROPPED;

    const token = await readTokenOrThrow(deps.readToken);
    if (token === null || token === '') return DROPPED;

    // R1: an envelope is only ever sent as the terminal it was captured under.
    const captured = captureTerminalIdOf(request.body);
    if (captured === null || captured !== deps.currentTerminalId()) return DROPPED;

    const response = await deps.fetch(deps.tunnelUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-sentry-envelope',
      },
      body: textOf(request.body), // an envelope is UTF-8 text
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    return toTunnelResponse(response);
  };
}
