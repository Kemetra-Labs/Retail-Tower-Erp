/**
 * RT-388 — the policy service: refresh (fetch + cache) and resolve (cached
 * policy, else the fail-closed fallback).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createPolicyCache, type PolicyCache } from '../policy-cache.js';
import type { PolicyClient, PolicyReadOutcome } from '../policy-client.js';
import type { VariancePolicy } from '../policy-core.js';
import { createPolicyService, type PolicyService } from '../policy-service.js';

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1' };
const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const NOW = '2026-11-21T10:00:00.000Z';

function limit(amount: string): VariancePolicy {
  return {
    source: 'tenant',
    revisionId: REVISION,
    mode: 'limit',
    limitAmount: amount,
    currencyCode: 'EGP',
  };
}

function ok(policy: VariancePolicy, etag: string | null = '"e1"'): PolicyReadOutcome {
  return { kind: 'ok', policy: { policy, serverTime: NOW }, etag };
}

interface Harness {
  service: PolicyService;
  cache: PolicyCache;
  reads: Array<{ token: string; ifNoneMatch: string | null }>;
  state: {
    outcome: PolicyReadOutcome;
    token: string | null;
    scope: typeof SCOPE | null;
    /** Runs while the read is in flight. */
    during: () => void;
  };
}

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
});

afterEach(() => {
  db.close();
});

function harness(cache: PolicyCache = createPolicyCache(handleFor(db))): Harness {
  const reads: Harness['reads'] = [];
  const state: Harness['state'] = {
    outcome: ok(limit('100.00')),
    token: 'device-token',
    scope: SCOPE,
    during: () => undefined,
  };
  const client: PolicyClient = {
    read: async (token, ifNoneMatch) => {
      reads.push({ token, ifNoneMatch });
      await Promise.resolve();
      state.during();
      return state.outcome;
    },
  };
  const service = createPolicyService({
    client,
    cache,
    readDeviceToken: () => Promise.resolve(state.token),
    getScope: () => Promise.resolve(state.scope),
    now: () => NOW,
  });
  return { service, cache, reads, state };
}

describe('refresh', () => {
  it('fetches unconditionally the first time and caches the answer', async () => {
    const h = harness();
    expect(await h.service.refresh()).toBe('updated');
    expect(h.reads).toEqual([{ token: 'device-token', ifNoneMatch: null }]);
    expect(h.cache.read(SCOPE)).toEqual({
      policy: limit('100.00'),
      etag: '"e1"',
      serverTime: NOW,
      fetchedAt: NOW,
    });
  });

  it('sends the cached ETag and keeps the cache on a 304', async () => {
    const h = harness();
    await h.service.refresh();
    h.state.outcome = { kind: 'not_modified' };
    expect(await h.service.refresh()).toBe('unchanged');
    expect(h.reads[1]).toEqual({ token: 'device-token', ifNoneMatch: '"e1"' });
    expect(h.cache.read(SCOPE)?.policy).toEqual(limit('100.00'));
  });

  it('replaces the cache when the policy changed', async () => {
    const h = harness();
    await h.service.refresh();
    h.state.outcome = ok(limit('50.00'), '"e2"');
    expect(await h.service.refresh()).toBe('updated');
    expect(h.cache.read(SCOPE)).toMatchObject({ policy: limit('50.00'), etag: '"e2"' });
  });

  it.each<PolicyReadOutcome>([
    { kind: 'unreachable' },
    { kind: 'unauthorized' },
    { kind: 'server_error' },
    { kind: 'unreadable' },
  ])('keeps the cached policy when the read ends $kind', async (outcome) => {
    const h = harness();
    await h.service.refresh();
    h.state.outcome = outcome;
    expect(await h.service.refresh()).toBe('failed');
    expect(h.cache.read(SCOPE)?.policy).toEqual(limit('100.00'));
  });

  it('reads nothing while unpaired or without a device token', async () => {
    const h = harness();
    h.state.scope = null;
    expect(await h.service.refresh()).toBe('skipped');
    h.state.scope = SCOPE;
    h.state.token = null;
    expect(await h.service.refresh()).toBe('skipped');
    expect(h.reads).toHaveLength(0);
  });

  it('runs one read for overlapping refreshes', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.service.refresh(), h.service.refresh()]);
    expect([a, b]).toEqual(['updated', 'updated']);
    expect(h.reads).toHaveLength(1);
  });

  it('drops an answer that arrives after the pairing changed', async () => {
    const h = harness();
    h.state.during = () => {
      h.state.scope = { tenantId: 'tenant-2', branchId: 'branch-9' };
    };
    expect(await h.service.refresh()).toBe('skipped');
    expect(h.cache.read(SCOPE)).toBeNull();
    expect(h.cache.read({ tenantId: 'tenant-2', branchId: 'branch-9' })).toBeNull();
  });

  it('answers failed, never throws, when the cache cannot be written', async () => {
    const broken: PolicyCache = {
      read: () => null,
      write: () => {
        throw new Error('database closed');
      },
    };
    const h = harness(broken);
    expect(await h.service.refresh()).toBe('failed');
  });

  it('reads nothing after stop', async () => {
    const h = harness();
    h.service.stop();
    expect(await h.service.refresh()).toBe('skipped');
    expect(h.reads).toHaveLength(0);
  });

  it('writes nothing when stopped while the read was in flight', async () => {
    const h = harness();
    h.state.during = () => {
      h.service.stop();
    };
    expect(await h.service.refresh()).toBe('skipped');
    expect(h.cache.read(SCOPE)).toBeNull();
  });
});

describe('resolve', () => {
  it('is the fail-closed fallback in the shift currency when nothing was fetched', () => {
    const h = harness();
    expect(h.service.resolve({ scope: SCOPE, shiftCurrencyCode: 'EGP' })).toEqual({
      source: 'fallback',
      revisionId: null,
      mode: 'limit',
      limitAmount: '0.00',
      currencyCode: 'EGP',
    });
  });

  it('is the cached policy once fetched, with no age limit', async () => {
    const h = harness();
    await h.service.refresh();
    expect(h.service.resolve({ scope: SCOPE, shiftCurrencyCode: 'EGP' })).toEqual(limit('100.00'));
  });

  it('is the fallback for a pairing whose policy was never fetched', async () => {
    const h = harness();
    await h.service.refresh();
    const resolved = h.service.resolve({
      scope: { tenantId: 'tenant-2', branchId: 'branch-1' },
      shiftCurrencyCode: 'EGP',
    });
    expect(resolved.source).toBe('fallback');
  });

  it('is the fallback when the cache cannot be read', () => {
    const broken: PolicyCache = {
      read: () => {
        throw new Error('database closed');
      },
      write: () => undefined,
    };
    const h = harness(broken);
    expect(h.service.resolve({ scope: SCOPE, shiftCurrencyCode: 'EGP' }).source).toBe('fallback');
  });
});
