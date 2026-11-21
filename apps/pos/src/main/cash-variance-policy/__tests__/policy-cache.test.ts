/**
 * RT-388 — the local policy cache (migration 0067 `cash_variance_policy_cache`):
 * one row, kept with no maximum age (DR-7), only ever read for the pairing's own
 * tenant and branch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createPolicyCache, type CachedPolicy } from '../policy-cache.js';
import type { VariancePolicy } from '../policy-core.js';

const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1' };
const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const LIMIT: VariancePolicy = {
  source: 'store',
  revisionId: REVISION,
  mode: 'limit',
  limitAmount: '250.50',
  currencyCode: 'EGP',
};

function entry(policy: VariancePolicy, over: Partial<CachedPolicy> = {}): CachedPolicy {
  return {
    policy,
    etag: '"abc"',
    serverTime: '2026-11-21T10:00:00.000Z',
    fetchedAt: '2026-11-21T10:00:01.000Z',
    ...over,
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

describe('createPolicyCache', () => {
  it('reads nothing before any policy was written', () => {
    expect(createPolicyCache(handleFor(db)).read(SCOPE)).toBeNull();
  });

  it('round-trips a limit policy with its ETag', () => {
    const cache = createPolicyCache(handleFor(db));
    cache.write(SCOPE, entry(LIMIT));
    expect(cache.read(SCOPE)).toEqual(entry(LIMIT));
  });

  it('round-trips the system default and a null ETag', () => {
    const cache = createPolicyCache(handleFor(db));
    const system: VariancePolicy = { source: 'system', revisionId: null, mode: 'none' };
    cache.write(SCOPE, entry(system, { etag: null }));
    expect(cache.read(SCOPE)).toEqual(entry(system, { etag: null }));
  });

  it('replaces the row: only the latest policy is kept', () => {
    const cache = createPolicyCache(handleFor(db));
    cache.write(SCOPE, entry(LIMIT));
    const none: VariancePolicy = { source: 'tenant', revisionId: REVISION, mode: 'none' };
    cache.write(SCOPE, entry(none, { etag: '"def"' }));
    expect(cache.read(SCOPE)).toEqual(entry(none, { etag: '"def"' }));
    expect(db.exec('SELECT COUNT(*) FROM cash_variance_policy_cache')[0]?.values).toEqual([[1]]);
  });

  it('never answers a policy cached for another tenant or branch', () => {
    const cache = createPolicyCache(handleFor(db));
    cache.write(SCOPE, entry(LIMIT));
    expect(cache.read({ tenantId: 'tenant-2', branchId: 'branch-1' })).toBeNull();
    expect(cache.read({ tenantId: 'tenant-1', branchId: 'branch-2' })).toBeNull();
  });

  it('replaces another scope row when the pairing changed', () => {
    const cache = createPolicyCache(handleFor(db));
    cache.write(SCOPE, entry(LIMIT));
    const other = { tenantId: 'tenant-2', branchId: 'branch-9' };
    cache.write(other, entry(LIMIT, { etag: '"zzz"' }));
    expect(cache.read(SCOPE)).toBeNull();
    expect(cache.read(other)?.etag).toBe('"zzz"');
  });

  it('keeps an old policy as old as the terminal is: no age ever expires it', () => {
    const cache = createPolicyCache(handleFor(db));
    cache.write(SCOPE, entry(LIMIT, { fetchedAt: '2020-01-01T00:00:00.000Z' }));
    expect(cache.read(SCOPE)?.policy).toEqual(LIMIT);
  });
});
