/**
 * RT-388 — the Backend-Core shift variance policy client
 * (`cash-variance-policy.openapi.yaml`, `posGetCashVariancePolicy`):
 *
 *   read  GET /api/pos/v1/store/cash-variance-policy   (device bearer, If-None-Match)
 *
 * Backend-Core only. Built on the shared transport (RT-880), so the bearer,
 * the timeout, the byte cap and the request id are the transport's. The device
 * token is an explicit argument read by the caller in-process; the client never
 * reads, logs, stores or bridges it. No token, no request.
 *
 * Outcome mapping:
 *   200 readable                      → ok (policy + the ETag header, or null)
 *   200 off-contract / not JSON       → unreadable
 *   304 to a conditional read         → not_modified
 *   304 to an unconditional read      → unreadable (off-contract, never "unchanged")
 *   401                               → unauthorized
 *   any other status                  → server_error
 *   network / timeout / no token      → unreachable
 * Never throws.
 */
import { createBackendTransport, type FetchLike } from '../http/transport.js';
import { readPolicyBody, type WirePolicy } from './policy-wire.js';

export const POLICY_PATH = '/api/pos/v1/store/cash-variance-policy';
export const POLICY_REQUEST_TIMEOUT_MS = 10_000;
/** A policy answer is a few hundred bytes. */
export const POLICY_MAX_BODY_BYTES = 16 * 1024;

export type PolicyReadOutcome =
  | { readonly kind: 'ok'; readonly policy: WirePolicy; readonly etag: string | null }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'server_error' }
  | { readonly kind: 'unreachable' };

export interface PolicyClient {
  read(deviceToken: string, ifNoneMatch: string | null): Promise<PolicyReadOutcome>;
}

export interface PolicyClientDeps {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
}

export function createPolicyClient(deps: PolicyClientDeps): PolicyClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: POLICY_REQUEST_TIMEOUT_MS,
    maxBodyBytes: POLICY_MAX_BODY_BYTES,
  });

  return {
    async read(deviceToken, ifNoneMatch) {
      const answer = await transport.send({
        method: 'GET',
        path: POLICY_PATH,
        bearer: deviceToken,
        headers: {
          Accept: 'application/json',
          ...(ifNoneMatch === null ? {} : { 'If-None-Match': ifNoneMatch }),
        },
        readHeaders: ['etag'],
      });
      if (answer === null) return { kind: 'unreachable' };
      if (answer.status === 200) {
        const policy = readPolicyBody(answer.json);
        if (policy === null) return { kind: 'unreadable' };
        return { kind: 'ok', policy, etag: answer.headers?.['etag'] ?? null };
      }
      if (answer.status === 304) {
        return ifNoneMatch === null ? { kind: 'unreadable' } : { kind: 'not_modified' };
      }
      if (answer.status === 401) return { kind: 'unauthorized' };
      return { kind: 'server_error' };
    },
  };
}
