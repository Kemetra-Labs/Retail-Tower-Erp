/**
 * RT-1498 S4 — the dispositions repository (migration 0070) and what every reader of the journal
 * does with a disposition:
 *   • `unresolved_return_exists` (hasUnresolvedForSale) clears ONLY on a close, never on needs_support;
 *   • the resolver's scan (listUnresolved) skips a closed and a needs_support row;
 *   • a closed row is never confirmed or refused by a late answer;
 *   • a needs_support row still confirms (a later matching answer resolves it);
 *   • RT-1553 (migration 0071): a needs_support written AFTER a close is a late commit: closed for
 *     the flow, but it blocks the sale again; one written before the close does not.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
  seedSale,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  createReturnDispositionsRepository,
  isClosedState,
  type NewDisposition,
  type ReturnDispositionsRepository,
} from '../returns-dispositions-repository.js';
import {
  createReturnsRepository,
  type NewJournalEntry,
  type ReturnsRepository,
} from '../returns-repository.js';
import {
  APPROVAL_A,
  APPROVAL_B,
  DISPOSITION_B,
  READ_AT,
  automaticMismatch,
  closing,
  escalation,
  seedResolveApproval,
} from './__helpers__/dispositions-fixture.js';
import { LINE_A, RETURN_REF, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

let db: SqlJsDatabase;
let repo: ReturnsRepository;
let dispositions: ReturnDispositionsRepository;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  seedSale(db, { sale_id: 'sale-1' });
  seedSale(db, { sale_id: 'sale-2' });
  repo = createReturnsRepository(handleFor(db));
  dispositions = createReturnDispositionsRepository(handleFor(db));
});

afterEach(() => {
  db.close();
});

function entry(n: number, over: Partial<NewJournalEntry> = {}): NewJournalEntry {
  return {
    returnId: `r${String(n)}`,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: `pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-${String(n).padStart(12, '0')}`,
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: `2026-10-04T10:00:0${String(n)}.000Z`,
    ...over,
  };
}

/** Journal r<n> and leave it `unknown` (one attempt). */
function unknownReturn(n = 1, over: Partial<NewJournalEntry> = {}): string {
  const returnId = `r${String(n)}`;
  repo.insert(entry(n, over));
  repo.recordAttempt({ returnId, now: 't1' });
  repo.markUnknown({ returnId, now: 't1' });
  return returnId;
}

describe('the dispositions repository', () => {
  it('writes and reads back a disposition', () => {
    unknownReturn();
    seedResolveApproval(db, { disposition: 'escalate' });
    dispositions.insert(escalation());
    expect(dispositions.listFor('r1')).toEqual([escalation()]);
    expect(dispositions.listFor('nope')).toEqual([]);
  });

  it('reports no state, needs_support or closed (closed wins), per return', () => {
    unknownReturn(1);
    unknownReturn(2, { saleId: 'sale-2' });
    expect(dispositions.stateOf('r1')).toBeNull();
    dispositions.insert(automaticMismatch());
    expect(dispositions.stateOf('r1')).toBe('needs_support');
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing({ dispositionId: DISPOSITION_B }));
    expect(dispositions.stateOf('r1')).toBe('closed');
    expect(dispositions.stateOf('r2')).toBeNull();
    expect([...dispositions.statesOf(['r1', 'r2'])]).toEqual([['r1', 'closed']]);
    expect(dispositions.statesOf([]).size).toBe(0);
  });

  it('a retry_hold is not a state yet (its writer is the owed status read)', () => {
    unknownReturn();
    dispositions.insert(
      escalation({
        kind: 'retry_hold',
        verdictSource: 'provenance_read',
        reason: 'not_recorded',
        approvalId: null,
        readVerdictAt: READ_AT,
      }),
    );
    expect(dispositions.stateOf('r1')).toBeNull();
  });

  it('refuses what the table refuses (a disposition for a never-sent return)', () => {
    repo.insert(entry(1));
    expect(() => {
      dispositions.insert(automaticMismatch());
    }).toThrow(/unknown or sent/);
  });
});

/** RT-1553: the one needs_support 0071 allows after a close (a status read saw it recorded). */
function lateCommitRaise(): NewDisposition {
  return escalation({
    dispositionId: '0192f5a2-3b4c-7d8e-9f01-0000000000d3',
    verdictSource: 'provenance_read',
    reason: 'mismatch',
    approvalId: null,
    readVerdictAt: READ_AT,
  });
}

