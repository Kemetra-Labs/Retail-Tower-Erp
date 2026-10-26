/**
 * RT-308 (RT-113 P3, 10763 D11) — the offline roster source: the grants that
 * are admissible NOW on this terminal, from the real sealed store
 * (`listAdmissible`) and through the wiring (tombstones first).
 * Shared harness: `__helpers__/offline-grant-wiring-harness.ts`.
 */
import { describe, expect, it } from 'vitest';

import { OFFLINE_GRANT_MAX_USES } from '../offline-grant-store.js';
import {
  DISPLAY_NAME,
  EPOCH,
  HOUR_MS,
  MIN_MS,
  OPERATOR,
  SENSITIVE_VALUES,
  T0_MS,
  USER,
  admitted,
  at,
  grantBlob,
  scope,
  setGrantBlob,
} from './__helpers__/offline-grant-fixture.js';
import {
  OPERATOR_2,
  USER_2,
  admit,
  admitBoth,
  breakable,
  g,
  invalidate,
  installWiringHarness,
  logCalls,
  makeWiring,
  setWiring,
  store,
  wiring,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

function users(list: { user_id: string }[]): string[] {
  return list.map((x) => x.user_id).sort((a, b) => a.localeCompare(b));
}

const NOW = at(T0_MS + MIN_MS);

describe('store.listAdmissible — only grants admissible now, in this scope', () => {
  it('lists every admissible grant of the scope, with its identity and name', () => {
    admitBoth();
    const list = store.listAdmissible(scope(), NOW);
    expect(users(list)).toEqual([USER, USER_2].sort((a, b) => a.localeCompare(b)));
    const mine = list.find((x) => x.user_id === USER);
    expect(mine).toMatchObject({ operator_id: OPERATOR, display_name: DISPLAY_NAME });
    expect(list.find((x) => x.user_id === USER_2)?.operator_id).toBe(OPERATOR_2);
  });

  it('lists nobody for another terminal, branch, tenant or pairing epoch', () => {
    admitBoth();
    for (const other of [
      scope({ terminal_id: 'terminal-other' }),
      scope({ branch_id: 'branch-other' }),
      scope({ tenant_id: 'tenant-other' }),
      scope({ pairing_epoch: EPOCH + 1 }),
    ]) {
      expect(store.listAdmissible(other, NOW)).toEqual([]);
    }
  });

  it('drops an expired grant (24 h default)', () => {
    admitBoth();
    store.upsertFromAdmitted(scope(), admitted({ offline_grace_seconds: 60 }));
    expect(users(store.listAdmissible(scope(), at(T0_MS + 2 * MIN_MS)))).toEqual([USER_2]);
    expect(store.listAdmissible(scope(), at(T0_MS + 24 * HOUR_MS))).toEqual([]);
  });

  it('drops a grant whose 8 uses are spent', () => {
    admitBoth();
    for (let i = 0; i < OFFLINE_GRANT_MAX_USES; i += 1) {
      expect(store.consumeOfflineUse(scope(), USER, NOW).admissible).toBe(true);
    }
    expect(users(store.listAdmissible(scope(), NOW))).toEqual([USER_2]);
  });

  it('drops an invalidated grant and a tampered (swapped) body', () => {
    admitBoth();
    store.invalidate(scope(), USER_2, 'forbidden');
    expect(users(store.listAdmissible(scope(), NOW))).toEqual([USER]);
    // USER's body copied into USER_2's row: no proof for either row's key.
    admit({ user_id: USER_2, operator_id: OPERATOR_2 });
    setGrantBlob(g.raw, grantBlob(g.raw, USER), USER_2);
    expect(users(store.listAdmissible(scope(), NOW))).toEqual([USER]);
  });

  it('lists nobody on a clock set back more than 5 minutes', () => {
    admitBoth();
    expect(store.listAdmissible(scope(), at(T0_MS - 6 * MIN_MS))).toEqual([]);
  });

  it('lists nobody for an invalid scope or time, and never leaks a grant field to the log', () => {
    admitBoth();
    expect(store.listAdmissible(scope({ terminal_id: '' }), NOW)).toEqual([]);
    expect(store.listAdmissible(scope(), new Date(Number.NaN))).toEqual([]);
    const logs = JSON.stringify(logCalls);
    for (const v of SENSITIVE_VALUES) expect(logs).not.toContain(v);
  });

  it('a storage failure lists nobody (never throws)', () => {
    admitBoth();
    g.raw.run('DROP TABLE cashier_offline_grants');
    expect(store.listAdmissible(scope(), NOW)).toEqual([]);
    expect(JSON.stringify(logCalls)).toContain('"op":"list"');
  });
});

describe('wiring.listAdmissible — tombstones first', () => {
  it('passes the store list through for the bound scope', () => {
    admitBoth();
    expect(users(wiring.listAdmissible(NOW))).toEqual(
      [USER, USER_2].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('lists nobody when the terminal is not paired (no scope)', () => {
    admitBoth();
    wiring.setScope(null);
    expect(wiring.listAdmissible(NOW)).toEqual([]);
  });

  it('a held per-user invalidation drops that user only', () => {
    admitBoth();
    const b = breakable();
    b.broken.add('invalidate');
    setWiring(makeWiring({ store: b.store }));
    wiring.setScope(scope());
    invalidate({ reason: 'refused', user_id: USER });
    expect(users(wiring.listAdmissible(NOW))).toEqual([USER_2]);
  });

  it('a held terminal-wide invalidation lists nobody', () => {
    admitBoth();
    const b = breakable();
    b.broken.add('invalidateAll');
    setWiring(makeWiring({ store: b.store }));
    wiring.setScope(scope());
    invalidate({ reason: 'device_unauthorized' });
    expect(wiring.listAdmissible(NOW)).toEqual([]);
  });

  it('a throwing store lists nobody (never throws)', () => {
    admitBoth();
    const b = breakable();
    b.broken.add('listAdmissible');
    setWiring(makeWiring({ store: b.store }));
    wiring.setScope(scope());
    expect(wiring.listAdmissible(NOW)).toEqual([]);
  });
});
