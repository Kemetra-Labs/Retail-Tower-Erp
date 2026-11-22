/**
 * RT-1498 close slice — the composition root's approval-subject resolver of `return.resolve_unknown`
 * (`returnResolveApprovalResolvers`), over a real journal: the close subject is named only while the
 * server's status read is available (the last probe was answered with a verdict, never a 404; unknown
 * is unavailable), the live paired terminal is read per call, and the escalate subject never depends
 * on the read.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { resolveSubjectOf, resolveSubjectRef } from '../../returns/returns-resolve-approval.js';
import { createReturnsRepository, type JournalEntry } from '../../returns/returns-repository.js';
import { createStatusReadAvailability } from '../../returns/returns-status-availability.js';
import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { LINE_A, SALE_REF, SCOPE } from '../../returns/__tests__/__helpers__/returns-fixture.js';
import { returnResolveApprovalResolvers } from '../returns.js';

const RETURN_ID = '0190f5a2-7b3c-7d4e-8f90-0000000000e2';
const KIND = 'return.resolve_unknown';

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

function unknownReturn(): JournalEntry {
  const repo = createReturnsRepository(handleFor(db));
  repo.insert({
    returnId: RETURN_ID,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000002',
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: '2026-10-04T10:00:01.000Z',
  });
  repo.recordAttempt({ returnId: RETURN_ID, now: '2026-10-04T10:00:02.000Z' });
  repo.markUnknown({ returnId: RETURN_ID, now: '2026-10-04T10:00:02.000Z' });
  const entry = repo.read(RETURN_ID);
  if (entry === null) throw new Error('journal failed');
  return entry;
}

const manager: OperatorSessionRecord = {
  id: 'sess-1',
  operator_id: 'op-manager',
  display_name: 'Mona',
  role: 'manager',
  tenant_id: SCOPE.tenantId,
  branch_id: SCOPE.branchId,
  started_at: 't0',
  backend_session_id: 'b1',
  last_activity_at: 't0',
  lock_state: 'active',
  locked_at: null,
};

describe('returnResolveApprovalResolvers: the close subject follows the status-read availability', () => {
  const pairing = { getCurrentTerminalId: () => SCOPE.terminalId };

  it('names no close subject while the status read is unavailable, and names it once it is', () => {
    const entry = unknownReturn();
    const availability = createStatusReadAvailability();
    const resolve = returnResolveApprovalResolvers(handleFor(db), pairing, availability)[KIND];
    const close = { subjectRef: resolveSubjectRef(RETURN_ID, 'close'), session: manager };

    // Unknown means unavailable: fail closed.
    expect(resolve(close)).toBeNull();
    availability.note({ kind: 'not_recorded' });
    expect(resolve(close)).toEqual(resolveSubjectOf(entry, 'close'));
    // A later 404 closes it again.
    availability.note({ kind: 'unavailable' });
    expect(resolve(close)).toBeNull();
  });

  it('the escalate subject never depends on the status read', () => {
    const entry = unknownReturn();
    const resolve = returnResolveApprovalResolvers(
      handleFor(db),
      pairing,
      createStatusReadAvailability(),
    )[KIND];
    expect(
      resolve({ subjectRef: resolveSubjectRef(RETURN_ID, 'escalate'), session: manager }),
    ).toEqual(resolveSubjectOf(entry, 'escalate'));
  });

  it('reads the live paired terminal on every call: unpaired, or another terminal, names nothing', () => {
    unknownReturn();
    const availability = createStatusReadAvailability();
    availability.note({ kind: 'not_recorded' });
    let terminal: string | null = SCOPE.terminalId;
    const resolve = returnResolveApprovalResolvers(
      handleFor(db),
      { getCurrentTerminalId: () => terminal },
      availability,
    )[KIND];
    const close = { subjectRef: resolveSubjectRef(RETURN_ID, 'close'), session: manager };

    expect(resolve(close)).not.toBeNull();
    terminal = null;
    expect(resolve(close)).toBeNull();
    terminal = 'another-terminal';
    expect(resolve(close)).toBeNull();
  });

  it('defaults to the process-wide availability, which starts unavailable', () => {
    unknownReturn();
    const resolve = returnResolveApprovalResolvers(handleFor(db), pairing)[KIND];
    expect(
      resolve({ subjectRef: resolveSubjectRef(RETURN_ID, 'close'), session: manager }),
    ).toBeNull();
  });
});