describe('a late commit after a close (RT-1553, migration 0071)', () => {
  beforeEach(() => {
    unknownReturn();
    seedResolveApproval(db, { disposition: 'close' });
  });

  it('a needs_support after the close is the late_commit state, closed for the flow', () => {
    dispositions.insert(closing());
    expect(dispositions.stateOf('r1')).toBe('closed');
    dispositions.insert(lateCommitRaise());
    expect(dispositions.stateOf('r1')).toBe('late_commit');
    expect([...dispositions.statesOf(['r1'])]).toEqual([['r1', 'late_commit']]);
    expect(isClosedState(dispositions.stateOf('r1'))).toBe(true);
  });

  it('a needs_support BEFORE the close leaves it closed (rowid order)', () => {
    dispositions.insert(automaticMismatch());
    dispositions.insert(closing({ dispositionId: DISPOSITION_B }));
    expect(dispositions.stateOf('r1')).toBe('closed');
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(false);
  });

  it('blocks the sale again and leaves the closed list; the resolver still never resends it', () => {
    dispositions.insert(closing());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(false);
    expect(repo.listClosed(SCOPE).map((e) => e.returnId)).toEqual(['r1']);
    dispositions.insert(lateCommitRaise());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(true);
    expect(repo.listClosed(SCOPE)).toEqual([]);
    expect(repo.listUnresolved(SCOPE)).toEqual([]);
    // Still frozen: a late answer can never confirm it, so it can never be paid out.
    expect(
      repo.markConfirmed({
        returnId: 'r1',
        returnRef: RETURN_REF,
        returnTotalMinor: 3500,
        now: 't9',
      }),
    ).toBe(false);
    expect(repo.read('r1')?.state).toBe('unknown');
  });

  it('lists the closed returns of one sale only when asked', () => {
    unknownReturn(2, { saleId: 'sale-2' });
    dispositions.insert(closing());
    seedResolveApproval(db, { disposition: 'close', returnId: 'r2', approvalId: APPROVAL_B });
    dispositions.insert(
      closing({ dispositionId: DISPOSITION_B, returnId: 'r2', approvalId: APPROVAL_B }),
    );
    expect(repo.listClosed(SCOPE).map((e) => e.returnId)).toEqual(['r1', 'r2']);
    expect(repo.listClosed(SCOPE, 'sale-2').map((e) => e.returnId)).toEqual(['r2']);
    expect(repo.listClosed({ ...SCOPE, terminalId: 'term-other' })).toEqual([]);
  });
});

describe('unresolved_return_exists clears only on a close (spec §3.4)', () => {
  it('keeps blocking a sale with a needs_support return', () => {
    unknownReturn();
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(true);
    dispositions.insert(automaticMismatch());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(true);
  });

  it('frees the sale once the return is closed', () => {
    unknownReturn();
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(false);
  });

  it('closing one return frees only that return: another unresolved return still blocks', () => {
    unknownReturn(1);
    unknownReturn(2);
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(true);
  });

  it('a closed return of sale-1 does not touch sale-2', () => {
    unknownReturn(1);
    unknownReturn(2, { saleId: 'sale-2' });
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing());
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(false);
    expect(repo.hasUnresolvedForSale('sale-2')).toBe(true);
  });
});

describe('the resolver scan skips disposed rows', () => {
  it('lists neither a closed nor a needs_support return, but still lists a plain unknown one', () => {
    unknownReturn(1);
    unknownReturn(2, { saleId: 'sale-2' });
    unknownReturn(3, { saleId: 'sale-2' });
    seedResolveApproval(db, { disposition: 'close', returnId: 'r1' });
    dispositions.insert(closing({ returnId: 'r1' }));
    dispositions.insert(automaticMismatch({ dispositionId: DISPOSITION_B, returnId: 'r2' }));
    expect(repo.listUnresolved(SCOPE).map((e) => e.returnId)).toEqual(['r3']);
  });

  it('still lists a needs_support return in the recent journal', () => {
    unknownReturn(1);
    dispositions.insert(automaticMismatch());
    expect(repo.listRecent(SCOPE, 10).map((e) => e.returnId)).toEqual(['r1']);
  });
});

