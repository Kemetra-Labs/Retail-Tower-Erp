/**
 * RT-1231 — the audit-events client on the shared transport.
 *
 * Device auth in the body (`device_token_attestation`), no `Authorization`
 * header; the wire item has exactly the contract keys; any answer but a
 * readable 200 is `'network_error'` (undelivered, caller backs off); no token
 * → no request.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AUDIT_EVENTS_PATH,
  createAuditSyncClient,
  readSyncResponse,
  type AuditSyncClientDeps,
} from '../audit-sync-client.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';

const EVENT: AuditEvent = {
  event_id: '00000000-0000-4000-8000-000000000001',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  branch_id: '33333333-3333-4333-8333-333333333333',
  originating_terminal_id: '44444444-4444-4444-8444-444444444444',
  acting_operator_id: 'user_clerk1',
  session_id: null,
  shift_id: null,
  action_category: 'manager_approval.granted',
  created_at: '2026-11-06T10:00:00.000Z',
  approving_supervisor_id: 'user_mgr',
  payload: { approval_id: 'a' },
};

function respond(status: number, body: unknown) {
  return vi.fn<AuditSyncClientDeps['fetch']>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

function clientOf(fetch: AuditSyncClientDeps['fetch'], extra: Partial<AuditSyncClientDeps> = {}) {
  return createAuditSyncClient({
    baseUrl: 'https://bc.test/',
    fetch,
    readDeviceToken: () => Promise.resolve('device-token'),
    ...extra,
  });
}

describe('RT-1231 createAuditSyncClient', () => {
  it('POSTs the batch with the device attestation in the body and no Authorization header', async () => {
    const fetch = respond(200, { accepted: [EVENT.event_id], duplicates: [], rejected: [] });
    const result = await clientOf(fetch).sendBatch([EVENT]);

    expect(result).toEqual({ accepted: [EVENT.event_id], duplicates: [], rejected: [] });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://bc.test${AUDIT_EVENTS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      device_token_attestation: 'device-token',
      events: [EVENT],
    });
  });

  it('sends exactly the contract keys of each event', async () => {
    const fetch = respond(200, { accepted: [], duplicates: [], rejected: [] });
    const extra = { ...EVENT, local_only_field: 'x' } as unknown as AuditEvent;
    await clientOf(fetch).sendBatch([extra]);
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string) as {
      events: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body.events[0] ?? {}).sort()).toEqual(Object.keys(EVENT).sort());
  });

  it.each([
    ['no token (unpaired or revoked)', () => Promise.resolve(null)],
    ['an empty token', () => Promise.resolve('')],
    ['a token read that throws', () => Promise.reject(new Error('safeStorage'))],
  ])('makes no request with %s', async (_label, readDeviceToken) => {
    const fetch = respond(200, {});
    const onUndelivered = vi.fn();
    expect(await clientOf(fetch, { readDeviceToken, onUndelivered }).sendBatch([EVENT])).toBe(
      'network_error',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onUndelivered).toHaveBeenCalledWith({ reason: 'no_credential' });
  });

  it('reports a 400 (the request itself refused) as batch_refused', async () => {
    const onUndelivered = vi.fn();
    const fetch = respond(400, { error: { code: 'validation_error', message: 'y' } });
    expect(await clientOf(fetch, { onUndelivered }).sendBatch([EVENT])).toBe('batch_refused');
    expect(onUndelivered).toHaveBeenCalledWith({ reason: 'status', status: 400 });
  });

  it.each([401, 403, 429, 500, 503])('reports status %i as undelivered', async (status) => {
    const onUndelivered = vi.fn();
    const fetch = respond(status, { error: { code: 'x', message: 'y' } });
    expect(await clientOf(fetch, { onUndelivered }).sendBatch([EVENT])).toBe('network_error');
    expect(onUndelivered).toHaveBeenCalledWith({ reason: 'status', status });
  });

  it('reports a transport fault as undelivered', async () => {
    const onUndelivered = vi.fn();
    const fetch = vi.fn<AuditSyncClientDeps['fetch']>(() => Promise.reject(new Error('offline')));
    expect(await clientOf(fetch, { onUndelivered }).sendBatch([EVENT])).toBe('network_error');
    expect(onUndelivered).toHaveBeenCalledWith({ reason: 'unreachable' });
  });

  it('reports an off-contract 200 body as undelivered', async () => {
    const onUndelivered = vi.fn();
    const fetch = respond(200, { accepted: 'nope' });
    expect(await clientOf(fetch, { onUndelivered }).sendBatch([EVENT])).toBe('network_error');
    expect(onUndelivered).toHaveBeenCalledWith({ reason: 'unreadable', status: 200 });
  });
});

describe('RT-1231 readSyncResponse', () => {
  it('reads the contract shape and treats a missing rejected as empty', () => {
    expect(readSyncResponse({ accepted: ['a'], duplicates: [] })).toEqual({
      accepted: ['a'],
      duplicates: [],
      rejected: [],
    });
  });

  it('keeps known rejection categories and maps an unknown one to a retryable category', () => {
    expect(
      readSyncResponse({
        accepted: [],
        duplicates: [],
        rejected: [
          { event_id: 'a', category: 'schema_violation' },
          { event_id: 'b', category: 'something_new' },
        ],
      })?.rejected,
    ).toEqual([
      { event_id: 'a', category: 'schema_violation' },
      { event_id: 'b', category: 'invalid_input' },
    ]);
  });

  it.each([
    null,
    'x',
    [],
    { accepted: [], duplicates: 'x' },
    { accepted: [], duplicates: [], rejected: [1] },
  ])('refuses %j', (body) => {
    expect(readSyncResponse(body)).toBeNull();
  });
});
