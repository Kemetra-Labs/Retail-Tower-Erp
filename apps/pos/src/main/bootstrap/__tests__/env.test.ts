import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getAppPath, resolveOperatorExchanger } = vi.hoisted(() => ({
  getAppPath: vi.fn<() => string>(),
  resolveOperatorExchanger: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getAppPath } }));
vi.mock('../../operator/resolve-exchanger.js', () => ({ resolveOperatorExchanger }));

import { resolveApiBaseUrl, resolveClerkExchanger, resolveMigrationsDir } from '../env.js';

/**
 * RT-893 extraction 1 — the env helpers moved verbatim out of `main/index.ts`.
 * `index.ts` cannot be imported under vitest (it runs `app.whenReady()` at module load), so the
 * moved helpers are pinned here directly.
 */
describe('resolveApiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns VITE_API_BASE_URL when set', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    expect(resolveApiBaseUrl()).toBe('https://api.example.test');
  });

  it('fails closed to the non-routable placeholder when unset', () => {
    vi.stubEnv('VITE_API_BASE_URL', undefined);
    expect(resolveApiBaseUrl()).toBe('https://example.invalid');
  });

  it('treats a blank value as unset', () => {
    vi.stubEnv('VITE_API_BASE_URL', '   ');
    expect(resolveApiBaseUrl()).toBe('https://example.invalid');
  });
});

describe('resolveClerkExchanger', () => {
  it('hands process.env, the raw global fetch and the logger to the provider resolver', async () => {
    const exchanger = { exchange: vi.fn() };
    resolveOperatorExchanger.mockReturnValue(exchanger);
    const logger = { warn: vi.fn() };
    // Stubbed BEFORE the call: the resolver binds the global at call time.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    expect(resolveClerkExchanger(logger)).toBe(exchanger);

    expect(resolveOperatorExchanger).toHaveBeenCalledTimes(1);
    const args = resolveOperatorExchanger.mock.calls[0]?.[0] as {
      env: unknown;
      fetch: (...a: unknown[]) => Promise<unknown>;
      logger: unknown;
    };
    expect(args.env).toBe(process.env);
    expect(args.logger).toBe(logger);
    // The raw global (bound), not a `withRequestId` wrapper: the provider is a third party.
    await args.fetch('https://idp.example.test');
    expect(spy).toHaveBeenCalledWith('https://idp.example.test');
    spy.mockRestore();
  });
});

describe('resolveMigrationsDir', () => {
  it('reads the bundled migrations next to the app path for the shipped app', () => {
    const appPath = path.join('C:', 'POS', 'resources', 'app.asar');
    getAppPath.mockReturnValue(appPath);
    expect(resolveMigrationsDir(true)).toBe(path.join(appPath, 'migrations'));
  });

  it('reads ./migrations from the working directory otherwise', () => {
    expect(resolveMigrationsDir(false)).toBe(path.join(process.cwd(), 'migrations'));
  });
});
