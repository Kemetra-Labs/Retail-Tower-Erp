import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorityClockOf,
  newSaleBlock,
  offlineAuthorityExpired,
  onlineAuthorityBound,
} from '../../../../src/main/operator/offline-authority.js';
import { OFFLINE_GRANT_MAX_TTL_MS } from '../../../../src/main/operator/offline-grant-store.js';
import { SessionManager } from '../../../../src/main/operator/session-manager.js';

/**
 * RT-309 (RT-113 10763 D6; RT-308 scope note c13973 item 1) — an
 * online-confirmed cashier session that loses connectivity keeps running, but
 * only within the bound its latest online admission gave it: the same expiry
 * an offline grant written from that admission would have
 * (`received + min(offline_grace, 72 h)`), never earlier than the server
 * admission's own deadline (`sent + admission TTL`). Every `admitted` (sign-in,
 * takeover, heartbeat, reconcile) restamps it. After it, a NEW sale is refused
 * `offline_authority_expired`; nothing else changes.
 */

const HOUR_MS = 3_600_000;
const ADMISSION = {
  user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abc',
  admission_id: '0192f6a0-aaaa-7bbb-8ccc-000000000001',
  admission_ttl_seconds: 12 * 3_600,
  offline_grace_seconds: 24 * 3_600,
  admission_generation: 'gen-signin-0001',
};

function createCashier(m: SessionManager, over: Partial<typeof ADMISSION> = {}) {
  return m.create({
    operator_id: 'user_clerk_1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    cashier_admission: {
      ...ADMISSION,
      ...over,
      admission_requested_at_ms: performance.now(),
    },
  });
}

