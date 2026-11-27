/**
 * RT-1498 S7 (RT-196 §3.8, OD-196-7) — the counts a shift close warns about: this terminal's returns
 * whose outcome is still not settled (pending or unknown, and not freed by a close), and how many of
 * those wait for support. A close never depends on them: they only feed the warning.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createUnresolvedReturnCounter,
  unresolvedReturnsAtClose,
} from '../returns-unresolved-count.js';
import {
  automaticMismatch,
  closing,
  seedResolveApproval,
} from './__helpers__/dispositions-fixture.js';
import {
  LINE_A,
  SALE_NUMBER,
  SCOPE,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

function count(terminalId: string = SCOPE.terminalId) {
  return createUnresolvedReturnCounter(h.handle).count(terminalId);
}

describe('createUnresolvedReturnCounter', () => {
  it('is zero with no returns', () => {
    harness();
    expect(count()).toEqual({ unresolved: 0, awaitingSupport: 0 });
  });

  it('counts an unknown return as unresolved', async () => {
    harness();
    await unknownReturn();
    expect(count()).toEqual({ unresolved: 1, awaitingSupport: 0 });
  });

  it('counts a return handed to support as unresolved AND awaiting support', async () => {
    harness();
    const returnId = await unknownReturn();
    h.dispositions.insert(automaticMismatch({ returnId }));
    expect(count()).toEqual({ unresolved: 1, awaitingSupport: 1 });
  });

  it('does not count a return closed as not recorded (the close freed its sale)', async () => {
    harness();
    const returnId = await unknownReturn();
    seedResolveApproval(h.db, { returnId, disposition: 'close', amountMinor: 1500 });
    h.dispositions.insert(closing({ returnId }));
    expect(count()).toEqual({ unresolved: 0, awaitingSupport: 0 });
  });

  it('does not count a confirmed return', async () => {
    harness();
    const res = await h.service.submit(ONE_A);
    expect(res.kind).toBe('confirmed');
    expect(count()).toEqual({ unresolved: 0, awaitingSupport: 0 });
  });

  it("counts only this terminal's returns", async () => {
    harness();
    await unknownReturn();
    expect(count('another-terminal')).toEqual({ unresolved: 0, awaitingSupport: 0 });
  });
});

describe('unresolvedReturnsAtClose', () => {
  it('counts for the terminal paired now, and nothing for an unpaired till', async () => {
    harness();
    await unknownReturn();
    let terminal: string | null = SCOPE.terminalId;
    const atClose = unresolvedReturnsAtClose(h.handle, () => terminal);
    expect(atClose()).toEqual({ unresolved: 1, awaitingSupport: 0 });
    terminal = null;
    expect(atClose()).toEqual({ unresolved: 0, awaitingSupport: 0 });
  });
});
