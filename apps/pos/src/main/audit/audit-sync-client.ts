/**
 * RT-1231 — the `AuditSyncClient` for `POST /api/pos/v1/audit-events`
 * (`pos-audit-events` 1.3.0-draft), on the shared RT-880 transport.
 *
 * Device auth is in the BODY: `device_token_attestation` = the paired device
 * token (the Wave 1 pattern, as sign-in and takeover-confirm). The route's
 * `Authorization` header is an OPTIONAL operator JWT that Backend-Core verifies
 * when present, so this client sends none (`bearer: null`): events queued
 * offline, after sign-out or under an expired session still upload.
 *
 * The device token comes from the sendable reader: null unless paired, null
 * once revoked (RT-215). No token → no request. The token is never logged.
 *
 * Every answer other than a readable 200 is `'network_error'`: the batch was
 * not delivered and the caller backs off. Only the status is logged (P7).
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import { createBackendTransport, type FetchLike } from '../http/transport.js';
import { toWireEvent } from './audit-event-wire.js';
import type {
  AuditRejectedEvent,
  AuditRejectionCategory,
  AuditSyncBatchResponse,
  AuditSyncClient,
} from './audit-sync.js';

export const AUDIT_EVENTS_PATH = '/api/pos/v1/audit-events';
const AUDIT_SYNC_REQUEST_TIMEOUT_MS = 15_000;
/** 100 event ids in three arrays: far under this cap. */
const AUDIT_SYNC_MAX_BODY_BYTES = 256 * 1024;

const REJECTION_CATEGORIES: ReadonlySet<string> = new Set<AuditRejectionCategory>([
  'invalid_input',
  'tenant_mismatch',
  'schema_violation',
]);

export interface AuditSyncClientDeps {
  readonly baseUrl: string;
  /** The shared `backendFetch` (request id, build identity, status observer). */
  readonly fetch: FetchLike;
  /** The sendable device-token read: null unless paired, null once revoked. */
  readonly readDeviceToken: () => Promise<string | null>;
  /** A batch that was not delivered: closed reason and status only. */
  readonly onUndelivered?: (info: {
    reason: 'no_credential' | 'unreachable' | 'status' | 'unreadable';
    status?: number;
  }) => void;
  readonly timeoutMs?: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readRejected(value: unknown): AuditRejectedEvent[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: AuditRejectedEvent[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { event_id: id, category } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof category !== 'string') return null;
    // An unknown category is not one the contract calls final: retried (bounded).
    const known = REJECTION_CATEGORIES.has(category);
    out.push({
      event_id: id,
      category: (known ? category : 'invalid_input') as AuditRejectionCategory,
    });
  }
  return out;
}

/** The 200 body, or null when it is not the contract's shape. */
export function readSyncResponse(json: unknown): AuditSyncBatchResponse | null {
  if (typeof json !== 'object' || json === null) return null;
  const body = json as Record<string, unknown>;
  const rejected = readRejected(body['rejected']);
  if (!isStringArray(body['accepted']) || !isStringArray(body['duplicates']) || rejected === null) {
    return null;
  }
  return { accepted: body['accepted'], duplicates: body['duplicates'], rejected };
}

export function createAuditSyncClient(deps: AuditSyncClientDeps): AuditSyncClient {
  const transport = createBackendTransport({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    timeoutMs: deps.timeoutMs ?? AUDIT_SYNC_REQUEST_TIMEOUT_MS,
    maxBodyBytes: AUDIT_SYNC_MAX_BODY_BYTES,
  });
  const undelivered = deps.onUndelivered ?? ((): void => undefined);

  return {
    async sendBatch(events) {
      let token: string | null;
      try {
        token = await deps.readDeviceToken();
      } catch {
        token = null;
      }
      if (token === null || token.length === 0) {
        undelivered({ reason: 'no_credential' });
        return 'network_error';
      }
      const answer = await transport.send({
        method: 'POST',
        path: AUDIT_EVENTS_PATH,
        bearer: null,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          device_token_attestation: token,
          events: events.map((event: AuditEvent) => toWireEvent(event)),
        }),
      });
      if (answer === null) {
        undelivered({ reason: 'unreachable' });
        return 'network_error';
      }
      if (answer.status !== 200) {
        undelivered({ reason: 'status', status: answer.status });
        return 'network_error';
      }
      const body = readSyncResponse(answer.json);
      if (body === null) {
        undelivered({ reason: 'unreadable', status: 200 });
        return 'network_error';
      }
      return body;
    },
  };
}
