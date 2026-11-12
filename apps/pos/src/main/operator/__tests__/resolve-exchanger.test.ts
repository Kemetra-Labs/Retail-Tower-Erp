import { describe, expect, it, vi } from 'vitest';

import type { OperatorExchangeResult } from '../operator-exchanger.js';
import { resolveOperatorExchanger } from '../resolve-exchanger.js';

/**
 * RT-792 / RT-945 — choosing the manager/admin credential exchanger.
 *
 * Descope is the only provider: `OPERATOR_IDENTITY_PROVIDER` unset, empty or
 * `descope` selects it; any other value (including the retired `clerk`)
 * refuses. Any missing or malformed setting logs one structured warning and
 * yields an exchanger that refuses generically WITHOUT a network call.
 */

const PROJECT_ID = 'P2abcdefghijklmnopqrstuvwxyz';
const DESCOPE_SIGNIN_URL = 'https://api.descope.com/v1/auth/password/signin';

function setup(env: Record<string, string | undefined>) {
  const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
  const warn = vi.fn();
  const exchanger = resolveOperatorExchanger({ env, fetch: fetchImpl, logger: { warn } });
  return { exchanger, fetchImpl, warn };
}

async function exchange(env: Record<string, string | undefined>) {
  const ctx = setup(env);
  const result = await ctx.exchanger.exchange({ identifier: 'i', password: 'p' });
  return { ...ctx, result };
}

function calledUrl(fetchImpl: ReturnType<typeof setup>['fetchImpl']): string {
  const call = fetchImpl.mock.calls[0] as unknown as [string] | undefined;
  return call?.[0] ?? '';
}

function warnedEvent(warn: ReturnType<typeof setup>['warn']): unknown {
  const call = warn.mock.calls[0] as unknown as [{ event: string }] | undefined;
  return call?.[0].event;
}

describe('resolveOperatorExchanger — default Descope', () => {
  it.each([undefined, '', '  '])('uses Descope when the provider is %j', async (provider) => {
    const { fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: provider,
      DESCOPE_PROJECT_ID: PROJECT_ID,
    });
    expect(calledUrl(fetchImpl)).toBe(DESCOPE_SIGNIN_URL);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses generically when the project id is unset and no provider is set', async () => {
    const { result, fetchImpl, warn } = await exchange({});
    expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.missing_project_id');
  });
});

describe('resolveOperatorExchanger — Descope', () => {
  it.each(['descope', 'DESCOPE', ' descope '])(
    'uses Descope when the provider is %j',
    async (p) => {
      const { fetchImpl, warn } = await exchange({
        OPERATOR_IDENTITY_PROVIDER: p,
        DESCOPE_PROJECT_ID: PROJECT_ID,
      });
      expect(calledUrl(fetchImpl)).toBe(DESCOPE_SIGNIN_URL);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('accepts a project id with surrounding whitespace', async () => {
    const { fetchImpl } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: ` ${PROJECT_ID}\n`,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${PROJECT_ID}`);
  });

  it('refuses generically when the project id is unset', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
    });
    expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.missing_project_id');
  });

  it('refuses generically when the project id is malformed, without logging it', async () => {
    const bad = 'P2abc/../evil';
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: bad,
    });
    expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.malformed_project_id');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(bad);
  });
});

/**
 * RT-1346 (RT-1345 D2) — a terminal installed from the downloaded installer has no
 * `DESCOPE_PROJECT_ID`; the id baked into the build is its source. Same validation as
 * the environment value (shape, US region), and an environment value is authoritative.
 */
describe('resolveOperatorExchanger — baked project id', () => {
  type Baked = { readonly lane: 'pilot'; readonly descopeProjectId?: string } | null;

  function setupBaked(env: Record<string, string | undefined>, baked: Baked) {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
    const warn = vi.fn();
    const exchanger = resolveOperatorExchanger({ env, fetch: fetchImpl, logger: { warn }, baked });
    return { exchanger, fetchImpl, warn };
  }

  function bearerOf(fetchImpl: ReturnType<typeof setupBaked>['fetchImpl']): string | undefined {
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    return (init.headers as Record<string, string>)['Authorization'];
  }

  it('uses the baked id when the environment has none', async () => {
    const { exchanger, fetchImpl, warn } = setupBaked(
      {},
      { lane: 'pilot', descopeProjectId: PROJECT_ID },
    );
    await exchanger.exchange({ identifier: 'i', password: 'p' });
    expect(bearerOf(fetchImpl)).toBe(`Bearer ${PROJECT_ID}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the environment id wins over the baked one', async () => {
    const envId = 'P2zyxwvutsrqponmlkjihgfedcba';
    const { exchanger, fetchImpl } = setupBaked(
      { DESCOPE_PROJECT_ID: envId },
      { lane: 'pilot', descopeProjectId: PROJECT_ID },
    );
    await exchanger.exchange({ identifier: 'i', password: 'p' });
    expect(bearerOf(fetchImpl)).toBe(`Bearer ${envId}`);
  });

  it('a malformed environment id refuses; the baked id is not substituted behind it', async () => {
    const { exchanger, fetchImpl, warn } = setupBaked(
      { DESCOPE_PROJECT_ID: 'P2abc/../evil' },
      { lane: 'pilot', descopeProjectId: PROJECT_ID },
    );
    expect(await exchanger.exchange({ identifier: 'i', password: 'p' })).toEqual({
      kind: 'refused',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.malformed_project_id');
  });

  it.each<[string, Baked]>([
    ['no baked configuration', null],
    ['a baked file without a project id', { lane: 'pilot' }],
  ])('with neither source (%s) it refuses generically, as today', async (_name, baked) => {
    const { exchanger, fetchImpl, warn } = setupBaked({}, baked);
    expect(await exchanger.exchange({ identifier: 'i', password: 'p' })).toEqual({
      kind: 'refused',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.missing_project_id');
  });

  it('defaults to the configuration loaded at start-up, which is none in a test', async () => {
    const { result, warn } = await exchange({});
    expect(result).toEqual({ kind: 'refused' });
    expect(warnedEvent(warn)).toBe('operator.descope.missing_project_id');
  });
});

describe('resolveOperatorExchanger — regional Descope project', () => {
  it('refuses a regional project id (its API host is not api.descope.com)', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'descope',
      DESCOPE_PROJECT_ID: `Peuc1${'a'.repeat(27)}`,
    });
    expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.descope.regional_project_unsupported');
  });
});

describe('resolveOperatorExchanger — unknown provider', () => {
  it.each(['clerk', ' Clerk '])(
    'refuses the retired provider %j without a network call',
    async (p) => {
      const { result, fetchImpl, warn } = await exchange({
        OPERATOR_IDENTITY_PROVIDER: p,
        DESCOPE_PROJECT_ID: PROJECT_ID,
      });
      expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warnedEvent(warn)).toBe('operator.identity.unknown_provider');
    },
  );

  it('fails closed (no silent fallback) and does not log the raw value', async () => {
    const { result, fetchImpl, warn } = await exchange({
      OPERATOR_IDENTITY_PROVIDER: 'okta-secret-ish',
      DESCOPE_PROJECT_ID: PROJECT_ID,
    });
    expect(result).toEqual<OperatorExchangeResult>({ kind: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnedEvent(warn)).toBe('operator.identity.unknown_provider');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('okta-secret-ish');
  });
});
