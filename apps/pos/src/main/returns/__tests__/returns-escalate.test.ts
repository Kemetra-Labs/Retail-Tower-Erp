/**
 * RT-1498 S4/S5 — `returns.escalate`: hand ONE unresolved return to support (a `needs_support`
 * disposition), with a single-use RT-114 approval of kind `return.resolve_unknown` bound to this
 * return and to the disposition `escalate` (owner decision RT-1498 c18144 item 1).
 *
 * Over the real approval service and the full migration stack (only the PIN check is stubbed):
 *   • manager or admin only, the live session unlocked, the domain running (the admission gate);
 *   • the approval is spent in the SAME transaction as the disposition and its audit, and a refused
 *     escalation spends nothing and writes nothing;
 *   • it is single use, bound to this return, this disposition, this requester and the row as it
 *     stands (stale once the return was attempted again);
 *   • a never-sent return is sent first (Gap 3); a resolved, closed or already-escalated one is
 *     `already_resolved`;
 *   • it only restricts: the sale stays blocked, no automatic resend, and the explicit resend still
 *     works and can still confirm the return.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { ManagerPinStore } from '../../operator/manager-pin-store.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import type {
  ReturnsEscalateResponse,
  ReturnsSubmitResponse,
} from '../../../shared/returns/types.js';
import { createReturnDispositionsRepository } from '../returns-dispositions-repository.js';
import {
  RETURN_RESOLVE_ACTION_KIND,
  createReturnResolveApprovalResolver,
  resolveSubjectRef,
  type ResolveDisposition,
} from '../returns-resolve-approval.js';
import { createReturnsRepository } from '../returns-repository.js';
import { seedResolveApproval } from './__helpers__/dispositions-fixture.js';
import {
  LINE_A,
  SALE_NUMBER,
  SCOPE,
  categories,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

const MONA = '0190f5a2-3b4c-7d8e-9f01-00000000000a';
const OMAR = '0190f5a2-3b4c-7d8e-9f01-00000000000b';
const MONA_REF = 'ref-mona';
const OMAR_REF = 'ref-omar';
const PIN = '246810';
const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

let h: ReturnsHarness;
let approvals: ManagerApprovalService;
let userId: string | null;

afterEach(() => {
  h.close();
});

/** The PIN store with only the check stubbed: Mona and Omar are enrolled managers sharing a PIN. */
const pins: Pick<ManagerPinStore, 'verify' | 'list'> = {
  verify: (input) => {
    const ref = input.managerRef;
    if (input.pin !== PIN || (ref !== MONA_REF && ref !== OMAR_REF)) {
      return Promise.resolve({ kind: 'invalid' });
    }
    return Promise.resolve({
      kind: 'verified',
      userId: ref === MONA_REF ? MONA : OMAR,
      role: 'manager',
    });
  },
  list: () => [
    { managerRef: MONA_REF, displayName: 'Mona' },
    { managerRef: OMAR_REF, displayName: 'Omar' },
  ],
};

function setup(role: 'manager' | 'admin' | 'cashier' = 'manager'): ReturnsHarness {
  userId = MONA;
  h = returnsHarness({
    role,
    escalation: ({ handle, state }) => {
      const session = (): OperatorSessionRecord => ({
        id: `sess-${state.role ?? 'manager'}`,
        operator_id: `op-${state.role ?? 'manager'}`,
        display_name: 'Display manager',
        role: state.role ?? 'manager',
        tenant_id: SCOPE.tenantId,
        branch_id: SCOPE.branchId,
        started_at: state.now,
        backend_session_id: 'b-1',
        last_activity_at: state.now,
        lock_state: 'active',
        locked_at: null,
        manager_user_id: userId ?? MONA,
      });
      approvals = createManagerApprovalService({
        db: handle,
        getSession: session,
        isSessionLocked: () => state.locked,
        currentTerminalId: () => state.terminalId,
        managerPins: pins,
        resolvers: {
          [RETURN_RESOLVE_ACTION_KIND]: createReturnResolveApprovalResolver({
            repo: createReturnsRepository(handle),
            dispositions: createReturnDispositionsRepository(handle),
            terminalId: () => state.terminalId,
            originUserIdOf: () => null,
          }),
        },
        now: () => state.now,
      });
      return { approvals, userId: () => userId };
    },
  });
  seedSyncedSale(h.db);
  return h;
}

/** A return whose first send was lost: unknown, one attempt. */
async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

