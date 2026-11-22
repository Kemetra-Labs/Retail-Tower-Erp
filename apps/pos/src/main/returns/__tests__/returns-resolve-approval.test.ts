/**
 * RT-1498 S4/S5 (Gap 1, owner decision RT-1498 c18144 item 1) — the approval of resolving an
 * unknown return: ONE kind (`return.resolve_unknown`) with the disposition bound into its payload.
 *   • the subject ref carries the return AND the disposition (`<returnId>_close|_escalate`);
 *   • the subject version binds the disposition, the state and the attempt count, and the amount
 *     is the quoted total, so a row that moved makes the approval stale;
 *   • the resolver names a subject only for a manager or admin of THIS terminal, for a return that
 *     can take that disposition now (close: only when a status read can offer it).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { createReturnDispositionsRepository } from '../returns-dispositions-repository.js';
import {
  RETURN_RESOLVE_ACTION_KIND,
  createReturnResolveApprovalResolver,
  isDisposable,
  parseResolveSubjectRef,
  resolveSubjectOf,
  resolveSubjectRef,
} from '../returns-resolve-approval.js';
import { createReturnsRepository, type JournalEntry } from '../returns-repository.js';
import {
  automaticMismatch,
  closing,
  seedResolveApproval,
} from './__helpers__/dispositions-fixture.js';
import { LINE_A, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

const RETURN_ID = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';

let db: SqlJsDatabase;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
});

afterEach(() => {
  db.close();
});

function journal(returnId = RETURN_ID, attempt = true): JournalEntry {
  const repo = createReturnsRepository(handleFor(db));
  repo.insert({
    returnId,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: '2026-10-04T10:00:01.000Z',
  });
  if (attempt) {
    repo.recordAttempt({ returnId, now: 't1' });
    repo.markUnknown({ returnId, now: 't1' });
  }
  const entry = repo.read(returnId);
  if (entry === null) throw new Error('journal failed');
  return entry;
}

function session(
  role: OperatorSessionRecord['role'],
  over: Partial<OperatorSessionRecord> = {},
): OperatorSessionRecord {
  return {
    id: 'sess-1',
    operator_id: 'op-manager',
    display_name: 'Mona',
    role,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: 't0',
    backend_session_id: 'b1',
    last_activity_at: 't0',
    lock_state: 'active',
    locked_at: null,
    ...over,
  };
}

function resolver(over: { closeAvailable?: boolean; terminal?: string | null } = {}) {
  return createReturnResolveApprovalResolver({
    repo: createReturnsRepository(handleFor(db)),
    dispositions: createReturnDispositionsRepository(handleFor(db)),
    terminalId: () => (over.terminal === undefined ? SCOPE.terminalId : over.terminal),
    closeAvailable: () => over.closeAvailable === true,
  });
}

describe('the subject ref binds the disposition', () => {
  it('is the return id, an underscore and the disposition', () => {
    expect(resolveSubjectRef(RETURN_ID, 'close')).toBe(`${RETURN_ID}_close`);
    expect(resolveSubjectRef(RETURN_ID, 'escalate')).toBe(`${RETURN_ID}_escalate`);
    expect(RETURN_RESOLVE_ACTION_KIND).toBe('return.resolve_unknown');
  });

  it('uses only characters the approval bridge accepts in a subject ref', () => {
    expect(resolveSubjectRef(RETURN_ID, 'escalate')).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it.each(['close', 'escalate'] as const)('round-trips %s', (disposition) => {
    expect(parseResolveSubjectRef(resolveSubjectRef(RETURN_ID, disposition))).toEqual({
      returnId: RETURN_ID,
      disposition,
    });
  });

  it.each([
    '',
    RETURN_ID,
    `${RETURN_ID}_`,
    `${RETURN_ID}_resolve`,
    `${RETURN_ID}_close_escalate`,
    `${RETURN_ID}-close`,
    `x_close`,
    `${RETURN_ID}_CLOSE`,
  ])('rejects the ref %j', (ref) => {
    expect(parseResolveSubjectRef(ref)).toBeNull();
  });
});

describe('the subject binds the disposition, the state, the attempts and the amount', () => {
  it('differs between close and escalate, and moves with the attempt count and the state', () => {
    const entry = journal();
    const escalate = resolveSubjectOf(entry, 'escalate');
    const close = resolveSubjectOf(entry, 'close');
    expect(escalate).toEqual({ version: 'escalate|unknown|1', amountMinor: 3500 });
    expect(close).toEqual({ version: 'close|unknown|1', amountMinor: 3500 });
    expect(resolveSubjectOf({ ...entry, attemptCount: 2 }, 'escalate').version).not.toBe(
      escalate.version,
    );
    expect(resolveSubjectOf({ ...entry, state: 'pending' }, 'escalate').version).not.toBe(
      escalate.version,
    );
  });
});

describe('only a return that can take the disposition is disposable', () => {
  it('is an unknown return, or a pending one that was sent', () => {
    const entry = journal();
    expect(isDisposable(entry)).toBe(true);
    expect(isDisposable({ ...entry, state: 'pending' })).toBe(true);
  });

  it('is not a never-sent pending return, nor a resolved one', () => {
    const entry = journal();
    expect(isDisposable({ ...entry, state: 'pending', attemptCount: 0 })).toBe(false);
    for (const state of ['confirmed', 'paid_out', 'refused'] as const) {
      expect(isDisposable({ ...entry, state })).toBe(false);
    }
  });
});

describe('the resolver of the approval subject', () => {
  const ref = (d: 'close' | 'escalate') => resolveSubjectRef(RETURN_ID, d);

  it('names the escalate subject for a manager or admin on this terminal', () => {
    const entry = journal();
    for (const role of ['manager', 'admin'] as const) {
      expect(resolver()({ subjectRef: ref('escalate'), session: session(role) })).toEqual(
        resolveSubjectOf(entry, 'escalate'),
      );
    }
  });

  it('names no subject for a cashier (a returns domain role only)', () => {
    journal();
    expect(resolver()({ subjectRef: ref('escalate'), session: session('cashier') })).toBeNull();
  });

  it('names no close subject while no status read can offer a close (the server read is off or unknown)', () => {
    journal();
    expect(resolver()({ subjectRef: ref('close'), session: session('manager') })).toBeNull();
  });

  it('names the close subject once a status read can offer it', () => {
    const entry = journal();
    expect(
      resolver({ closeAvailable: true })({ subjectRef: ref('close'), session: session('manager') }),
    ).toEqual(resolveSubjectOf(entry, 'close'));
  });

  it.each([
    ['an unparsable ref', 'nonsense'],
    ['a return that does not exist', `0190f5a2-7b3c-7d4e-8f90-0000000000e9_escalate`],
  ])('names no subject for %s', (_name, subjectRef) => {
    journal();
    expect(resolver()({ subjectRef, session: session('manager') })).toBeNull();
  });

  it.each([
    ['another tenant', { tenant_id: 'tenant-2' }],
    ['another branch', { branch_id: 'branch-2' }],
  ])('names no subject for a session of %s', (_name, over) => {
    journal();
    expect(
      resolver()({ subjectRef: ref('escalate'), session: session('manager', over) }),
    ).toBeNull();
  });

  it('names no subject on another terminal, or while the terminal is unpaired', () => {
    journal();
    for (const terminal of ['term-2', null]) {
      expect(
        resolver({ terminal })({ subjectRef: ref('escalate'), session: session('manager') }),
      ).toBeNull();
    }
  });

  it('names no subject for a never-sent return', () => {
    journal(RETURN_ID, false);
    expect(resolver()({ subjectRef: ref('escalate'), session: session('manager') })).toBeNull();
  });

  it('names the close subject from needs_support (RT-1498 review LOW-1), but never the escalate one', () => {
    const entry = journal();
    createReturnDispositionsRepository(handleFor(db)).insert(
      automaticMismatch({ returnId: RETURN_ID }),
    );
    // Escalating twice is over: any earlier disposition ends it.
    expect(resolver()({ subjectRef: ref('escalate'), session: session('manager') })).toBeNull();
    // needs_support -> close is allowed (spec 3.4), when a status read can offer it.
    expect(
      resolver({ closeAvailable: true })({ subjectRef: ref('close'), session: session('manager') }),
    ).toEqual(resolveSubjectOf(entry, 'close'));
    expect(resolver()({ subjectRef: ref('close'), session: session('manager') })).toBeNull();
  });

  it('names no subject once the return is closed', () => {
    journal();
    seedResolveApproval(db, { returnId: RETURN_ID, disposition: 'close' });
    createReturnDispositionsRepository(handleFor(db)).insert(
      closing({
        returnId: RETURN_ID,
        dispositionId: '0192f5a2-3b4c-7d8e-9f01-0000000000d9',
      }),
    );
    expect(resolver()({ subjectRef: ref('escalate'), session: session('manager') })).toBeNull();
    expect(
      resolver({ closeAvailable: true })({ subjectRef: ref('close'), session: session('manager') }),
    ).toBeNull();
  });
});