function b_fields(b: { valid_until_ms: number; deadline_mono_ms: number }) {
  return {
    authority_valid_until_ms: b.valid_until_ms,
    authority_deadline_mono_ms: b.deadline_mono_ms,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T08:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('onlineAuthorityBound (pure)', () => {
  const now = { wall_ms: 1_800_000_000_000, mono_ms: 10_000 };

  it('is received + offline grace when the grace is the longer window', () => {
    const b = onlineAuthorityBound(
      {
        offline_grace_seconds: 86_400,
        admission_ttl_seconds: 600,
        admission_requested_at_ms: 9_000,
      },
      now,
    );
    expect(b).toEqual({
      valid_until_ms: now.wall_ms + 86_400_000,
      deadline_mono_ms: now.mono_ms + 86_400_000,
    });
  });

  it('clamps the grace at the 72 h grant ceiling', () => {
    const b = onlineAuthorityBound(
      {
        offline_grace_seconds: 30 * 86_400,
        admission_ttl_seconds: 600,
        admission_requested_at_ms: 9_000,
      },
      now,
    );
    expect(b.deadline_mono_ms - now.mono_ms).toBe(OFFLINE_GRANT_MAX_TTL_MS);
    expect(b.valid_until_ms - now.wall_ms).toBe(OFFLINE_GRANT_MAX_TTL_MS);
  });

  it('grace 0 (offline disabled, OD8): bounded by the server admission deadline (sent + TTL)', () => {
    const b = onlineAuthorityBound(
      { offline_grace_seconds: 0, admission_ttl_seconds: 600, admission_requested_at_ms: 9_000 },
      now,
    );
    expect(b.deadline_mono_ms).toBe(9_000 + 600_000);
    expect(b.valid_until_ms).toBe(now.wall_ms + (9_000 + 600_000 - now.mono_ms));
  });

  it('a short grace never ends a session whose server admission is still live', () => {
    const b = onlineAuthorityBound(
      { offline_grace_seconds: 60, admission_ttl_seconds: 600, admission_requested_at_ms: 9_000 },
      now,
    );
    expect(b.deadline_mono_ms).toBe(9_000 + 600_000);
  });

  it('without a send stamp the admission deadline runs from now', () => {
    const b = onlineAuthorityBound({ offline_grace_seconds: 0, admission_ttl_seconds: 600 }, now);
    expect(b.deadline_mono_ms).toBe(now.mono_ms + 600_000);
  });

  it.each([
    ['a NaN grace', { offline_grace_seconds: Number.NaN, admission_ttl_seconds: 600 }],
    ['a negative grace', { offline_grace_seconds: -1, admission_ttl_seconds: 600 }],
    ['a NaN TTL', { offline_grace_seconds: 86_400, admission_ttl_seconds: Number.NaN }],
    [
      'a NaN send stamp',
      {
        offline_grace_seconds: 86_400,
        admission_ttl_seconds: 600,
        admission_requested_at_ms: Number.NaN,
      },
    ],
  ])('fails closed (expired at once) on %s', (_l, fields) => {
    expect(onlineAuthorityBound(fields, now)).toEqual({
      valid_until_ms: now.wall_ms,
      deadline_mono_ms: now.mono_ms,
    });
  });

  it('fails closed on an unreadable clock', () => {
    const b = onlineAuthorityBound(
      { offline_grace_seconds: 86_400, admission_ttl_seconds: 600 },
      { wall_ms: Number.NaN, mono_ms: 10_000 },
    );
    expect(offlineAuthorityExpired({ authority: 'online_confirmed', ...b_fields(b) }, now)).toBe(
      true,
    );
  });
});

describe('offlineAuthorityExpired for an online-confirmed session', () => {
  const now = { wall_ms: 1_000, mono_ms: 1_000 };

  it('is bounded when it carries a bound', () => {
    const fields = {
      authority: 'online_confirmed' as const,
      authority_valid_until_ms: 1_000,
      authority_deadline_mono_ms: 5_000,
    };
    expect(offlineAuthorityExpired(fields, now)).toBe(true);
    expect(offlineAuthorityExpired(fields, { wall_ms: 999, mono_ms: 999 })).toBe(false);
  });

  it('the latch is still reported first', () => {
    expect(
      newSaleBlock(
        {
          authority: 'online_confirmed',
          authority_latch: 'superseded_by_takeover',
          authority_valid_until_ms: 0,
          authority_deadline_mono_ms: 0,
        },
        now,
      ),
    ).toBe('authority_conflict');
  });
});

describe('SessionManager stamps the bound on every admitted', () => {
  it('an online sign-in starts bounded at received + grace; a new sale is allowed', () => {
    const m = new SessionManager();
    const record = createCashier(m);
    expect(record.authority_valid_until_ms).toBe(Date.now() + 24 * HOUR_MS);
    expect(newSaleBlock(record, authorityClockOf())).toBeNull();
  });

  it('no heartbeat answered for longer than the grace: a NEW sale is refused offline_authority_expired', () => {
    const m = new SessionManager();
    const record = createCashier(m);
    vi.advanceTimersByTime(24 * HOUR_MS - 1);
    expect(newSaleBlock(record, authorityClockOf())).toBeNull();
    vi.advanceTimersByTime(1);
    expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');
    // D6: the session itself keeps running (not ended, not locked).
    expect(m.getCurrent()?.id).toBe(record.id);
    expect(m.getCurrent()?.lock_state).toBe('active');
  });

  it('a renewed admission (heartbeat or reconnect) restamps the bound and lifts the block', () => {
    const m = new SessionManager();
    const record = createCashier(m);
    vi.advanceTimersByTime(30 * HOUR_MS);
    expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');
    expect(
      m.renewAdmission(record.id, {
        admission_id: ADMISSION.admission_id,
        admission_ttl_seconds: ADMISSION.admission_ttl_seconds,
        offline_grace_seconds: ADMISSION.offline_grace_seconds,
        admission_generation: 'gen-heartbeat-0002',
        admission_requested_at_ms: performance.now(),
      }),
    ).toBe(true);
    expect(newSaleBlock(record, authorityClockOf())).toBeNull();
    expect(record.authority_valid_until_ms).toBe(Date.now() + 24 * HOUR_MS);
  });

  it('a heartbeat that renews keeps a healthy till unblocked even with grace 0', () => {
    const m = new SessionManager();
    const record = createCashier(m, { offline_grace_seconds: 0, admission_ttl_seconds: 600 });
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(300_000); // TTL/2
      expect(newSaleBlock(record, authorityClockOf())).toBeNull();
      m.renewAdmission(record.id, {
        admission_id: ADMISSION.admission_id,
        admission_ttl_seconds: 600,
        offline_grace_seconds: 0,
        admission_generation: `gen-${String(i)}`,
        admission_requested_at_ms: performance.now(),
      });
    }
    vi.advanceTimersByTime(600_000);
    expect(newSaleBlock(record, authorityClockOf())).toBe('offline_authority_expired');
  });

  it('a wall clock set back cannot extend it (the monotonic deadline still ends it)', () => {
    const m = new SessionManager();
    const record = createCashier(m);
    vi.advanceTimersByTime(24 * HOUR_MS);
    expect(
      offlineAuthorityExpired(record, {
        wall_ms: Date.now() - 48 * HOUR_MS,
        mono_ms: performance.now(),
      }),
    ).toBe(true);
  });

  it('a manager session carries no cashier bound (the manager 24 h bound is not in this change)', () => {
    const m = new SessionManager();
    const record = m.create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
    });
    vi.advanceTimersByTime(100 * HOUR_MS);
    expect(record.authority_valid_until_ms).toBeUndefined();
    expect(newSaleBlock(record, authorityClockOf())).toBeNull();
  });

  it('the bound is main-only: never in the renderer bridge view', () => {
    const m = new SessionManager();
    createCashier(m);
    const view = m.getCurrentBridgeView() as unknown as Record<string, unknown>;
    expect(view).not.toHaveProperty('authority_valid_until_ms');
    expect(view).not.toHaveProperty('authority_deadline_mono_ms');
  });
});