async function approve(
  returnId: string,
  disposition: ResolveDisposition = 'escalate',
  over: { reason?: string; approver?: string } = {},
): Promise<string> {
  const granted = await approvals.request({
    action_kind: RETURN_RESOLVE_ACTION_KIND,
    subject_ref: resolveSubjectRef(returnId, disposition),
    reason_code: over.reason ?? `${disposition}_unknown`,
    approver_ref: over.approver ?? OMAR_REF,
    pin: PIN,
  });
  if (granted.kind !== 'approved') throw new Error(`approve: ${granted.reason}`);
  return granted.approvalId;
}

function refusedReason(res: ReturnsEscalateResponse | ReturnsSubmitResponse): string {
  if (res.kind !== 'refused') throw new Error(`expected a refusal, got ${res.kind}`);
  return res.reason;
}

function spent(approvalId: string): boolean {
  const row = h.db.exec(
    `SELECT consumed_at FROM manager_approvals WHERE approval_id = '${approvalId}'`,
  )[0]?.values[0]?.[0];
  return row !== null && row !== undefined;
}

function refusals(): { operation: unknown; reason: unknown }[] {
  return h.audits
    .filter((e) => e.action_category === 'sale.return.refused')
    .map((e) => ({ operation: e.payload['operation'], reason: e.payload['reason'] }));
}

describe('returns.escalate hands one unresolved return to support', () => {
  it('writes a needs_support disposition, spends the approval and audits it', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);

    const res = await h.service.escalate({ returnId, approvalId });

    expect(res).toMatchObject({
      kind: 'escalated',
      ret: { returnId, state: 'unknown', disposition: 'needs_support' },
    });
    expect(h.dispositions.listFor(returnId)).toEqual([
      expect.objectContaining({
        kind: 'needs_support',
        verdictSource: 'operator',
        reason: 'operator',
        approvalId,
        actorOperatorId: 'op-manager',
        readVerdictAt: null,
      }),
    ]);
    expect(spent(approvalId)).toBe(true);
    const audit = h.audits.at(-1);
    expect(audit?.action_category).toBe('sale.return.needs_support');
    expect(audit?.payload).toEqual({
      return_id: returnId,
      approval_id: approvalId,
      verdict_source: 'operator',
      reason: 'operator',
      origin_user_unknown: true,
    });
    expect(audit?.acting_operator_id).toBe('op-manager');
    expect(audit?.approving_supervisor_id).toBe(OMAR);
  });

  it('an admin may escalate too', async () => {
    setup('admin');
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    expect((await h.service.escalate({ returnId, approvalId })).kind).toBe('escalated');
  });

  it('shows the disposition in the list, and the sale stays blocked (OD-196-4)', async () => {
    setup();
    const returnId = await unknownReturn();
    await h.service.escalate({ returnId, approvalId: await approve(returnId) });

    const list = await h.service.list();

    expect(list).toMatchObject({
      kind: 'ok',
      returns: [{ returnId, disposition: 'needs_support' }],
    });
    expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(true);
    expect(await h.service.submit(ONE_A)).toMatchObject({
      kind: 'refused',
      reason: 'unresolved_return_exists',
    });
  });

  it('only restricts: no automatic resend, the explicit resend still works and can confirm it', async () => {
    setup();
    const returnId = await unknownReturn();
    await h.service.escalate({ returnId, approvalId: await approve(returnId) });
    const sent = h.backend.returnCalls().length;

    expect(await h.service.resolve()).toMatchObject({ kind: 'ok', unresolved: 0 });
    expect(h.backend.returnCalls()).toHaveLength(sent);

    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    expect((await h.service.resend({ returnId })).kind).toBe('confirmed');
    expect(h.repo.read(returnId)?.state).toBe('confirmed');
  });

  it('a list row of a return that was never handed to support has no disposition', async () => {
    setup();
    const returnId = await unknownReturn();
    const list = await h.service.list();
    expect(list).toMatchObject({ kind: 'ok', returns: [{ returnId, disposition: null }] });
  });
});

