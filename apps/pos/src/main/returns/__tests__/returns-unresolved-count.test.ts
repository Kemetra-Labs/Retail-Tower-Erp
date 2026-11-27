/**
 * RT-1498 S7 (RT-196 §3.8, OD-196-7) — the counts a shift close warns about: this terminal's returns
 * whose outcome is still not settled (pending or unknown, and not freed by a close), and how many of
 * those wait for support. A close never depends on them: they only feed the warning.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { isCentralAuditCategory } from '../../audit/central-audit-categories.js';
import {
  createUnresolvedReturnCounter,
  createUnresolvedReturnsCloseAudit,
  unresolvedReturnsAtClose,
} from '../returns-unresolved-count.js';
import {
  DISPOSITION_B,
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

  it('counts again a closed return that a late commit re-blocked (RT-1553), as awaiting support', async () => {
    harness();
    const returnId = await unknownReturn();
    seedResolveApproval(h.db, { returnId, disposition: 'close', amountMinor: 1500 });
    h.dispositions.insert(closing({ returnId }));
    h.dispositions.insert({
      ...closing({ returnId }),
      dispositionId: DISPOSITION_B,
      kind: 'needs_support',
      verdictSource: 'provenance_read',
      reason: 'mismatch',
      approvalId: null,
      createdAt: '2026-10-04T10:06:00.000Z',
    });
    expect(count()).toEqual({ unresolved: 1, awaitingSupport: 1 });
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

describe('createUnresolvedReturnsCloseAudit (OD-196-7: the counts in the local close audit)', () => {
  const SESSION = {
    id: 'sess-1',
    operator_id: 'op-cashier',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
  };
  const CLOSED = { shiftId: 'shift-9', closedAt: '2026-10-06T16:00:00.000Z' };

  it('emits one POS-local event keyed by the closed shift, with the counts only', () => {
    const emitted: AuditEvent[] = [];
    const record = createUnresolvedReturnsCloseAudit({
      emit: (e) => emitted.push(e),
      session: () => SESSION,
      terminalId: () => SCOPE.terminalId,
      now: () => '2026-10-06T16:00:01.000Z',
      newEventId: () => 'evt-1',
    });
    record(CLOSED, { unresolved: 3, awaitingSupport: 1 });
    expect(emitted).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
        originating_terminal_id: SCOPE.terminalId,
        acting_operator_id: 'op-cashier',
        session_id: 'sess-1',
        shift_id: 'shift-9',
        action_category: 'shift.close.unresolved_returns',
        created_at: '2026-10-06T16:00:01.000Z',
        approving_supervisor_id: null,
        payload: {
          shift_id: 'shift-9',
          closed_at: '2026-10-06T16:00:00.000Z',
          unresolved_returns: 3,
          awaiting_support: 1,
        },
      },
    ]);
    expect(isCentralAuditCategory('shift.close.unresolved_returns')).toBe(false);
  });

  it.each<[string, () => typeof SESSION | null, () => string | null]>([
    ['no session', () => null, () => SCOPE.terminalId],
    ['no pairing', () => SESSION, () => null],
  ])('throws with %s (the bridge logs it; the close stands)', (_n, session, terminalId) => {
    const emit = vi.fn();
    const record = createUnresolvedReturnsCloseAudit({
      emit,
      session,
      terminalId,
      now: () => 'x',
      newEventId: () => 'e',
    });
    expect(() => {
      record(CLOSED, { unresolved: 1, awaitingSupport: 0 });
    }).toThrow();
    expect(emit).not.toHaveBeenCalled();
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
