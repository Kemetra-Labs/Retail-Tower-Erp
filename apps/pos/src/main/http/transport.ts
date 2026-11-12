/**
 * RT-880 — the single main-process HTTP transport to Backend-Core.
 *
 * Every new main-process Backend-Core client is built on this transport; the
 * older hand-rolled clients move onto it when they are next touched (see the
 * "Backend-Core HTTP clients" rule in `apps/pos/CLAUDE.md`).
 *
 * It owns the plumbing each client used to copy:
 *   • auth: `Authorization: Bearer <token>`; an empty token → no request;
 *     `null` (RT-1231) → no `Authorization` header, for a route whose device
 *     credential travels in the body (`device_token_attestation`), where an
 *     Authorization header would be verified as an operator JWT;
 *   • timeout: one `AbortSignal.timeout` per call;
 *   • the answer: the status plus the JSON body, read with a byte cap so an
 *     untrusted answer cannot exhaust memory (Content-Length or streamed);
 *   • error mapping: any network fault, timeout or body-read failure → `null`
 *     (the client reports it as "unreachable"); `statusOutcome` maps statuses
 *     through a client's own table. Never throws.
 *
 * Request-id is NOT minted here. `X-Request-Id` (OBS-1 contract §2) is added,
 * once per HTTP call, by `withRequestId` on the shared base fetch in `index.ts`
 * (`backendFetch`), together with the build identity and the terminal-status
 * observer. Build the transport on that fetch; minting here too would send two
 * ids for one call.
 *
 * Backend-Core only; never ERPNext / Frappe / the Connector. The transport
 * never logs, stores or bridges a token.
 */

import { parseJsonBody } from '../returns/returns-wire.js';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type BackendMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BackendTransportDeps {
  /** The Backend-Core origin; a trailing slash is dropped. */
  readonly baseUrl: string;
  /** The shared `backendFetch` (request-id, build identity, status observer). */
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  /** The largest answer body read, in bytes (UTF-8 on the wire). */
  readonly maxBodyBytes: number;
}

export interface BackendRequest {
  readonly method: BackendMethod;
  /** Appended to the base URL, query string included. */
  readonly path: string;
  /**
   * The bearer credential; empty → no request. `null` → no `Authorization`
   * header: only for a route that authenticates in the body (RT-1231).
   */
  readonly bearer: string | null;
  /** Extra headers (content type, idempotency key, selectors). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Response header names to hand back in `BackendAnswer.headers` (lower-case
   * keys). Only the names listed here are read; the default is none.
   */
  readonly readHeaders?: readonly string[];
}

export interface BackendAnswer {
  readonly status: number;
  /** The parsed body; undefined when empty, not JSON, or over the cap. */
  readonly json: unknown;
  /** The `readHeaders` the response carried, by lower-case name; absent ones are omitted. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BackendTransport {
  /** One HTTP exchange; null on no credential or any transport fault. */
  send(request: BackendRequest): Promise<BackendAnswer | null>;
}

/** A status through a client's own table, else the fallback. */
export function statusOutcome<F>(
  status: number,
  table: Readonly<Partial<Record<number, F>>>,
  fallback: F,
): F {
  return table[status] ?? fallback;
}

/**
 * The body as text, read incrementally and abandoned (the stream cancelled) as
 * soon as it passes the cap, whatever Content-Length says; null when too large.
 */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** The parsed body, or undefined when it is too large to read. */
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return undefined;
  const text = await boundedText(response, maxBytes);
  return text === null ? undefined : parseJsonBody(text);
}

/**
 * The caller headers plus the bearer, which always wins. With `bearer: null` no
 * `Authorization` header is sent at all, even one a caller passed.
 */
function headersOf(request: BackendRequest): Record<string, string> {
  if (request.bearer !== null) {
    return { ...request.headers, Authorization: `Bearer ${request.bearer}` };
  }
  return Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== 'authorization',
    ),
  );
}

/** The listed response headers that are present, by lower-case name. */
function pickHeaders(
  response: Response,
  names: readonly string[] | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names ?? []) {
    const value = response.headers.get(name);
    if (value !== null) out[name.toLowerCase()] = value;
  }
  return out;
}

export function createBackendTransport(deps: BackendTransportDeps): BackendTransport {
  const root = deps.baseUrl.replace(/\/$/, '');

  return {
    async send(request) {
      if (request.bearer?.length === 0) return null;
      try {
        const response = await deps.fetch(`${root}${request.path}`, {
          method: request.method,
          ...(request.body === undefined ? {} : { body: request.body }),
          headers: headersOf(request),
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
        return {
          status: response.status,
          json: await boundedJson(response, deps.maxBodyBytes),
          ...(request.readHeaders === undefined
            ? {}
            : { headers: pickHeaders(response, request.readHeaders) }),
        };
      } catch {
        return null;
      }
    },
  };
}