describe('only a close frees the sale (spec §3.4, OD-196-4)', () => {
  it('a needs_support return blocks a new return; once it is closed the sale takes one again', async () => {
    setup();
    const returnId = await unknownReturn();
    await h.service.escalate({ returnId, approvalId: await approve(returnId) });
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    expect(await h.service.submit(ONE_A)).toMatchObject({
      kind: 'refused',
      reason: 'unresolved_return_exists',
    });

    // The close is written by the owed status read; the table and every reader already honour it.
    const closeApproval = '0190f5a2-7b3c-7d4e-8f90-0000000000b1';
    seedResolveApproval(h.db, {
      returnId,
      disposition: 'close',
      approvalId: closeApproval,
      amountMinor: 1500,
    });
    h.dispositions.insert({
      dispositionId: '0192f5a2-3b4c-7d8e-9f01-0000000000d9',
      returnId,
      kind: 'not_recorded_closed',
      verdictSource: 'provenance_read',
      reason: 'not_recorded',
      readVerdictAt: h.state.now,
      approvalId: closeApproval,
      actorOperatorId: 'op-manager',
      createdAt: h.state.now,
    });

    expect(await h.service.list()).toMatchObject({
      kind: 'ok',
      returns: [{ returnId, disposition: 'closed' }],
    });
    expect((await h.service.submit(ONE_A)).kind).toBe('confirmed');
  });
});

describe('who may escalate (the admission gate)', () => {
  it('refuses a cashier (role_denied) and spends nothing', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    h.state.role = 'cashier';
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe('role_denied');
    expect(spent(approvalId)).toBe(false);
  });

  it.each<[string, () => void]>([
    [
      'feature_disabled',
      () => {
        h.state.enabled = false;
      },
    ],
    [
      'no_session',
      () => {
        h.state.role = null;
      },
    ],
    [
      'session_changed',
      () => {
        h.state.locked = true;
      },
    ],
  ])('answers %s and writes nothing', async (reason, change) => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    change();
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(reason);
    expect(h.dispositions.listFor(returnId)).toEqual([]);
    expect(spent(approvalId)).toBe(false);
  });

  it('answers shutting_down once the domain is stopped, with no audit', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    h.stop();
    const before = h.audits.length;
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe('shutting_down');
    expect(h.audits).toHaveLength(before);
  });

  it('refuses when no escalation is composed (fail closed)', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    const returnId = await unknownReturn();
    expect(
      refusedReason(
        await h.service.escalate({ returnId, approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a1' }),
      ),
    ).toBe('approval_invalid');
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });
});

describe('which returns can be escalated', () => {
  it('refuses invalid ids', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    expect(refusedReason(await h.service.escalate({ returnId: 'x', approvalId }))).toBe(
      'invalid_input',
    );
    expect(refusedReason(await h.service.escalate({ returnId, approvalId: 'x' }))).toBe(
      'invalid_input',
    );
  });

  it('refuses a return that does not exist, or that belongs to another terminal', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    h.state.terminalId = 'other-till';
    const foreign = await h.service.escalate({ returnId, approvalId });
    expect(refusedReason(foreign)).toBe('return_not_found');
    // Another terminal's row is never shown, not even in the refusal.
    expect(foreign).toMatchObject({ ret: null });
    h.state.terminalId = SCOPE.terminalId;
    expect(
      refusedReason(
        await h.service.escalate({ returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e9', approvalId }),
      ),
    ).toBe('return_not_found');
    expect(spent(approvalId)).toBe(false);
  });

  it('refuses a return that was never sent: send it first (Gap 3)', async () => {
    setup();
    h.repo.insert({
      returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e1',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: SALE_NUMBER,
      serverSaleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
      externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
      operatorId: 'op-manager',
      operatorSessionId: 'sess-manager',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: '{}',
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: h.state.now,
    });
    const returnId = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
    const res = await h.service.escalate({
      returnId,
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a1',
    });
    expect(refusedReason(res)).toBe('never_sent');
    expect(refusals()).toEqual([{ operation: 'escalate', reason: 'never_sent' }]);
  });

  it('refuses a confirmed return as already_resolved', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    await h.service.resend({ returnId });
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
      'already_resolved',
    );
    expect(spent(approvalId)).toBe(false);
  });

  it('refuses a return that is already needs_support, or closed, as already_resolved', async () => {
    setup();
    const returnId = await unknownReturn();
    const first = await approve(returnId);
    await h.service.escalate({ returnId, approvalId: first });
    const second = '0190f5a2-7b3c-7d4e-8f90-0000000000a9';
    expect(refusedReason(await h.service.escalate({ returnId, approvalId: second }))).toBe(
      'already_resolved',
    );
    // A close (written by the owed status read) also ends it.
    seedResolveApproval(h.db, {
      returnId,
      disposition: 'close',
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000b1',
      amountMinor: 1500,
    });
    h.dispositions.insert({
      dispositionId: '0192f5a2-3b4c-7d8e-9f01-0000000000d9',
      returnId,
      kind: 'not_recorded_closed',
      verdictSource: 'provenance_read',
      reason: 'not_recorded',
      readVerdictAt: h.state.now,
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000b1',
      actorOperatorId: 'op-manager',
      createdAt: h.state.now,
    });
    expect(refusedReason(await h.service.escalate({ returnId, approvalId: second }))).toBe(
      'already_resolved',
    );
    // And it is never resent, by the explicit resend either.
    expect(refusedReason(await h.service.resend({ returnId }))).toBe('already_resolved');
  });
});