describe('a late answer after a disposition', () => {
  const CONFIRM = { returnId: 'r1', returnRef: RETURN_REF, returnTotalMinor: 3500, now: 't9' };

  it('does not confirm or refuse a closed return (the guard reports false)', () => {
    unknownReturn();
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing());
    expect(repo.markConfirmed(CONFIRM)).toBe(false);
    expect(repo.markRefused({ returnId: 'r1', reason: 'conflict', now: 't9' })).toBe(false);
    expect(repo.read('r1')).toMatchObject({ state: 'unknown', returnRef: null });
  });

  it('does not count another attempt on a closed return', () => {
    unknownReturn();
    seedResolveApproval(db, { disposition: 'close' });
    dispositions.insert(closing());
    repo.recordAttempt({ returnId: 'r1', now: 't9' });
    expect(repo.read('r1')?.attemptCount).toBe(1);
  });

  it('still confirms a needs_support return', () => {
    unknownReturn();
    dispositions.insert(automaticMismatch());
    expect(repo.markConfirmed(CONFIRM)).toBe(true);
    expect(repo.read('r1')?.state).toBe('confirmed');
  });
});

describe('approval single use at the table', () => {
  it('one approval cannot back two dispositions', () => {
    unknownReturn(1);
    unknownReturn(2, { saleId: 'sale-2' });
    seedResolveApproval(db, { disposition: 'escalate', returnId: 'r1' });
    dispositions.insert(escalation());
    seedResolveApproval(db, { disposition: 'escalate', returnId: 'r2', approvalId: APPROVAL_B });
    expect(() => {
      dispositions.insert(
        escalation({ dispositionId: DISPOSITION_B, returnId: 'r2', approvalId: APPROVAL_A }),
      );
    }).toThrow();
  });
});

describe('retry_hold (RT-1498 close slice): a not_recorded read holds the background resends', () => {
  const ATTEMPT = '2026-10-04T10:00:01.000Z';
  const HELD_AT = '2026-10-04T10:00:30.000Z';

  /** An unknown return whose last attempt is `ATTEMPT`, and a hold written at `createdAt`. */
  function heldReturn(createdAt = HELD_AT): void {
    repo.insert(entry(1));
    repo.recordAttempt({ returnId: 'r1', now: ATTEMPT });
    repo.markUnknown({ returnId: 'r1', now: ATTEMPT });
    dispositions.insert(
      escalation({
        kind: 'retry_hold',
        verdictSource: 'provenance_read',
        reason: 'not_recorded',
        approvalId: null,
        readVerdictAt: createdAt,
        createdAt,
      }),
    );
  }

  it('is effective only while it is newer than the last attempt', () => {
    heldReturn();
    expect(dispositions.hasEffectiveHold('r1', ATTEMPT)).toBe(true);
    // A send after the hold voids it; so does a send at the very same instant.
    expect(dispositions.hasEffectiveHold('r1', '2026-10-04T10:01:00.000Z')).toBe(false);
    expect(dispositions.hasEffectiveHold('r1', HELD_AT)).toBe(false);
  });

  it('is effective when the return has no recorded attempt (restrict-only, fail safe)', () => {
    heldReturn();
    expect(dispositions.hasEffectiveHold('r1', null)).toBe(true);
  });

  it('reports no hold for a return without one, or for another return', () => {
    heldReturn();
    expect(dispositions.hasEffectiveHold('r2', ATTEMPT)).toBe(false);
    unknownReturn(2, { saleId: 'sale-2' });
    expect(dispositions.hasEffectiveHold('r2', 't1')).toBe(false);
  });

  it('is still not a state, and does not free the sale', () => {
    heldReturn();
    expect(dispositions.stateOf('r1')).toBeNull();
    expect(repo.hasUnresolvedForSale('sale-1')).toBe(true);
  });

  it('keeps the resolver scan from listing the held row, until a newer attempt voids the hold', () => {
    heldReturn();
    expect(repo.listUnresolved(SCOPE).map((e) => e.returnId)).toEqual([]);
    repo.recordAttempt({ returnId: 'r1', now: '2026-10-04T10:02:00.000Z' });
    expect(repo.listUnresolved(SCOPE).map((e) => e.returnId)).toEqual(['r1']);
  });

  it('a hold on one return does not hold another', () => {
    heldReturn();
    unknownReturn(2, { saleId: 'sale-2' });
    expect(repo.listUnresolved(SCOPE).map((e) => e.returnId)).toEqual(['r2']);
  });
});
