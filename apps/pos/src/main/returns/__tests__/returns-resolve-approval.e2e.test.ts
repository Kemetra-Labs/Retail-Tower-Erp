/**
 * RT-1498 S4/S5 (Gap 1) — the `return.resolve_unknown` approval end to end over the full migration
 * stack (sql.js): the real manager PIN store (real Argon2id) and the real approval service.
 *
 *   • four-eyes: a manager asks, ANOTHER manager approves; a self-approval and a cashier are refused;
 *   • ONE kind, the disposition bound: an approval granted for `escalate` is `approval_invalid`
 *     for `close`, and the reverse, and a refused spend leaves the approval unspent;
 *   • single use, and stale once the row moved;
 *   • a return that cannot take the disposition (closed, resolved, never sent) is not approvable.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createReturnDispositionsRepository } from '../returns-dispositions-repository.js';
import {
  RETURN_RESOLVE_ACTION_KIND,
  createReturnResolveApprovalResolver,
  resolveSubjectOf,
  resolveSubjectRef,
  type ResolveDisposition,
} from '../returns-resolve-approval.js';
import { createReturnsRepository, type JournalEntry } from '../returns-repository.js';
import { createReturnOriginRepository } from '../returns-origin-repository.js';
import { LINE_A, SALE_REF, SCOPE } from './__helpers__/returns-fixture.js';

const TERMINAL = SCOPE.terminalId;
const RETURN_ID = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const MONA = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const OMAR = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b', pin: '135790' };
const CASHIER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000cc';
const T0 = '2026-10-04T10:00:00.000Z';

function managerSession(): OperatorSessionRecord {
  return {
    id: 'sess-mona',
    operator_id: 'op-mona',
    display_name: 'Mona',
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: 'b-mona',
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    manager_user_id: MONA.userId,
  };
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let current: OperatorSessionRecord;
let closeAvailable: boolean;

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  current = managerSession();
  closeAvailable = true;
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  for (const m of [MONA, OMAR]) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: m.userId,
      sealed: await pins.seal(m.pin),
      now: T0,
      onlineAt: T0,
      guard: () => undefined,
    });
  }
  const origins = createReturnOriginRepository(db);
  approvals = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      [RETURN_RESOLVE_ACTION_KIND]: createReturnResolveApprovalResolver({
        repo: createReturnsRepository(db),
        dispositions: createReturnDispositionsRepository(db),
        terminalId: () => TERMINAL,
        closeAvailable: () => closeAvailable,
        originUserIdOf: (id) => origins.originUserIdOf(id),
      }),
    },
    now: () => T0,
  });
  seedSale(raw, { sale_id: 'sale-1' });
});

afterEach(() => {
  raw.close();
});

function journalUnknown(attempts = 1): JournalEntry {
  const repo = createReturnsRepository(handleFor(raw));
  repo.insert({
    returnId: RETURN_ID,
    scope: SCOPE,
    saleId: 'sale-1',
    saleNumber: 'SN-sale-1',
    serverSaleRef: SALE_REF,
    externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
    operatorId: 'op-mona',
    operatorSessionId: 'sess-mona',
    currencyCode: 'EGP',
    quotedTotalMinor: 3500,
    requestBodyJson: '{"k":1}',
    lines: [{ lineRef: LINE_A, quantity: 1 }],
    now: T0,
  });
  // No attempt: the return stays `pending` and never sent.
  for (let i = 0; i < attempts; i += 1) repo.recordAttempt({ returnId: RETURN_ID, now: T0 });
  if (attempts > 0) repo.markUnknown({ returnId: RETURN_ID, now: T0 });
  return read();
}

function read(): JournalEntry {
  const entry = createReturnsRepository(handleFor(raw)).read(RETURN_ID);
  if (entry === null) throw new Error('no journal row');
  return entry;
}

function managerRef(userId: string): string {
  const all = pins.list({ scope: SCOPE, now: T0 });
  const found = all.find((m) => m.displayName === userId);
  if (found === undefined) throw new Error('manager not enrolled');
  return found.managerRef;
}

function ask(disposition: ResolveDisposition, approver = OMAR) {
  return approvals.request({
    action_kind: RETURN_RESOLVE_ACTION_KIND,
    subject_ref: resolveSubjectRef(RETURN_ID, disposition),
    reason_code: `${disposition}_unknown`,
    approver_ref: managerRef(approver.userId),
    pin: approver.pin,
  });
}

function spend(approvalId: string, spendFor: ResolveDisposition, entry = read()) {
  return approvals.consume({
    approvalId,
    actionKind: RETURN_RESOLVE_ACTION_KIND,
    subjectRef: resolveSubjectRef(RETURN_ID, spendFor),
    subject: resolveSubjectOf(entry, spendFor),
    session: {
      operator_id: current.operator_id,
      tenant_id: current.tenant_id,
      branch_id: current.branch_id,
      ...(current.manager_user_id === undefined
        ? {}
        : { manager_user_id: current.manager_user_id }),
    },
  });
}

function approvedId(result: Awaited<ReturnType<typeof ask>>): string {
  if (result.kind !== 'approved') throw new Error(`not approved: ${result.reason}`);
  return result.approvalId;
}

describe('four-eyes and who may ask', () => {
  it('grants another manager’s approval to a manager session', async () => {
    journalUnknown();
    expect((await ask('escalate')).kind).toBe('approved');
  });

  it('refuses the requester as their own approver (one generic refusal)', async () => {
    journalUnknown();
    expect(await ask('escalate', MONA)).toEqual({
      kind: 'refused',
      reason: 'approval_unavailable',
    });
  });

  it('refuses a cashier session (not applicable: the returns domain is manager/admin only)', async () => {
    journalUnknown();
    current = { ...managerSession(), role: 'cashier', user_id: CASHIER_USER };
    expect(await ask('escalate')).toEqual({ kind: 'refused', reason: 'not_applicable' });
  });
});

describe('one kind, the disposition bound (Gap 1)', () => {
  it('an escalate approval spends for escalate', async () => {
    journalUnknown();
    const id = approvedId(await ask('escalate'));
    expect(spend(id, 'escalate').kind).toBe('consumed');
  });

  it('a close approval spends for close', async () => {
    journalUnknown();
    const id = approvedId(await ask('close'));
    expect(spend(id, 'close').kind).toBe('consumed');
  });

  it('an escalate approval is refused for a close, and stays unspent for escalate', async () => {
    journalUnknown();
    const id = approvedId(await ask('escalate'));
    expect(spend(id, 'close')).toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(spend(id, 'escalate').kind).toBe('consumed');
  });

  it('a close approval is refused for an escalate, and stays unspent for close', async () => {
    journalUnknown();
    const id = approvedId(await ask('close'));
    expect(spend(id, 'escalate')).toEqual({ kind: 'refused', reason: 'approval_invalid' });
    expect(spend(id, 'close').kind).toBe('consumed');
  });

  it('records the disposition in the approval row itself (subject ref and reason)', async () => {
    journalUnknown();
    const id = approvedId(await ask('escalate'));
    const row = raw.exec(
      `SELECT subject_ref, action_kind, reason_code, amount_minor, subject_version
         FROM manager_approvals WHERE approval_id = '${id}'`,
    )[0]?.values[0];
    expect(row).toEqual([
      `${RETURN_ID}_escalate`,
      'return.resolve_unknown',
      'escalate_unknown',
      3500,
      'escalate|unknown|1',
    ]);
  });
});

describe('single use and staleness', () => {
  it('cannot be spent twice', async () => {
    journalUnknown();
    const id = approvedId(await ask('escalate'));
    expect(spend(id, 'escalate').kind).toBe('consumed');
    expect(spend(id, 'escalate')).toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('is stale once the return was attempted again after the approval', async () => {
    journalUnknown();
    const id = approvedId(await ask('escalate'));
    const repo = createReturnsRepository(handleFor(raw));
    repo.recordAttempt({ returnId: RETURN_ID, now: T0 });
    expect(spend(id, 'escalate')).toEqual({ kind: 'refused', reason: 'approval_stale' });
  });
});

describe('a return that cannot take the disposition is not approvable', () => {
  it('refuses an approval request for a never-sent return', async () => {
    journalUnknown(0);
    expect(await ask('escalate')).toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });

  it('refuses a close request while no status read can offer one', async () => {
    journalUnknown();
    closeAvailable = false;
    expect(await ask('close')).toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });
});

describe('RT-1498 originator four-eyes on manager -> manager returns', () => {
  const SARA = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000c', pin: '112233' };

  it('refuses the originator PIN via approval_unavailable and allows a third manager', async () => {
    const { createReturnOriginRepository } = await import('../returns-origin-repository.js');
    const { spendResolveApproval } = await import('../returns-resolve-approval.js');

    await pins.enrol({
      scope: SCOPE,
      userId: SARA.userId,
      displayName: SARA.userId,
      sealed: await pins.seal(SARA.pin),
      now: T0,
      onlineAt: T0,
      guard: () => undefined,
    });

    journalUnknown();
    const db = handleFor(raw);
    const repo = createReturnsRepository(db);
    const origins = createReturnOriginRepository(db);
    // Omar originated this return; Mona now requests resolution.
    origins.recordOrigin(RETURN_ID, OMAR.userId, T0);

    const scopedApprovals = createManagerApprovalService({
      db,
      getSession: () => current,
      isSessionLocked: () => false,
      currentTerminalId: () => TERMINAL,
      managerPins: pins,
      resolvers: {
        [RETURN_RESOLVE_ACTION_KIND]: createReturnResolveApprovalResolver({
          repo,
          dispositions: createReturnDispositionsRepository(db),
          terminalId: () => TERMINAL,
          closeAvailable: () => closeAvailable,
          originUserIdOf: (id) => origins.originUserIdOf(id),
        }),
      },
      now: () => T0,
    });

    // Using originator Omar's PIN is refused with approval_unavailable.
    const denied = await scopedApprovals.request({
      action_kind: RETURN_RESOLVE_ACTION_KIND,
      subject_ref: resolveSubjectRef(RETURN_ID, 'escalate'),
      reason_code: 'escalate_unknown',
      approver_ref: managerRef(OMAR.userId),
      pin: OMAR.pin,
    });
    expect(denied).toEqual({ kind: 'refused', reason: 'approval_unavailable' });

    // Third manager Sara succeeds.
    const granted = await scopedApprovals.request({
      action_kind: RETURN_RESOLVE_ACTION_KIND,
      subject_ref: resolveSubjectRef(RETURN_ID, 'escalate'),
      reason_code: 'escalate_unknown',
      approver_ref: managerRef(SARA.userId),
      pin: SARA.pin,
    });
    expect(granted.kind).toBe('approved');
    if (granted.kind !== 'approved') throw new Error('expected approval');

    // Defense in depth at spend time: passing Sara as the originator refuses the spend as approval_invalid.
    const entry = repo.read(RETURN_ID);
    if (entry === null) throw new Error('expected journal entry');
    const spentBadOrigin = spendResolveApproval(
      { approvals: scopedApprovals, userId: () => MONA.userId },
      { operatorId: current.operator_id, scope: entry.scope },
      granted.approvalId,
      entry,
      'escalate',
      SARA.userId,
    );
    expect(spentBadOrigin).toEqual({ kind: 'refused', reason: 'approval_invalid' });
  });
});