describe('the approval must be the right one (Gap 1)', () => {
  it('refuses an approval that does not exist', async () => {
    setup();
    const returnId = await unknownReturn();
    const res = await h.service.escalate({
      returnId,
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a1',
    });
    expect(refusedReason(res)).toBe('approval_invalid');
    expect(refusals()).toEqual([{ operation: 'escalate', reason: 'approval_invalid' }]);
  });

  it('refuses an approval granted for ANOTHER return, and spends neither', async () => {
    setup();
    const first = await unknownReturn();
    // A second sale and return.
    seedSyncedSale(h.db, { saleId: 'sale-2', saleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f7' });
    const approvalId = await approve(first);
    h.repo.insert({
      returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e2',
      scope: SCOPE,
      saleId: 'sale-2',
      saleNumber: 'SN-sale-2',
      serverSaleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f7',
      externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000002',
      operatorId: 'op-manager',
      operatorSessionId: 'sess-manager',
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: '{}',
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: h.state.now,
    });
    h.repo.recordAttempt({ returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e2', now: h.state.now });
    h.repo.markUnknown({ returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e2', now: h.state.now });

    const res = await h.service.escalate({
      returnId: '0190f5a2-7b3c-7d4e-8f90-0000000000e2',
      approvalId,
    });

    expect(refusedReason(res)).toBe('approval_invalid');
    expect(spent(approvalId)).toBe(false);
    expect(h.dispositions.listFor(first)).toEqual([]);
  });

  it('refuses a spent approval (single use)', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    expect((await h.service.escalate({ returnId, approvalId })).kind).toBe('escalated');
    // The return now has its disposition; a second return with the spent approval is refused.
    const spentRes = await h.service.escalate({ returnId, approvalId });
    expect(refusedReason(spentRes)).toBe('already_resolved');
    expect(h.dispositions.listFor(returnId)).toHaveLength(1);
  });

  it('refuses an approval whose reason is not the escalate reason', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId, 'escalate', { reason: 'close_unknown' });
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
      'approval_invalid',
    );
    expect(spent(approvalId)).toBe(false);
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });

  it('refuses an approval granted to a different requester than the live operator', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    userId = OMAR;
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
      'approval_invalid',
    );
    expect(spent(approvalId)).toBe(false);
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });

  it('refuses when the live operator has no users.id', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    userId = null;
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
      'approval_invalid',
    );
    expect(spent(approvalId)).toBe(false);
  });

  it('is stale once the return was attempted again after the approval', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    await h.service.resend({ returnId });
    expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
      'approval_stale',
    );
    expect(spent(approvalId)).toBe(false);
  });
});

describe('the evidence must prove four-eyes (a defence behind the approval service)', () => {
  it('refuses an approval whose approver is the requester, and writes nothing', async () => {
    userId = MONA;
    h = returnsHarness({
      escalation: () => ({
        approvals: {
          consume: () => ({
            kind: 'consumed',
            approverUserId: MONA,
            reasonCode: 'escalate_unknown',
          }),
          evidence: () => ({
            approverUserId: MONA,
            requesterUserId: MONA,
            policyVersion: 'rt114-2026-10-07',
            issuedAt: 't',
          }),
        },
        userId: () => userId,
      }),
    });
    seedSyncedSale(h.db);
    const returnId = await unknownReturn();

    const res = await h.service.escalate({
      returnId,
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a1',
    });

    expect(refusedReason(res)).toBe('approval_invalid');
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });

  it('refuses an approval that left no evidence', async () => {
    userId = MONA;
    h = returnsHarness({
      escalation: () => ({
        approvals: {
          consume: () => ({
            kind: 'consumed',
            approverUserId: OMAR,
            reasonCode: 'escalate_unknown',
          }),
          evidence: () => null,
        },
        userId: () => userId,
      }),
    });
    seedSyncedSale(h.db);
    const returnId = await unknownReturn();
    const res = await h.service.escalate({
      returnId,
      approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000a1',
    });
    expect(refusedReason(res)).toBe('approval_invalid');
  });
});

