/**
 * RT-1312 Phase 1 (P1-D1) — the Backend-Core device heartbeat client
 * (`pos-device-health.openapi.yaml` 1.1.0-draft):
 *
 *   report  POST /api/pos/v1/terminals/heartbeat   (device bearer)
 *
 * Built on the shared transport (RT-880) over the shared `backendFetch`.
 * Backend-Core only; never ERPNext / Frappe / the Connector. The device token is
 * an explicit argument read by the caller in-process; the client never reads,
 * logs, stores or bridges it. No token → no request.
 *
 * Outcome mapping:
 *   200 HeartbeatAck   → acked (with `pos_contract_revision`)
 *   200 off-contract   → unreadable
 *   400                → rejected (the body was refused; nothing stored)
 *   401                → unauthorized
 *   any other status   → server_error (the server answered)
 *   network / timeout / no token → unreachable
 * Never throws.
 */
import { createBackendTransport, statusOutcome, type FetchLike } from '../http/transport.js';
import { parseHeartbeatAck, type DeviceHeartbeatReport } from './heartbeat-wire.js';

export const DEVICE_HEARTBEAT_PATH = '/api/pos/v1/terminals/heartbeat';
const HEARTBEAT_REQUEST_TIMEOUT_MS = 10_000;
/** A `HeartbeatAck` is a few hundred bytes. */
const HEARTBEAT_MAX_BODY_BYTES = 16 * 1024;

export type HeartbeatOutcome =
  | { readonly kind: 'acked'; readonly status: 200; readonly posContractRevision: number }
  | { readonly kind: 'unreadable'; readonly status: 200 }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unauthorized'; readonly status: number }
  | { readonly kind: 'server_error'; readonly status: number }
  | { readonly kind: 'unreachable' };

type RefusedKind = 'rejected' | 'unauthorized' | 'server_error';
const REFUSED: Readonly<Partial<Record<number, RefusedKind>>> = {
  400: 'rejected',
  401: 'unauthorized',
};

export interface HeartbeatClient {
  report(deviceToken: string, body: DeviceHeartbeatReport): Promise<HeartbeatOutcome>;
}

export interface HeartbeatClientDeps {
  readonly baseUrl: string;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly fetch: FetchLike;
}

export function createHeartbeatClient(deps: HeartbeatClientDeps): HeartbeatClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS,
    maxBodyBytes: HEARTBEAT_MAX_BODY_BYTES,
  });

  return {
    async report(deviceToken, body) {
      const answer = await transport.send({
        method: 'POST',
        path: DEVICE_HEARTBEAT_PATH,
        bearer: deviceToken,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (answer === null) return { kind: 'unreachable' };
      if (answer.status !== 200) {
        return {
          kind: statusOutcome(answer.status, REFUSED, 'server_error'),
          status: answer.status,
        };
      }
      const ack = parseHeartbeatAck(answer.json);
      if (ack === null) return { kind: 'unreadable', status: 200 };
      return { kind: 'acked', status: 200, posContractRevision: ack.posContractRevision };
    },
  };
}
