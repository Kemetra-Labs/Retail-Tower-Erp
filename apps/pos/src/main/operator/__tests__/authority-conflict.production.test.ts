import { describe, expect, it, vi } from 'vitest';

import { AuthorityConflictResolver } from '../authority-conflict-resolver.js';
import { createCashierAdmissionClient } from '../cashier-admission-client.js';
import type { CashierAdmissionDeps } from '../cashier-admission.js';
import { SessionManager } from '../session-manager.js';
import { OPERATOR, T0_MS, USER } from './__helpers__/offline-grant-fixture.js';
import {
  installWiringHarness,
  refusal,
  wiring,
} from './__helpers__/offline-grant-wiring-harness.js';

/**
 * RT-309 D9 review round (coordinator, Codex findings 2 and 3) — the takeover
 * through the PRODUCTION response parser and the PRODUCTION offline grant seam:
 * an `admitted` is validated and adopted BEFORE its grant is published, so a
 * refused admission leaves no fresh grant, and a zero-grace answer (whose
 * publication invalidates the grant) is not misread as an invalidation in flight.
 */

installWiringHarness();

const ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';
const GENERATION = '1759572000.123456';
const TOKEN = ['dev', 'ice-token-for-conflict-test'].join('');
const SERVER_TIME = new Date(T0_MS).toISOString();

function admittedBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'admitted',
    admission_id: ADMISSION_ID,
    offline_grace_seconds: 86_400,
    admission_ttl_seconds: 43_200,
    server_time: SERVER_TIME,
    display_name: 'Nour',
    admission_generation: GENERATION,
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(body: Record<string, unknown>, tillMs = T0_MS) {
  const ends: string[] = [];
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith('/end') ? (ends.push(url), json(200, { kind: 'ended' })) : json(200, body),
    ),
  );
  const admission: CashierAdmissionDeps = {
    client: createCashierAdmissionClient({
      baseUrl: 'https://api.example.test/',
      fetch: fetchMock as unknown as typeof fetch,
      getDeviceToken: () => Promise.resolve(TOKEN),
    }),
    grantSeam: wiring.seam,
    now: () => new Date(T0_MS), // the grant's local receipt time, on the harness clock
  };
  const sessions = new SessionManager();
  const record = sessions.create({
    operator_id: OPERATOR,
    display_name: 'Nour',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    offline_admission: {
      user_id: USER,
      valid_until_ms: Date.now() + 3_600_000,
      deadline_mono_ms: performance.now() + 3_600_000,
    },
  });
  sessions.lockForAuthorityConflict(record.id, new Date(T0_MS).toISOString());
  const resolver = new AuthorityConflictResolver({
    sessionManager: sessions,
    verifyCashierPin: () => Promise.resolve(null),
    admission,
    onTakenOver: () => undefined,
    audit: { emit: () => undefined },
    resolveTerminalId: () => 'term-1',
    tillClockMs: () => tillMs,
  });
  return { sessions, resolver, ends };
}

const takeOver = { action: 'take_over_here', pin: '1234' } as const;

describe('takeover through the production parser and grant seam', () => {
  it('positive grace: adopted, then the grant is written for this till', async () => {
    const h = setup(admittedBody());
    expect(await h.resolver.resolve(takeOver)).toEqual({
      kind: 'resolved',
      action: 'take_over_here',
    });
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(wiring.evaluate(USER, new Date(T0_MS)).admissible).toBe(true);
  });

  it('positive grace refused for clock skew: released, and NO grant is left behind', async () => {
    const h = setup(admittedBody(), T0_MS + 3 * 60 * 60 * 1000);
    expect(await h.resolver.resolve(takeOver)).toEqual({ kind: 'refused', category: 'clock_skew' });
    await Promise.resolve();
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(wiring.evaluate(USER, new Date(T0_MS))).toEqual(refusal('grant_missing'));
    expect(h.ends).toHaveLength(1);
  });

  it('zero grace: the takeover is adopted (not misread as an invalidation), and no grant stands (grace 0)', async () => {
    const h = setup(admittedBody({ offline_grace_seconds: 0 }));
    expect(await h.resolver.resolve(takeOver)).toEqual({
      kind: 'resolved',
      action: 'take_over_here',
    });
    expect(h.sessions.getCurrent()?.authority).toBe('online_confirmed');
    expect(h.sessions.isLocked()).toBe(false);
    expect(h.ends).toEqual([]);
    expect(wiring.evaluate(USER, new Date(T0_MS)).admissible).toBe(false);
  });

  it('a malformed server_time passes the parser but is never adopted: released, no grant, locked', async () => {
    const h = setup(admittedBody({ server_time: 'not-a-time' }));
    expect(await h.resolver.resolve(takeOver)).toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    await Promise.resolve();
    expect(h.sessions.getCurrent()?.lock_cause).toBe('authority_conflict');
    expect(wiring.evaluate(USER, new Date(T0_MS))).toEqual(refusal('grant_missing'));
    expect(h.ends).toHaveLength(1);
  });
});