describe('the commit is one unit', () => {
  it('a failed audit writes no disposition and spends no approval', async () => {
    setup();
    const returnId = await unknownReturn();
    const approvalId = await approve(returnId);
    h.state.failAudit = (event) => event.action_category === 'sale.return.needs_support';

    await expect(h.service.escalate({ returnId, approvalId })).rejects.toThrow(
      'audit insert failed',
    );

    expect(h.dispositions.listFor(returnId)).toEqual([]);
    expect(spent(approvalId)).toBe(false);
    expect(categories(h.audits)).not.toContain('sale.return.needs_support');
  });
});

describe('RT-1498 return_journal_origin atomic capture and four-eyes exclusion', () => {
  const SARA = '0190f5a2-3b4c-7d8e-9f01-00000000000c';
  const SARA_REF = 'ref-sara';

  it('captures originator on journal, refuses originator PIN, and omits origin_user_unknown when resolved by a third manager', async () => {
    const { createReturnOriginRepository } = await import('../returns-origin-repository.js');
    userId = SARA;
    let originResolver: ReturnType<typeof createReturnResolveApprovalResolver> | null = null;
    const withOriginPins: Pick<ManagerPinStore, 'verify' | 'list'> = {
      verify: (input) => {
        if (input.pin !== PIN) return Promise.resolve({ kind: 'invalid' });
        if (input.managerRef === SARA_REF)
          return Promise.resolve({ kind: 'verified', userId: SARA, role: 'manager' });
        if (input.managerRef === MONA_REF)
          return Promise.resolve({ kind: 'verified', userId: MONA, role: 'manager' });
        if (input.managerRef === OMAR_REF)
          return Promise.resolve({ kind: 'verified', userId: OMAR, role: 'manager' });
        return Promise.resolve({ kind: 'invalid' });
      },
      list: (input) => pins.list(input),
    };

    h = returnsHarness({
      role: 'manager',
      actorUserId: () => userId,
      escalation: ({ handle, state }) => {
        const repo = createReturnsRepository(handle);
        const origins = createReturnOriginRepository(handle);
        originResolver = createReturnResolveApprovalResolver({
          repo,
          dispositions: createReturnDispositionsRepository(handle),
          terminalId: () => state.terminalId,
          originUserIdOf: (id) => origins.originUserIdOf(id),
        });
        approvals = createManagerApprovalService({
          db: handle,
          getSession: () => ({
            id: `sess-${state.role ?? 'manager'}`,
            operator_id: `op-${state.role ?? 'manager'}`,
            display_name: 'Manager',
            role: state.role ?? 'manager',
            tenant_id: SCOPE.tenantId,
            branch_id: SCOPE.branchId,
            started_at: state.now,
            backend_session_id: 'b-1',
            last_activity_at: state.now,
            lock_state: 'active',
            locked_at: null,
            manager_user_id: userId ?? SARA,
          }),
          isSessionLocked: () => state.locked,
          currentTerminalId: () => state.terminalId,
          managerPins: withOriginPins,
          resolvers: { [RETURN_RESOLVE_ACTION_KIND]: originResolver },
          now: () => state.now,
        });
        return { approvals, userId: () => userId };
      },
    });
    seedSyncedSale(h.db);

    const returnId = await unknownReturn();
    const origins = createReturnOriginRepository(h.handle);
    expect(origins.originUserIdOf(returnId)).toBe(SARA);

    // Switch active session to Mona and try using Sara's PIN → refused (originator four-eyes).
    userId = MONA;
    const denied = await approvals.request({
      action_kind: RETURN_RESOLVE_ACTION_KIND,
      subject_ref: resolveSubjectRef(returnId, 'escalate'),
      reason_code: 'escalate_unknown',
      approver_ref: SARA_REF,
      pin: PIN,
    });
    expect(denied).toEqual({ kind: 'refused', reason: 'approval_unavailable' });

    // Third manager Omar approves and Mona commits escalate → audit omits origin_user_unknown.
    const approvalId = await approve(returnId, 'escalate', { approver: OMAR_REF });
    const res = await h.service.escalate({ returnId, approvalId });
    expect(res.kind).toBe('escalated');
    const event = h.audits.find((a) => a.action_category === 'sale.return.needs_support');
    expect(event?.payload).toEqual({
      return_id: returnId,
      approval_id: approvalId,
      verdict_source: 'operator',
      reason: 'operator',
    });
  });
});
