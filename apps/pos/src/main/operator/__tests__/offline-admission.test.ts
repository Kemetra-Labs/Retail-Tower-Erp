/**
 * RT-308 (RT-113 P3) — `consumeOfflineAdmission`: one use spent through the
 * grant wiring, then the session bound; every refusal fails closed, is audited
 * with its category only and never leaks a grant field.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import {
  auditOfflineAdmitted,
  backendUnreachable,
  consumeOfflineAdmission,
  type OfflineAdmissionDeps,
  type OfflineAdmissionSubject,
} from '../offline-admission.js';
import type { OfflineGrant, OfflineGrantEvaluation } from '../offline-grant-store.js';

const NOW_MS = Date.parse('2026-10-26T09:00:00.000Z');
const MONO = 10_000;
const LEFT_MS = 5 * 3_600_000;

const WHO: OfflineAdmissionSubject = {
  user_id: 'user-SENTINEL-1',
  operator_id: 'user_clerk_SENTINEL_1',
  tenant_id: 't1',
  branch_id: 'b1',
  terminal_id: 'term-1',
};

function grant(over: Partial<OfflineGrant> = {}): OfflineGrant {
  return {
    user_id: WHO.user_id,
    operator_id: WHO.operator_id,
    display_name: 'Mona SENTINEL',
    admission_id: 'adm-SENTINEL-1',
    issued_at_local_ms: NOW_MS - 3_600_000,
    expires_at_local_ms: NOW_MS + LEFT_MS,
    offline_admissions_used: 1,
    offline_admissions_remaining: 7,
    ...over,
  };
}

function harness(answer: () => OfflineGrantEvaluation): {
  deps: OfflineAdmissionDeps;
  audits: AuditEvent[];
  logs: unknown[];
  consume: ReturnType<typeof vi.fn<(user_id: string, nowWall: Date) => OfflineGrantEvaluation>>;
} {
  const audits: AuditEvent[] = [];
  const logs: unknown[] = [];
  const consume = vi.fn<(user_id: string, nowWall: Date) => OfflineGrantEvaluation>(() => answer());
  return {
    audits,
    logs,
    consume,
    deps: {
      grants: { consumeOfflineUse: consume },
      audit: { emit: (e) => void audits.push(e) },
      uuid: () => 'evt-1',
      now: () => new Date(NOW_MS),
      monotonicNow: () => MONO,
      logger: {
        info: (...a: unknown[]) => void logs.push(a),
        warn: (...a: unknown[]) => void logs.push(a),
      },
    },
  };
}

describe('backendUnreachable', () => {
  it('is true only for a transport failure or a 5xx', () => {
    expect(backendUnreachable('no_connection')).toBe(true);
    expect(backendUnreachable('unavailable')).toBe(true);
    for (const k of [
      'admitted',
      'active_elsewhere',
      'refused',
      'device_unauthorized',
      'no_token',
      'idempotency_conflict',
      'rate_limited',
      'rejected',
    ] as const) {
      expect(backendUnreachable(k)).toBe(false);
    }
  });
});

describe('consumeOfflineAdmission', () => {
  it('admits from an admissible grant: one consume, the grant name, both bounds', () => {
    const h = harness(() => ({ admissible: true, grant: grant() }));
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({
      kind: 'admitted',
      display_name: 'Mona SENTINEL',
      fields: {
        user_id: WHO.user_id,
        valid_until_ms: NOW_MS + LEFT_MS,
        deadline_mono_ms: MONO + LEFT_MS,
      },
    });
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.consume.mock.calls[0]?.[0]).toBe(WHO.user_id);
    expect(h.audits).toEqual([]); // the admitted audit follows the session
  });

  it.each([
    'grant_missing',
    'grant_invalidated',
    'grant_expired',
    'count_exhausted',
    'clock_suspect',
    'scope_mismatch',
    'tampered',
    'storage',
  ] as const)('refuses %s and audits the category only', (category) => {
    const h = harness(() => ({ admissible: false, category }));
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({ kind: 'refused', category });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action_category: 'operator.signin.offline_refused',
      acting_operator_id: WHO.operator_id,
      originating_terminal_id: WHO.terminal_id,
      session_id: null,
      payload: { category },
    });
  });

  it('a throwing grant source is a storage refusal', () => {
    const h = harness(() => {
      throw new Error('disk I/O');
    });
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({ kind: 'refused', category: 'storage' });
  });

  it.each([
    ['another user', { user_id: 'user-other' }],
    ['another provider subject', { operator_id: 'user_clerk_other' }],
  ])('refuses a grant of %s (scope_mismatch)', (_l, over) => {
    const h = harness(() => ({ admissible: true, grant: grant(over) }));
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({
      kind: 'refused',
      category: 'scope_mismatch',
    });
  });

  it.each([
    ['already expired', { expires_at_local_ms: NOW_MS }],
    ['an unreadable expiry', { expires_at_local_ms: Number.NaN }],
  ])('refuses %s (grant_expired)', (_l, over) => {
    const h = harness(() => ({ admissible: true, grant: grant(over) }));
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({
      kind: 'refused',
      category: 'grant_expired',
    });
  });

  it('refuses on an unreadable monotonic clock', () => {
    const h = harness(() => ({ admissible: true, grant: grant() }));
    h.deps.monotonicNow = () => Number.NaN;
    expect(consumeOfflineAdmission(h.deps, WHO)).toMatchObject({ kind: 'refused' });
  });

  it('a throwing audit or logger never changes the outcome', () => {
    const h = harness(() => ({ admissible: false, category: 'grant_missing' }));
    h.deps.audit = {
      emit: () => {
        throw new Error('audit down');
      },
    };
    h.deps.logger = {
      info: () => {
        throw new Error('log down');
      },
      warn: () => {
        throw new Error('log down');
      },
    };
    expect(consumeOfflineAdmission(h.deps, WHO)).toEqual({
      kind: 'refused',
      category: 'grant_missing',
    });
  });

  it('works with the default clocks, id source and no audit', () => {
    const answer = (): OfflineGrantEvaluation => ({
      admissible: true,
      grant: grant({ expires_at_local_ms: Date.now() + LEFT_MS }),
    });
    const deps: OfflineAdmissionDeps = { grants: { consumeOfflineUse: answer } };
    expect(consumeOfflineAdmission(deps, WHO).kind).toBe('admitted');
    expect(
      consumeOfflineAdmission(
        { grants: { consumeOfflineUse: () => ({ admissible: false, category: 'storage' }) } },
        WHO,
      ),
    ).toEqual({ kind: 'refused', category: 'storage' });
  });

  it('never logs a grant field', () => {
    const h = harness(() => ({ admissible: false, category: 'tampered' }));
    consumeOfflineAdmission(h.deps, WHO);
    auditOfflineAdmitted(h.deps, WHO, 'sess-1');
    const logs = JSON.stringify(h.logs);
    for (const v of [WHO.user_id, WHO.operator_id, 'Mona SENTINEL', 'adm-SENTINEL-1']) {
      expect(logs).not.toContain(v);
    }
  });
});

describe('auditOfflineAdmitted', () => {
  it('records the admission against the new session, payload empty', () => {
    const h = harness(() => ({ admissible: true, grant: grant() }));
    auditOfflineAdmitted(h.deps, WHO, 'sess-1');
    expect(h.audits).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: 't1',
        branch_id: 'b1',
        originating_terminal_id: 'term-1',
        acting_operator_id: WHO.operator_id,
        session_id: 'sess-1',
        shift_id: null,
        action_category: 'operator.signin.offline_admitted',
        created_at: new Date(NOW_MS).toISOString(),
        approving_supervisor_id: null,
        payload: {},
      },
    ]);
  });
});
