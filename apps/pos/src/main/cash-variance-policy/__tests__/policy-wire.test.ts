/**
 * RT-388 — the strict reader of the device policy read
 * (`cash-variance-policy.openapi.yaml` `DeviceCashVariancePolicy`) and the
 * `FrozenPolicy` body of an open (`pos-shifts.openapi.yaml`).
 */
import { describe, expect, it } from 'vitest';

import { fallbackPolicy, type VariancePolicy } from '../policy-core.js';
import { frozenPolicyBody, normalizeFrozenPolicy, readPolicyBody } from '../policy-wire.js';

const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const SERVER_TIME = '2026-11-21T10:00:00.000Z';

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policySource: 'tenant',
    policyRevisionId: REVISION,
    policyValue: { mode: 'limit', limitAmount: '100.00', currencyCode: 'EGP' },
    serverTime: SERVER_TIME,
    ...over,
  };
}

describe('readPolicyBody', () => {
  it('reads a tenant limit', () => {
    expect(readPolicyBody(body())).toEqual({
      policy: {
        source: 'tenant',
        revisionId: REVISION,
        mode: 'limit',
        limitAmount: '100.00',
        currencyCode: 'EGP',
      },
      serverTime: SERVER_TIME,
    });
  });

  it('reads a store limit and lower-cases the revision id', () => {
    const read = readPolicyBody(
      body({ policySource: 'store', policyRevisionId: REVISION.toUpperCase() }),
    );
    expect(read?.policy).toMatchObject({ source: 'store', revisionId: REVISION });
  });

  it('reads the system default (none, no revision id)', () => {
    const read = readPolicyBody(
      body({ policySource: 'system', policyRevisionId: null, policyValue: { mode: 'none' } }),
    );
    expect(read?.policy).toEqual({ source: 'system', revisionId: null, mode: 'none' });
  });

  it('reads a tenant that chose none', () => {
    const read = readPolicyBody(body({ policyValue: { mode: 'none' } }));
    expect(read?.policy).toEqual({ source: 'tenant', revisionId: REVISION, mode: 'none' });
  });

  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['an array', []],
    ['an unknown top-level key', body({ extra: 1 })],
    ['a missing serverTime', body({ serverTime: undefined })],
    ['a serverTime that is not an instant', body({ serverTime: 'yesterday' })],
    [
      'the fallback source (never delivered)',
      body({ policySource: 'fallback', policyRevisionId: null }),
    ],
    ['an unknown source', body({ policySource: 'region' })],
    ['a tenant policy without a revision id', body({ policyRevisionId: null })],
    ['a revision id that is not a uuid', body({ policyRevisionId: 'rev-1' })],
    [
      'a system policy with a revision id',
      body({ policySource: 'system', policyValue: { mode: 'none' } }),
    ],
    ['a system policy that is a limit', body({ policySource: 'system', policyRevisionId: null })],
    ['an unknown mode', body({ policyValue: { mode: 'warn' } })],
    ['a limit without an amount', body({ policyValue: { mode: 'limit', currencyCode: 'EGP' } })],
    ['a limit without a currency', body({ policyValue: { mode: 'limit', limitAmount: '10.00' } })],
    ['a none carrying an amount', body({ policyValue: { mode: 'none', limitAmount: '1.00' } })],
    [
      'an unknown key inside the value',
      body({ policyValue: { mode: 'limit', limitAmount: '1.00', currencyCode: 'EGP', x: 1 } }),
    ],
  ])('refuses %s', (_name, value) => {
    expect(readPolicyBody(value)).toBeNull();
  });

  it.each(['1e3', '-1.00', '.5', '5.', '1.23456', '1234567890123456', '', ' 1', '1,5'])(
    'refuses the limit amount %j',
    (limitAmount) => {
      expect(
        readPolicyBody(body({ policyValue: { mode: 'limit', limitAmount, currencyCode: 'EGP' } })),
      ).toBeNull();
    },
  );

  it.each(['egp', 'EG', 'EGPP', '1GP'])('refuses the currency %j', (currencyCode) => {
    expect(
      readPolicyBody(body({ policyValue: { mode: 'limit', limitAmount: '1.00', currencyCode } })),
    ).toBeNull();
  });
});

describe('normalizeFrozenPolicy', () => {
  const LIMIT: VariancePolicy = {
    source: 'store',
    revisionId: REVISION.toUpperCase(),
    mode: 'limit',
    limitAmount: '75.5',
    currencyCode: 'EGP',
  };

  it('lower-cases the revision id and keeps the value', () => {
    expect(normalizeFrozenPolicy(LIMIT)).toEqual({ ...LIMIT, revisionId: REVISION });
  });

  it('accepts none for a tenant, the system default and a fallback none', () => {
    const tenantNone: VariancePolicy = { source: 'tenant', revisionId: REVISION, mode: 'none' };
    expect(normalizeFrozenPolicy(tenantNone)).toEqual(tenantNone);
    const system: VariancePolicy = { source: 'system', revisionId: null, mode: 'none' };
    expect(normalizeFrozenPolicy(system)).toEqual(system);
    const fallbackNone: VariancePolicy = { source: 'fallback', revisionId: null, mode: 'none' };
    expect(normalizeFrozenPolicy(fallbackNone)).toEqual(fallbackNone);
  });

  it.each<[string, VariancePolicy]>([
    ['a store policy without a revision id', { ...LIMIT, revisionId: null }],
    ['a revision id that is not a uuid', { ...LIMIT, revisionId: 'rev-1' }],
    [
      'a system policy carrying a revision id',
      { source: 'system', revisionId: REVISION, mode: 'none' },
    ],
    ['a system policy that is a limit', { ...LIMIT, source: 'system', revisionId: null }],
    ['a limit that is not an exact decimal', { ...LIMIT, limitAmount: '1e3' }],
    ['a limit finer than four digits', { ...LIMIT, limitAmount: '1.00001' }],
    ['a currency that is not ISO-shaped', { ...LIMIT, currencyCode: 'eg' }],
  ])('refuses %s', (_name, policy) => {
    expect(normalizeFrozenPolicy(policy)).toBeNull();
  });
});

describe('frozenPolicyBody', () => {
  it('writes a limit policy as the contract FrozenPolicy', () => {
    const read = readPolicyBody(body());
    if (read === null) throw new Error('fixture: the body must read');
    expect(frozenPolicyBody(read.policy)).toEqual({
      policySource: 'tenant',
      policyRevisionId: REVISION,
      policyValue: { mode: 'limit', limitAmount: '100.00', currencyCode: 'EGP' },
    });
  });

  it('writes none without limit members and a null revision id for system', () => {
    expect(frozenPolicyBody({ source: 'system', revisionId: null, mode: 'none' })).toEqual({
      policySource: 'system',
      policyRevisionId: null,
      policyValue: { mode: 'none' },
    });
  });

  it('writes the fallback as source fallback, null revision id, limit 0', () => {
    expect(frozenPolicyBody(fallbackPolicy('EGP'))).toEqual({
      policySource: 'fallback',
      policyRevisionId: null,
      policyValue: { mode: 'limit', limitAmount: '0.00', currencyCode: 'EGP' },
    });
  });
});
