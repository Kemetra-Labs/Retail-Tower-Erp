/**
 * RT-388 — the shift variance policy wiring: when the till reads the policy
 * (the paired worker's start, each new operator session, before an online open),
 * that it never blocks or fails a caller, and that a stopped worker reads no more.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PairedTerminal } from '../../app/paired-workers.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { PairingStatus } from '../../../shared/pairing-types.js';
import { registerVariancePolicy, type VariancePolicyWiring } from '../variance-policy.js';

const REVISION = '0190f5a2-3b4c-7d8e-9f01-23456789abcd';
const NOW = '2026-11-21T10:00:00.000Z';
const BODY = {
  policySource: 'tenant',
  policyRevisionId: REVISION,
  policyValue: { mode: 'limit', limitAmount: '100.00', currencyCode: 'EGP' },
  serverTime: NOW,
};
const TERMINAL: PairedTerminal = {
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
};
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: 'terminal-1' };

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

interface Rig {
  wiring: VariancePolicyWiring;
  fetched: string[];
  /** Starts the paired worker the latch holds. */
  startPaired: () => void;
  startSession: () => void;
  stops: Array<() => void>;
  state: {
    status: PairingStatus;
    token: string | null;
    /** Answers the fetch; a never-settling promise models a hung network. */
    answer: () => Promise<Response>;
  };
}

function rig(options: { beforeOpenWaitMs?: number } = {}): Rig {
  const fetched: string[] = [];
  const stops: Array<() => void> = [];
  const starters: Array<(terminal: PairedTerminal) => void> = [];
  const listeners: Array<() => void> = [];
  const state: Rig['state'] = {
    status: {
      kind: 'paired',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      terminal_id: 'terminal-1',
    } as PairingStatus,
    token: 'device-token',
    answer: () =>
      Promise.resolve(
        new Response(JSON.stringify(BODY), { status: 200, headers: { ETag: '"e1"' } }),
      ),
  };
  const wiring = registerVariancePolicy({
    db: handleFor(db),
    pairingStore: { getStatus: () => Promise.resolve(state.status) },
    pairedWorkersLatch: {
      register: (_name, starter) => {
        starters.push(starter);
      },
    },
    workerRegistry: {
      register: (_name, stop) => {
        stops.push(stop);
      },
    },
    operatorSessionManager: {
      onStarted: (listener) => {
        listeners.push(() => {
          listener({} as never);
        });
      },
    },
    mainLogger: { info: vi.fn(), warn: vi.fn() },
    backendFetch: (input) => {
      fetched.push(input instanceof Request ? input.url : input.toString());
      return state.answer();
    },
    readSendableDeviceToken: () => Promise.resolve(state.token),
    apiBaseUrl: 'https://api.test',
    now: () => NOW,
    ...options,
  });
  return {
    wiring,
    fetched,
    stops,
    state,
    startPaired: () => {
      for (const start of starters) start(TERMINAL);
    },
    startSession: () => {
      for (const fire of listeners) fire();
    },
  };
}

/** Lets the fire-and-forget refresh settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const POLICY_URL = 'https://api.test/api/pos/v1/store/cash-variance-policy';

describe('registerVariancePolicy', () => {
  it('reads nothing until the terminal is paired and a trigger fires', async () => {
    const r = rig();
    await settle();
    expect(r.fetched).toEqual([]);
  });

  it('reads the policy when the paired worker starts and resolves it afterwards', async () => {
    const r = rig();
    r.startPaired();
    await settle();
    expect(r.fetched).toEqual([POLICY_URL]);
    expect(r.wiring.resolvePolicy({ scope: SCOPE, shiftCurrencyCode: 'EGP' })).toMatchObject({
      source: 'tenant',
      revisionId: REVISION,
      mode: 'limit',
      limitAmount: '100.00',
    });
  });

  it('resolves the fail-closed fallback before any read succeeded', () => {
    const r = rig();
    expect(r.wiring.resolvePolicy({ scope: SCOPE, shiftCurrencyCode: 'EGP' }).source).toBe(
      'fallback',
    );
  });

  it('reads again at each new operator session (the first online sign-in after the upgrade)', async () => {
    const r = rig();
    r.startPaired();
    await settle();
    r.startSession();
    await settle();
    expect(r.fetched).toHaveLength(2);
  });

  it('reads nothing while unpaired', async () => {
    const r = rig();
    r.state.status = { kind: 'unpaired' };
    r.startSession();
    await settle();
    expect(r.fetched).toEqual([]);
  });

  it('refreshBeforeOpen waits for the read and then resolves the fresh policy', async () => {
    const r = rig();
    await r.wiring.refreshBeforeOpen();
    expect(r.fetched).toEqual([POLICY_URL]);
    expect(r.wiring.resolvePolicy({ scope: SCOPE, shiftCurrencyCode: 'EGP' }).source).toBe(
      'tenant',
    );
  });

  it('refreshBeforeOpen gives up after its bound when the network hangs, and never rejects', async () => {
    const r = rig({ beforeOpenWaitMs: 20 });
    r.state.answer = () => new Promise<Response>(() => undefined);
    await expect(r.wiring.refreshBeforeOpen()).resolves.toBeUndefined();
  });

  it('refreshBeforeOpen never rejects on a network fault', async () => {
    const r = rig();
    r.state.answer = () => Promise.reject(new TypeError('fetch failed'));
    await expect(r.wiring.refreshBeforeOpen()).resolves.toBeUndefined();
    expect(r.wiring.resolvePolicy({ scope: SCOPE, shiftCurrencyCode: 'EGP' }).source).toBe(
      'fallback',
    );
  });

  it('registers a stop with the worker registry: no read after it', async () => {
    const r = rig();
    r.startPaired();
    await settle();
    expect(r.stops).toHaveLength(1);
    r.stops[0]?.();
    r.startSession();
    await r.wiring.refreshBeforeOpen();
    await settle();
    expect(r.fetched).toHaveLength(1);
  });
});
