/**
 * RT-1498 close slice — `returns.readStatus` and `returns.close` over the real approval service, the
 * full migration stack (0070 included) and a fake Backend-Core status route.
 *
 * The rules under test (RT-196 §3.2-3.9, the RT-1548 contract):
 *   • a VERDICT is only an affirmative server answer; a 404 is "unavailable", a 5xx / network /
 *     401 / unreadable answer is "no verdict"; nothing is ever inferred locally;
 *   • `not_recorded` writes a restrict-only `retry_hold` (so the quiet period can run out);
 *   • `recorded` that does not match this return, or is a credit reversal, hands the return to support
 *     (Gap 2: no approval); a match writes nothing (the explicit resend confirms it);
 *   • a CLOSE needs: manager/admin, one approval bound to this return AND to `close`, 15 minutes of
 *     ELAPSED time since the last send (a restart or a stepped clock counts as not elapsed), a FRESH
 *     `not_recorded` at close time, and a return that was sent and is not in flight; the approval, the
 *     disposition and the audit commit in ONE transaction;
 *   • a close is allowed from `needs_support`; a `recorded` answer never closes;
 *   • a return seen as recorded AFTER a close is a late commit: audited, surfaced, never paid, and
 *     (RT-1553, migration 0071) handed to support once, which blocks the sale again;
 *   • RT-1553: the late commit is detected automatically: one background read a quiet period after the
 *     close, and a read when a new return or a void of the same sale is quoted.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { ManagerPinStore } from '../../operator/manager-pin-store.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { createReturnDispositionsRepository } from '../returns-dispositions-repository.js';
import {
  RETURN_RESOLVE_ACTION_KIND,
  createReturnResolveApprovalResolver,
  resolveSubjectRef,
  type ResolveDisposition,
} from '../returns-resolve-approval.js';
import { RETURN_QUIET_PERIOD_MS } from '../returns-quiet-period.js';
import { LIVE_RETURN_SQL } from '../../sale-void/compose-sale-void.js';
import { createReturnsRepository } from '../returns-repository.js';
import {
  createStatusReadAvailability,
  type StatusReadAvailability,
} from '../returns-status-availability.js';
import {
  LINE_A,
  NOW,
  SALE_NUMBER,
  SCOPE,
  categories,
  deferredFake,
  elapse,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  saleReturnFor,
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
const QUIET = RETURN_QUIET_PERIOD_MS;

let h: ReturnsHarness;
let approvals: ManagerApprovalService;
let userId: string | null;
let availability: StatusReadAvailability = createStatusReadAvailability();

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
  availability = createStatusReadAvailability();
  h = returnsHarness({
    role,
    statusAvailability: availability,
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
            closeAvailable: () => availability.isAvailable(),
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

/** A return whose first send was lost: unknown, one attempt (anchored for the quiet period). */
async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

/** A return the server RECORDED but whose answer was lost: unknown here, recorded there. */
async function recordedButUnknownReturn(): Promise<string> {
  h.backend.onReturn = (call, backend) => {
    backend.recordIdempotently(call);
    return Promise.reject(new TypeError('ECONNREFUSED'));
  };
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`recordedButUnknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

async function approve(
  returnId: string,
  disposition: ResolveDisposition = 'close',
  over: { reason?: string } = {},
): Promise<string> {
  const granted = await approvals.request({
    action_kind: RETURN_RESOLVE_ACTION_KIND,
    subject_ref: resolveSubjectRef(returnId, disposition),
    reason_code: over.reason ?? `${disposition}_unknown`,
    approver_ref: OMAR_REF,
    pin: PIN,
  });
  if (granted.kind !== 'approved') throw new Error(`approve: ${granted.reason}`);
  return granted.approvalId;
}

function spent(approvalId: string): boolean {
  const row = h.db.exec(
    `SELECT consumed_at FROM manager_approvals WHERE approval_id = '${approvalId}'`,
  )[0]?.values[0]?.[0];
  return row !== null && row !== undefined;
}

/** The reason of a refusal; any bridge answer of the return domain. */
function refusedReason(res: { readonly kind: string }): string {
  if (res.kind !== 'refused') throw new Error(`expected a refusal, got ${res.kind}`);
  return (res as unknown as { readonly reason: string }).reason;
}

function kinds(returnId: string): string[] {
  return h.dispositions.listFor(returnId).map((d) => d.kind);
}

/** The server answers the status read with `status`/`body` instead of the fake's own verdict. */
function statusAnswers(status: number, body: unknown = { error: { code: 'x' } }): void {
  h.backend.onStatus = () => jsonResponse(status, body);
}

/** RT-1553: does the void guard (`has_return`) see a live return of `saleId`? */
function voidBlocked(saleId: string): boolean {
  return (h.db.exec(LIVE_RETURN_SQL, [saleId])[0]?.values.length ?? 0) > 0;
}

/** An unknown return, then 16 minutes of real time, then the server's `not_recorded` read. */
async function readyToClose(): Promise<{ returnId: string; approvalId: string }> {
  const returnId = await unknownReturn();
  elapse(h, QUIET + 1_000);
  const read = await h.service.readStatus({ returnId });
  if (read.kind !== 'not_recorded' || !read.close.ready) {
    throw new Error(`readyToClose: ${JSON.stringify(read)}`);
  }
  return { returnId, approvalId: await approve(returnId) };
}

describe('returns.readStatus: the server verdict, never inferred', () => {
  it('not_recorded writes a restrict-only retry_hold and audits the read', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, 1_000);

    const res = await h.service.readStatus({ returnId });

    expect(res).toMatchObject({
      kind: 'not_recorded',
      ret: { returnId, state: 'unknown', disposition: null },
    });
    expect(h.dispositions.listFor(returnId)).toEqual([
      expect.objectContaining({
        kind: 'retry_hold',
        verdictSource: 'provenance_read',
        reason: 'not_recorded',
        approvalId: null,
        actorOperatorId: 'op-manager',
        readVerdictAt: h.state.now,
      }),
    ]);
    // It only restricts: not a state, the sale stays blocked, and nothing was sent.
    expect(h.dispositions.stateOf(returnId)).toBeNull();
    expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(true);
    expect(h.backend.returnCalls()).toHaveLength(1);
    const audit = h.audits.at(-1);
    expect(audit?.action_category).toBe('sale.return.status_read');
    expect(audit?.payload).toEqual({
      return_id: returnId,
      verdict: 'not_recorded',
      purpose: 'read',
    });
    expect(audit?.acting_operator_id).toBe('op-manager');
  });

  it('asks the server for THIS return: the sale, the source system and the journaled key', async () => {
    setup();
    const returnId = await unknownReturn();
    await h.service.readStatus({ returnId });
    const call = h.backend.statusCalls()[0];
    const url = new URL(call?.url ?? '');
    const entry = h.repo.read(returnId);
    expect(url.pathname).toBe(
      `/api/pos/v1/sales/${entry?.serverSaleRef ?? '?'}/returns/by-provenance/status`,
    );
    expect(url.searchParams.get('sourceSystem')).toBe('pos-pulse');
    expect(url.searchParams.get('externalId')).toBe(entry?.externalId);
    expect(call?.headers['Authorization']).toMatch(/^Bearer /);
  });

  it('a second not_recorded read while the hold is effective writes no second hold', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, 1_000);
    await h.service.readStatus({ returnId });
    elapse(h, 1_000);
    await h.service.readStatus({ returnId });
    expect(kinds(returnId)).toEqual(['retry_hold']);
  });

  it('the hold stops the resolver, so the quiet period can run out; the explicit resend voids it', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, 1_000);
    await h.service.readStatus({ returnId });
    const sent = h.backend.returnCalls().length;
    elapse(h, 10 * 60_000);
    await h.service.resolve();
    expect(h.backend.returnCalls()).toHaveLength(sent);

    await h.service.resend({ returnId });
    expect(h.backend.returnCalls()).toHaveLength(sent + 1);
    // Sent again: the quiet period starts over.
    const again = await h.service.readStatus({ returnId });
    expect(again).toMatchObject({
      kind: 'not_recorded',
      close: { ready: false, reason: 'too_soon' },
    });
  });

  it('says when the quiet period ends, and that it has once 15 minutes have elapsed', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, 60_000);
    const early = await h.service.readStatus({ returnId });
    expect(early).toMatchObject({
      kind: 'not_recorded',
      close: {
        ready: false,
        reason: 'too_soon',
        notBefore: new Date(Date.parse(NOW) + QUIET).toISOString(),
      },
    });
    elapse(h, QUIET);
    const late = await h.service.readStatus({ returnId });
    expect(late).toMatchObject({ kind: 'not_recorded', close: { ready: true } });
  });

  it('after an app restart the quiet period is unproven, however old the attempt', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, QUIET * 4);
    const restarted = h.restart();
    const res = await restarted.service.readStatus({ returnId });
    expect(res).toMatchObject({
      kind: 'not_recorded',
      close: { ready: false, reason: 'unproven' },
    });
  });

  it('a stepped wall clock makes the quiet period unproven', async () => {
    setup();
    const returnId = await unknownReturn();
    h.state.mono += 2 * 60_000; // two minutes really passed...
    h.state.now = new Date(Date.parse(h.state.now) + QUIET + 2 * 60_000).toISOString(); // ...the clock says 17
    const res = await h.service.readStatus({ returnId });
    expect(res).toMatchObject({
      kind: 'not_recorded',
      close: { ready: false, reason: 'unproven' },
    });
  });

  describe('recorded', () => {
    it('that is THIS return confirms it (confirm-by-read): confirmed + payout_ready, once, via the read', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      const sent = h.backend.returnCalls().length;
      const res = await h.service.readStatus({ returnId });

      expect(res).toMatchObject({
        kind: 'recorded',
        outcome: 'confirmed',
        ret: { returnId, state: 'confirmed' },
      });
      // No disposition, and nothing was sent: the server's own answer is the proof.
      expect(h.dispositions.listFor(returnId)).toEqual([]);
      expect(h.backend.returnCalls()).toHaveLength(sent);
      const entry = h.repo.read(returnId);
      expect(entry?.state).toBe('confirmed');
      expect(entry?.returnTotalMinor).toBe(entry?.quotedTotalMinor);
      expect(categories(h.audits).slice(-3)).toEqual([
        'sale.return.confirmed',
        'sale.return.payout_ready',
        'sale.return.status_read',
      ]);
      expect(h.audits.at(-3)?.payload).toMatchObject({
        return_id: returnId,
        replayed: false,
        via: 'status_read',
      });
      expect(h.audits.at(-1)?.payload).toMatchObject({
        verdict: 'recorded_match',
        purpose: 'read',
      });
      // The sale is resolved now: the payout may follow, a later resend changes nothing.
      expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(false);
      const again = await h.service.readStatus({ returnId });
      expect(refusedReason(again)).toBe('already_resolved');
      expect(categories(h.audits).filter((c) => c === 'sale.return.confirmed')).toHaveLength(1);
    });

    it.each([
      [
        'a different allocationRef',
        (t: Record<string, unknown>) => ({
          ...t,
          allocationRef: '0192f5a2-3b4c-7d8e-9f01-00000000aaaa',
        }),
      ],
      [
        'an instrument the till never sent',
        (t: Record<string, unknown>) => ({ ...t, instrument: 'cash' }),
      ],
      [
        'no allocationRef',
        (t: Record<string, unknown>) => ({ method: t['method'], amount: t['amount'] }),
      ],
    ] as [string, (t: Record<string, unknown>) => Record<string, unknown>][])(
      'same key and total but %s: NOT confirmed, no payout_ready (only the exact replay may settle it)',
      async (_name, alter) => {
        setup();
        const returnId = await recordedButUnknownReturn();
        h.backend.onStatus = (call, backend) => {
          const key = new URL(call.url).searchParams.get('externalId') ?? '';
          const recorded = backend.recorded.get(key) as unknown as {
            refundTenders: Record<string, unknown>[];
          };
          return jsonResponse(200, {
            status: 'recorded',
            creditLinked: false,
            saleReturn: { ...recorded, refundTenders: recorded.refundTenders.map(alter) },
          });
        };

        const res = await h.service.readStatus({ returnId });

        expect(res).toMatchObject({ kind: 'recorded', outcome: 'resend' });
        expect(h.repo.read(returnId)?.state).toBe('unknown');
        expect(categories(h.audits)).not.toContain('sale.return.confirmed');
        expect(categories(h.audits)).not.toContain('sale.return.payout_ready');
        expect(kinds(returnId)).toEqual([]);
      },
    );

    it('a recorded answer without readable refundTenders is never confirmed by the read', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      h.backend.onStatus = (call, backend) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        const recorded = backend.recorded.get(key) as unknown as Record<string, unknown>;
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: false,
          saleReturn: { ...recorded, refundTenders: 'garbled' },
        });
      };
      const res = await h.service.readStatus({ returnId });
      expect(res).toMatchObject({ kind: 'recorded', outcome: 'resend' });
      expect(h.repo.read(returnId)?.state).toBe('unknown');
    });

    it('a send that confirms the return keeps via: send on its confirmed audit', async () => {
      setup();
      h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
      const res = await h.service.submit(ONE_A);
      expect(res.kind).toBe('confirmed');
      const confirmed = h.audits.find((e) => e.action_category === 'sale.return.confirmed');
      expect(confirmed?.payload).toMatchObject({ via: 'send' });
    });

    it('a needs_support return confirms on a matching read (support is not terminal)', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      h.backend.onStatus = (call, backend) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: false,
          saleReturn: { ...backend.recorded.get(key), returnTotal: '14.0000' },
        });
      };
      await h.service.readStatus({ returnId });
      expect(h.dispositions.stateOf(returnId)).toBe('needs_support');

      h.backend.onStatus = (call, backend) => backend.answerStatus(call);
      elapse(h, 1_000);
      const res = await h.service.readStatus({ returnId });

      expect(res).toMatchObject({ kind: 'recorded', outcome: 'confirmed' });
      expect(h.repo.read(returnId)?.state).toBe('confirmed');
    });

    it('a return held by a retry_hold confirms on a later matching read', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      statusAnswers(200, { status: 'not_recorded' });
      await h.service.readStatus({ returnId });
      expect(kinds(returnId)).toEqual(['retry_hold']);

      h.backend.onStatus = (call, backend) => backend.answerStatus(call);
      elapse(h, 1_000);
      const res = await h.service.readStatus({ returnId });

      expect(res).toMatchObject({ kind: 'recorded', outcome: 'confirmed' });
      expect(h.repo.read(returnId)?.state).toBe('confirmed');
    });

    it('that does NOT match hands the return to support: needs_support from the read, no approval', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      h.backend.onStatus = (call, backend) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        const recorded = backend.recorded.get(key);
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: false,
          saleReturn: { ...recorded, returnTotal: '14.0000' },
        });
      };
      elapse(h, 1_000);

      const res = await h.service.readStatus({ returnId });

      expect(res).toMatchObject({
        kind: 'recorded',
        outcome: 'support',
        ret: { disposition: 'needs_support' },
      });
      expect(h.dispositions.listFor(returnId)).toEqual([
        expect.objectContaining({
          kind: 'needs_support',
          verdictSource: 'provenance_read',
          reason: 'mismatch',
          approvalId: null,
          actorOperatorId: 'op-manager',
          readVerdictAt: h.state.now,
        }),
      ]);
      expect(categories(h.audits).slice(-2)).toEqual([
        'sale.return.needs_support',
        'sale.return.status_read',
      ]);
      expect(h.audits.at(-2)?.payload).toEqual({
        return_id: returnId,
        approval_id: null,
        verdict_source: 'provenance_read',
        reason: 'mismatch',
        origin_user_unknown: true,
      });
      expect(h.audits.at(-1)?.payload).toMatchObject({ verdict: 'recorded_mismatch' });
      // It never confirms and never frees the sale.
      expect(h.repo.read(returnId)?.state).toBe('unknown');
      expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(true);
    });

    it('a credit reversal is a mismatch even when everything else matches', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      h.backend.onStatus = (call, backend) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: true,
          saleReturn: backend.recorded.get(key),
        });
      };
      const res = await h.service.readStatus({ returnId });
      expect(res).toMatchObject({ kind: 'recorded', outcome: 'support' });
      expect(kinds(returnId)).toEqual(['needs_support']);
    });

    it('a second mismatching read writes no second needs_support', async () => {
      setup();
      const returnId = await recordedButUnknownReturn();
      h.backend.onStatus = (call, backend) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: true,
          saleReturn: backend.recorded.get(key),
        });
      };
      await h.service.readStatus({ returnId });
      await h.service.readStatus({ returnId });
      expect(kinds(returnId)).toEqual(['needs_support']);
      expect(categories(h.audits).filter((c) => c === 'sale.return.needs_support')).toHaveLength(1);
    });
  });

  describe('what is not a verdict changes nothing', () => {
    it.each([
      ['a 404 (gate off)', 404, 'unavailable'],
      ['a 500', 500, 'server'],
      ['a 503', 503, 'server'],
      ['a 401', 401, 'unauthorized'],
      ['a 403', 403, 'unauthorized'],
    ] as const)('%s is inconclusive (%s) and writes only the audit', async (_n, status, cause) => {
      setup();
      const returnId = await unknownReturn();
      statusAnswers(status);

      const res = await h.service.readStatus({ returnId });

      expect(res).toMatchObject({ kind: 'inconclusive', cause });
      expect(h.dispositions.listFor(returnId)).toEqual([]);
      expect(h.audits.at(-1)?.payload).toEqual({
        return_id: returnId,
        verdict: 'inconclusive',
        cause,
        purpose: 'read',
      });
    });

    it('a network fault is inconclusive (offline)', async () => {
      setup();
      const returnId = await unknownReturn();
      h.backend.onStatus = () => Promise.reject(new TypeError('ECONNREFUSED'));
      expect(await h.service.readStatus({ returnId })).toMatchObject({
        kind: 'inconclusive',
        cause: 'offline',
      });
    });

    it('an off-contract 200 is inconclusive (unreadable)', async () => {
      setup();
      const returnId = await unknownReturn();
      statusAnswers(200, { status: 'unknown_yet' });
      expect(await h.service.readStatus({ returnId })).toMatchObject({
        kind: 'inconclusive',
        cause: 'unreadable',
      });
    });

    it('a 404 makes a close unavailable; a verdict makes it available again', async () => {
      setup();
      const returnId = await unknownReturn();
      expect(availability.isAvailable()).toBe(false);
      await h.service.readStatus({ returnId });
      expect(availability.isAvailable()).toBe(true);
      statusAnswers(404);
      await h.service.readStatus({ returnId });
      expect(availability.isAvailable()).toBe(false);
    });
  });

  describe('who may read, and which return', () => {
    it('refuses a cashier (role_denied) and asks the server nothing', async () => {
      setup();
      const returnId = await unknownReturn();
      h.state.role = 'cashier';
      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('role_denied');
      expect(h.backend.statusCalls()).toHaveLength(0);
    });

    it.each([
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
    ] as const)('answers %s before any read', async (reason, change) => {
      setup();
      const returnId = await unknownReturn();
      change();
      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe(reason);
      expect(h.backend.statusCalls()).toHaveLength(0);
    });

    it('refuses a return that is not on this terminal (return_not_found)', async () => {
      setup();
      await unknownReturn();
      expect(
        refusedReason(
          await h.service.readStatus({ returnId: '0190f5a2-7b3c-4d4e-8f90-0000000000ee' }),
        ),
      ).toBe('return_not_found');
    });

    it('refuses a return that is already resolved (already_resolved)', async () => {
      setup();
      h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
      const res = await h.service.submit(ONE_A);
      if (res.kind !== 'confirmed') throw new Error(res.kind);
      expect(refusedReason(await h.service.readStatus({ returnId: res.ret.returnId }))).toBe(
        'already_resolved',
      );
      expect(h.backend.statusCalls()).toHaveLength(0);
    });

    it('refuses a return that was never sent (never_sent): send it first', async () => {
      setup();
      const returnId = '0190f5a2-7b3c-7d4e-8f90-0000000000c9';
      h.repo.insert({
        returnId,
        scope: SCOPE,
        saleId: 'sale-1',
        saleNumber: SALE_NUMBER,
        serverSaleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
        externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000c9',
        operatorId: 'op-manager',
        operatorSessionId: 'sess-manager',
        currencyCode: 'EGP',
        quotedTotalMinor: 3500,
        requestBodyJson: '{}',
        lines: [{ lineRef: LINE_A, quantity: 1 }],
        now: NOW,
      });
      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('never_sent');
      expect(h.backend.statusCalls()).toHaveLength(0);
    });

    it('refuses while a send of the return is in flight (send_in_flight)', async () => {
      setup();
      const returnId = await unknownReturn();
      const gate = deferredFake<Response>();
      h.backend.onReturn = () => gate.promise;
      const sending = h.service.resend({ returnId });

      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('send_in_flight');
      expect(h.backend.statusCalls()).toHaveLength(0);
      gate.resolve(new Response('{}', { status: 500 }));
      await sending;
    });

    it('refuses a second read of the same return while one is running', async () => {
      setup();
      const returnId = await unknownReturn();
      const gate = deferredFake<Response>();
      h.backend.onStatus = () => gate.promise;
      const first = h.service.readStatus({ returnId });

      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('send_in_flight');
      gate.resolve(jsonResponse(200, { status: 'not_recorded' }));
      expect((await first).kind).toBe('not_recorded');
    });

    it('a send that ran while the read was in flight makes the verdict stale: nothing is written', async () => {
      setup();
      const returnId = await unknownReturn();
      const gate = deferredFake<Response>();
      h.backend.onStatus = () => gate.promise;
      const reading = h.service.readStatus({ returnId });
      // The background resolver cannot start a send of this return during a read? It can: the read is
      // not a send. It moves last_attempt_at, so the answer no longer covers the last send.
      elapse(h, 30_000);
      h.repo.recordAttempt({ returnId, now: h.state.now });
      gate.resolve(jsonResponse(200, { status: 'not_recorded' }));

      expect(refusedReason(await reading)).toBe('send_in_flight');
      expect(h.dispositions.listFor(returnId)).toEqual([]);
    });

    it('answers session_changed and writes nothing when the session locks during the read', async () => {
      setup();
      const returnId = await unknownReturn();
      h.backend.onStatus = () => {
        h.state.locked = true;
        return jsonResponse(200, { status: 'not_recorded' });
      };
      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('session_changed');
      expect(h.dispositions.listFor(returnId)).toEqual([]);
    });

    it('answers shutting_down and writes nothing when the app stops during the read', async () => {
      setup();
      const returnId = await unknownReturn();
      const auditsBefore = h.audits.length;
      h.backend.onStatus = () => {
        h.stop();
        return jsonResponse(200, { status: 'not_recorded' });
      };
      expect(refusedReason(await h.service.readStatus({ returnId }))).toBe('shutting_down');
      expect(h.audits).toHaveLength(auditsBefore);
    });
  });
});

describe('returns.close: only an affirmative fresh not_recorded, after the quiet period, with one approval', () => {
  it('closes the return: disposition, spent approval and audit commit together', async () => {
    setup();
    const { returnId, approvalId } = await readyToClose();
    const sentBefore = h.backend.returnCalls().length;

    const res = await h.service.close({ returnId, approvalId });

    expect(res).toMatchObject({
      kind: 'closed',
      ret: { returnId, state: 'unknown', disposition: 'closed' },
    });
    const closeRow = h.dispositions.listFor(returnId).find((d) => d.kind === 'not_recorded_closed');
    expect(closeRow).toMatchObject({
      verdictSource: 'provenance_read',
      reason: 'not_recorded',
      approvalId,
      actorOperatorId: 'op-manager',
      readVerdictAt: h.state.now,
    });
    expect(spent(approvalId)).toBe(true);
    expect(h.dispositions.stateOf(returnId)).toBe('closed');
    // Nothing was sent: a close never POSTs. The row stays unknown (never confirmed or refused).
    expect(h.backend.returnCalls()).toHaveLength(sentBefore);
    expect(h.repo.read(returnId)).toMatchObject({ state: 'unknown', returnRef: null });
    expect(categories(h.audits).slice(-2)).toEqual([
      'sale.return.status_read',
      'sale.return.closed_not_recorded',
    ]);
    expect(h.audits.at(-2)?.payload).toEqual({
      return_id: returnId,
      verdict: 'not_recorded',
      purpose: 'close',
    });
    const closed = h.audits.at(-1);
    expect(closed?.payload).toEqual({
      return_id: returnId,
      approval_id: approvalId,
      read_verdict_at: h.state.now,
      origin_user_unknown: true,
    });
    expect(closed?.acting_operator_id).toBe('op-manager');
    expect(closed?.approving_supervisor_id).toBe(OMAR);
  });

  it('frees the sale: unresolved_return_exists clears and a new return is taken', async () => {
    setup();
    const { returnId, approvalId } = await readyToClose();
    expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(true);
    await h.service.close({ returnId, approvalId });
    expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(false);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    expect((await h.service.submit(ONE_A)).kind).toBe('confirmed');
  });

  it('a closed return is never sent again, by any path, and its history says closed', async () => {
    setup();
    const { returnId, approvalId } = await readyToClose();
    await h.service.close({ returnId, approvalId });
    const sent = h.backend.returnCalls().length;
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    await h.service.resolve();
    expect(refusedReason(await h.service.resend({ returnId }))).toBe('already_resolved');
    expect(h.backend.returnCalls()).toHaveLength(sent);
    expect(await h.service.list()).toMatchObject({
      kind: 'ok',
      returns: [{ returnId, disposition: 'closed' }],
    });
  });

  it('an admin may close too', async () => {
    setup('admin');
    const { returnId, approvalId } = await readyToClose();
    expect((await h.service.close({ returnId, approvalId })).kind).toBe('closed');
  });

  it('closes exactly at 15 minutes of elapsed time', async () => {
    setup();
    const returnId = await unknownReturn();
    elapse(h, QUIET);
    const read = await h.service.readStatus({ returnId });
    expect(read).toMatchObject({ kind: 'not_recorded', close: { ready: true } });
    const approvalId = await approve(returnId);
    expect((await h.service.close({ returnId, approvalId })).kind).toBe('closed');
  });

  describe('the quiet period', () => {
    it('refuses a close one millisecond early (reconcile_too_soon): no read, nothing spent', async () => {
      setup();
      const returnId = await unknownReturn();
      elapse(h, 1_000);
      await h.service.readStatus({ returnId }); // makes the close available
      elapse(h, QUIET - 1_000 - 1);
      const approvalId = await approve(returnId);
      const reads = h.backend.statusCalls().length;

      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'reconcile_too_soon',
      );
      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(spent(approvalId)).toBe(false);
      expect(kinds(returnId)).toEqual(['retry_hold']);
    });

    it('refuses after an app restart (quiet_period_unproven): the period cannot be shown', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      elapse(h, QUIET * 4);
      const restarted = h.restart();

      expect(refusedReason(await restarted.service.close({ returnId, approvalId }))).toBe(
        'quiet_period_unproven',
      );
      expect(spent(approvalId)).toBe(false);
    });

    it.each([
      ['forward', QUIET],
      ['back', -10 * 60_000],
    ])('refuses when the wall clock stepped %s (quiet_period_unproven)', async (_d, step) => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.state.now = new Date(Date.parse(h.state.now) + step).toISOString();

      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'quiet_period_unproven',
      );
      expect(spent(approvalId)).toBe(false);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });

    it('an explicit resend after the read starts the period again', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      await h.service.resend({ returnId });
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'reconcile_too_soon',
      );
    });
  });

  describe('the fresh server read at close time', () => {
    it('when the server now has THIS return: confirms it by the read, refuses the close as resolved', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      // The late POST committed after all: the key is now recorded on the server.
      h.backend.onStatus = (call, backend) => {
        backend.recordIdempotently({
          url: call.url.replace(/\/returns\/by-provenance\/status.*$/, '/returns'),
          method: 'POST',
          headers: { 'Idempotency-Key': new URL(call.url).searchParams.get('externalId') ?? '' },
          body: h.repo.read(returnId)?.requestBodyJson,
        });
        return backend.answerStatus(call);
      };

      const res = await h.service.close({ returnId, approvalId });

      // RT-1498 confirm-by-read: the server proved it, so it is confirmed (never closed).
      expect(refusedReason(res)).toBe('already_resolved');
      expect(res).toMatchObject({ ret: { returnId, state: 'confirmed' } });
      expect(h.repo.read(returnId)?.state).toBe('confirmed');
      expect(h.dispositions.stateOf(returnId)).toBeNull();
      expect(kinds(returnId)).not.toContain('not_recorded_closed');
      expect(spent(approvalId)).toBe(false);
      const confirmed = h.audits.find((e) => e.action_category === 'sale.return.confirmed');
      expect(confirmed?.payload).toMatchObject({ via: 'status_read' });
    });

    it('a recorded answer that does not match also hands the return to support', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.backend.onStatus = (call) => {
        const key = new URL(call.url).searchParams.get('externalId') ?? '';
        const entry = h.repo.read(returnId);
        const body = JSON.parse(entry?.requestBodyJson ?? '{}') as never;
        return jsonResponse(200, {
          status: 'recorded',
          creditLinked: false,
          saleReturn: { ...saleReturnFor(body), externalId: key, returnTotal: '14.0000' },
        });
      };

      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'close_needs_not_recorded',
      );
      expect(h.dispositions.stateOf(returnId)).toBe('needs_support');
      expect(spent(approvalId)).toBe(false);
    });

    it('a 404 at close time is returns_unavailable: no close, nothing spent, close unavailable', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      statusAnswers(404);
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'returns_unavailable',
      );
      expect(spent(approvalId)).toBe(false);
      expect(availability.isAvailable()).toBe(false);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });

    it.each([
      [
        'a 500',
        () => {
          statusAnswers(500);
        },
        'offline',
      ],
      [
        'a 503',
        () => {
          statusAnswers(503);
        },
        'offline',
      ],
      [
        'an unreadable 200',
        () => {
          statusAnswers(200, { nope: true });
        },
        'offline',
      ],
      [
        'a 401',
        () => {
          statusAnswers(401);
        },
        'read_unauthorized',
      ],
      [
        'a 403',
        () => {
          statusAnswers(403);
        },
        'read_unauthorized',
      ],
    ] as const)('%s is no verdict (%s): no close, nothing spent', async (_n, fault, reason) => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      fault();
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(reason);
      expect(spent(approvalId)).toBe(false);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });

    it('a network fault is no verdict (offline)', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.backend.onStatus = () => Promise.reject(new TypeError('ECONNREFUSED'));
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe('offline');
      expect(spent(approvalId)).toBe(false);
    });

    it('a send that ran while the read was in flight refuses the close (send_in_flight)', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      const gate = deferredFake<Response>();
      h.backend.onStatus = () => gate.promise;
      const closing = h.service.close({ returnId, approvalId });
      h.repo.recordAttempt({
        returnId,
        now: new Date(Date.parse(h.state.now) + 1000).toISOString(),
      });
      gate.resolve(jsonResponse(200, { status: 'not_recorded' }));

      expect(refusedReason(await closing)).toBe('send_in_flight');
      expect(spent(approvalId)).toBe(false);
    });
  });

  describe('the approval is bound to this return and to close', () => {
    it('refuses an ESCALATE approval for a close (approval_invalid), and spends nothing', async () => {
      setup();
      const { returnId } = await readyToClose();
      const wrong = await approve(returnId, 'escalate');
      expect(refusedReason(await h.service.close({ returnId, approvalId: wrong }))).toBe(
        'approval_invalid',
      );
      expect(spent(wrong)).toBe(false);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });

    it('refuses a CLOSE approval for an escalate (approval_invalid), and spends nothing', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      expect(refusedReason(await h.service.escalate({ returnId, approvalId }))).toBe(
        'approval_invalid',
      );
      expect(spent(approvalId)).toBe(false);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });

    it('refuses another return’s close approval', async () => {
      setup();
      const first = await readyToClose();
      const other = await approve('0190f5a2-7b3c-4d4e-8f90-0000000000ee', 'close').catch(
        () => null,
      );
      expect(other).toBeNull(); // no such return: the subject cannot even be named
      const bogus = '0190f5a2-7b3c-4d4e-8f90-0000000000ef';
      expect(
        refusedReason(await h.service.close({ returnId: first.returnId, approvalId: bogus })),
      ).toBe('approval_invalid');
    });

    it('refuses an approval granted under another reason code', async () => {
      setup();
      const { returnId } = await readyToClose();
      const wrong = await approve(returnId, 'close', { reason: 'escalate_unknown' });
      expect(refusedReason(await h.service.close({ returnId, approvalId: wrong }))).toBe(
        'approval_invalid',
      );
      expect(spent(wrong)).toBe(false);
    });

    it('is single use: the same approval cannot close twice, and a second close is already_resolved', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      expect((await h.service.close({ returnId, approvalId })).kind).toBe('closed');
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'already_resolved',
      );
      expect(kinds(returnId).filter((k) => k === 'not_recorded_closed')).toHaveLength(1);
    });

    it('is not granted while the status read is unavailable (no close subject exists)', async () => {
      setup();
      const returnId = await unknownReturn();
      elapse(h, QUIET + 1_000);
      // No status read has answered yet in this process: unknown means unavailable.
      await expect(approve(returnId, 'close')).rejects.toThrow(/approve/);
      statusAnswers(404);
      await h.service.readStatus({ returnId });
      await expect(approve(returnId, 'close')).rejects.toThrow(/approve/);
    });

    it('is refused when the requester is not the live operator (the approval was granted to another)', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      userId = OMAR; // the live operator is now Omar, who approved it: four-eyes
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'approval_invalid',
      );
      expect(spent(approvalId)).toBe(false);
    });

    it('is refused without an approval service (fail closed)', async () => {
      userId = MONA;
      availability = createStatusReadAvailability();
      // A domain composed with no escalation deps cannot spend an approval.
      h = returnsHarness({ role: 'manager', statusAvailability: availability });
      seedSyncedSale(h.db);
      const returnId = await unknownReturn();
      elapse(h, QUIET + 1_000);
      const bogus = '0190f5a2-7b3c-4d4e-8f90-0000000000ef';

      expect(refusedReason(await h.service.close({ returnId, approvalId: bogus }))).toBe(
        'approval_invalid',
      );
      expect(h.dispositions.stateOf(returnId)).toBeNull();
    });
  });

  describe('from needs_support, and the states that cannot close', () => {
    it('a needs_support return can be closed (LOW-1): read, wait, approve, close', async () => {
      setup();
      const returnId = await unknownReturn();
      await h.service.escalate({ returnId, approvalId: await approve(returnId, 'escalate') });
      expect(h.dispositions.stateOf(returnId)).toBe('needs_support');
      elapse(h, QUIET + 1_000);
      const read = await h.service.readStatus({ returnId });
      expect(read).toMatchObject({ kind: 'not_recorded', close: { ready: true } });
      const approvalId = await approve(returnId, 'close');

      const res = await h.service.close({ returnId, approvalId });

      expect(res).toMatchObject({ kind: 'closed', ret: { disposition: 'closed' } });
      expect(kinds(returnId)).toEqual(['needs_support', 'retry_hold', 'not_recorded_closed']);
      expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(false);
    });

    it('refuses a never-sent return (never_sent)', async () => {
      setup();
      const returnId = '0190f5a2-7b3c-7d4e-8f90-0000000000c8';
      h.repo.insert({
        returnId,
        scope: SCOPE,
        saleId: 'sale-1',
        saleNumber: SALE_NUMBER,
        serverSaleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
        externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-0000000000c8',
        operatorId: 'op-manager',
        operatorSessionId: 'sess-manager',
        currencyCode: 'EGP',
        quotedTotalMinor: 3500,
        requestBodyJson: '{}',
        lines: [{ lineRef: LINE_A, quantity: 1 }],
        now: NOW,
      });
      const bogus = '0190f5a2-7b3c-4d4e-8f90-0000000000ef';
      expect(refusedReason(await h.service.close({ returnId, approvalId: bogus }))).toBe(
        'never_sent',
      );
      expect(h.backend.statusCalls()).toHaveLength(0);
    });

    it('refuses a confirmed return (already_resolved)', async () => {
      setup();
      h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
      const res = await h.service.submit(ONE_A);
      if (res.kind !== 'confirmed') throw new Error(res.kind);
      const bogus = '0190f5a2-7b3c-4d4e-8f90-0000000000ef';
      expect(
        refusedReason(await h.service.close({ returnId: res.ret.returnId, approvalId: bogus })),
      ).toBe('already_resolved');
    });

    it('refuses while a send of the return is in flight (send_in_flight)', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      const gate = deferredFake<Response>();
      h.backend.onReturn = () => gate.promise;
      const sending = h.service.resend({ returnId });
      const reads = h.backend.statusCalls().length;

      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe('send_in_flight');
      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(spent(approvalId)).toBe(false);
      gate.resolve(new Response('{}', { status: 500 }));
      await sending;
    });

    it('two closes at once: one wins, the other is refused, one disposition exists', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      const [a, b] = await Promise.all([
        h.service.close({ returnId, approvalId }),
        h.service.close({ returnId, approvalId }),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['closed', 'refused']);
      expect(kinds(returnId).filter((k) => k === 'not_recorded_closed')).toHaveLength(1);
    });

    it('refuses an unknown return id and an invalid request', async () => {
      setup();
      const { approvalId } = await readyToClose();
      expect(
        refusedReason(
          await h.service.close({ returnId: '0190f5a2-7b3c-4d4e-8f90-0000000000ee', approvalId }),
        ),
      ).toBe('return_not_found');
      expect(refusedReason(await h.service.close({ returnId: 'x', approvalId }))).toBe(
        'invalid_input',
      );
      expect(refusedReason(await h.service.readStatus({ returnId: 'x' }))).toBe('invalid_input');
    });
  });

  describe('who may close (the admission gate)', () => {
    it('refuses a cashier (role_denied) and spends nothing', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.state.role = 'cashier';
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe('role_denied');
      expect(spent(approvalId)).toBe(false);
    });

    it.each([
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
    ] as const)('answers %s and writes nothing', async (reason, change) => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      change();
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(reason);
      expect(h.dispositions.stateOf(returnId)).toBeNull();
      expect(spent(approvalId)).toBe(false);
    });

    it('answers session_changed when the session locks during the fresh read, and writes nothing', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.backend.onStatus = () => {
        h.state.locked = true;
        return jsonResponse(200, { status: 'not_recorded' });
      };
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe(
        'session_changed',
      );
      expect(h.dispositions.stateOf(returnId)).toBeNull();
      expect(spent(approvalId)).toBe(false);
    });

    it('answers shutting_down when the app stops during the fresh read, and writes nothing', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.backend.onStatus = () => {
        h.stop();
        return jsonResponse(200, { status: 'not_recorded' });
      };
      expect(refusedReason(await h.service.close({ returnId, approvalId }))).toBe('shutting_down');
      expect(spent(approvalId)).toBe(false);
    });
  });

  describe('atomicity', () => {
    it('a failed audit rolls the whole close back: no disposition, the approval is still unspent', async () => {
      setup();
      const { returnId, approvalId } = await readyToClose();
      h.state.failAudit = (event) => event.action_category === 'sale.return.closed_not_recorded';

      await expect(h.service.close({ returnId, approvalId })).rejects.toThrow();

      h.state.failAudit = null;
      expect(h.dispositions.stateOf(returnId)).toBeNull();
      expect(spent(approvalId)).toBe(false);
      // And it still closes once the audit works (the approval is not burned).
      expect((await h.service.close({ returnId, approvalId })).kind).toBe('closed');
    });
  });
});

describe('a late commit after a close (RT-1548, RT-1553): audited, support, sale blocked, never paid', () => {
  /** A closed return, whose key the server then records after all. */
  async function closedThenRecorded(): Promise<string> {
    setup();
    const { returnId, approvalId } = await readyToClose();
    await h.service.close({ returnId, approvalId });
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    // The server records the closed key (the late POST committed): its own record answers the read.
    h.backend.recordIdempotently({
      url: `https://backend.example.invalid/api/pos/v1/sales/${h.repo.read(returnId)?.serverSaleRef ?? ''}/returns`,
      method: 'POST',
      headers: { 'Idempotency-Key': h.repo.read(returnId)?.externalId ?? '' },
      body: h.repo.read(returnId)?.requestBodyJson,
    });
    return returnId;
  }

  it('a status read of the closed return that finds it recorded is a late commit', async () => {
    const returnId = await closedThenRecorded();
    const dispositionsBefore = h.dispositions.listFor(returnId).length;

    const res = await h.service.readStatus({ returnId });

    expect(res).toMatchObject({
      kind: 'recorded',
      outcome: 'late_commit',
      // RT-1553: a support state on screen; the return stays closed for the flow.
      ret: { returnId, state: 'unknown', disposition: 'needs_support' },
    });
    const late = h.audits.find((e) => e.action_category === 'sale.return.late_commit_after_close');
    expect(late?.payload).toEqual({
      return_id: returnId,
      return_ref: expect.any(String) as string,
      credit_linked: false,
    });
    expect(late?.acting_operator_id).toBe('op-manager');
    // RT-1553 (0071): exactly one needs_support from the read follows the close; the row stays frozen.
    expect(h.dispositions.listFor(returnId)).toHaveLength(dispositionsBefore + 1);
    expect(h.dispositions.listFor(returnId).at(-1)).toMatchObject({
      kind: 'needs_support',
      verdictSource: 'provenance_read',
      reason: 'mismatch',
      approvalId: null,
      actorOperatorId: 'op-manager',
      readVerdictAt: h.state.now,
    });
    expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
    expect(categories(h.audits)).toContain('sale.return.needs_support');
    expect(h.audits.at(-1)?.payload).toMatchObject({ verdict: 'recorded_match', purpose: 'read' });
  });

  it('close, recorded, needs_support, the sale blocked again, and no cash (RT-1553)', async () => {
    const returnId = await closedThenRecorded();
    const saleId = h.repo.read(returnId)?.saleId ?? '';
    // The close freed the sale (a new return and a void were allowed).
    expect(h.repo.hasUnresolvedForSale(saleId)).toBe(false);
    expect(voidBlocked(saleId)).toBe(false);

    await h.service.readStatus({ returnId });

    expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
    expect(h.repo.hasUnresolvedForSale(saleId)).toBe(true);
    expect(voidBlocked(saleId)).toBe(true);
    const posts = h.backend.returnCalls().length;
    const second = await h.service.submit(ONE_A);
    expect(refusedReason(second)).toBe('unresolved_return_exists');
    expect(h.backend.returnCalls()).toHaveLength(posts);
    // No cash: the row is frozen (never confirmed), so it is never payable.
    expect(h.repo.read(returnId)).toMatchObject({ state: 'unknown', returnRef: null });
    const payout = await h.service.payout({ returnId, action: 'start' });
    expect(payout).toMatchObject({ kind: 'refused', reason: 'not_payable' });
    expect(h.drawer.kicks).toBe(0);
  });

  it('raises support only once, and the closed return still cannot be closed, escalated or resent', async () => {
    const returnId = await closedThenRecorded();
    await h.service.readStatus({ returnId });
    const after = h.dispositions.listFor(returnId).length;

    expect(await h.service.readStatus({ returnId })).toMatchObject({ outcome: 'late_commit' });
    expect(h.dispositions.listFor(returnId)).toHaveLength(after);
    expect(refusedReason(await h.service.resend({ returnId }))).toBe('already_resolved');
    expect(
      refusedReason(
        await h.service.close({ returnId, approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000c1' }),
      ),
    ).toBe('already_resolved');
    expect(
      refusedReason(
        await h.service.escalate({ returnId, approvalId: '0190f5a2-7b3c-7d4e-8f90-0000000000c2' }),
      ),
    ).toBe('already_resolved');
    expect(h.dispositions.listFor(returnId)).toHaveLength(after);
  });

  it('never pays cash: the row is not confirmable, not payable, and not resendable', async () => {
    const returnId = await closedThenRecorded();
    await h.service.readStatus({ returnId });

    expect(h.repo.read(returnId)).toMatchObject({ state: 'unknown', returnRef: null });
    expect(refusedReason(await h.service.resend({ returnId }))).toBe('already_resolved');
    await h.service.resolve();
    expect(h.repo.read(returnId)?.state).toBe('unknown');
    expect(
      h.repo.markConfirmed({ returnId, returnRef: 'r', returnTotalMinor: 3500, now: h.state.now }),
    ).toBe(false);
    const payout = await h.service.payout({ returnId, action: 'start' });
    expect(payout).toMatchObject({ kind: 'refused', reason: 'not_payable' });
    expect(h.drawer.kicks).toBe(0);
  });

  it('a credit reversal seen after the close is flagged the same way', async () => {
    const returnId = await closedThenRecorded();
    h.backend.onStatus = (call, backend) => {
      const key = new URL(call.url).searchParams.get('externalId') ?? '';
      return jsonResponse(200, {
        status: 'recorded',
        creditLinked: true,
        saleReturn: backend.recorded.get(key),
      });
    };
    expect(await h.service.readStatus({ returnId })).toMatchObject({
      kind: 'recorded',
      outcome: 'late_commit',
    });
    const late = h.audits.find((e) => e.action_category === 'sale.return.late_commit_after_close');
    expect(late?.payload).toMatchObject({ credit_linked: true });
  });

  it('a read of a closed return that is still not recorded says closed and writes no hold', async () => {
    setup();
    const { returnId, approvalId } = await readyToClose();
    await h.service.close({ returnId, approvalId });
    const before = h.dispositions.listFor(returnId).length;

    const res = await h.service.readStatus({ returnId });

    expect(res).toMatchObject({ kind: 'not_recorded', close: { ready: false, reason: 'closed' } });
    expect(h.dispositions.listFor(returnId)).toHaveLength(before);
  });
});

describe('automatic late-commit detection (RT-1553)', () => {
  /** A closed return; the server then records its key (the late POST committed) unless `recorded` is false. */
  async function closed(recorded = true): Promise<string> {
    setup();
    const { returnId, approvalId } = await readyToClose();
    await h.service.close({ returnId, approvalId });
    if (recorded) {
      const entry = h.repo.read(returnId);
      h.backend.recordIdempotently({
        url: `https://backend.example.invalid/api/pos/v1/sales/${entry?.serverSaleRef ?? ''}/returns`,
        method: 'POST',
        headers: { 'Idempotency-Key': entry?.externalId ?? '' },
        body: entry?.requestBodyJson,
      });
    }
    return returnId;
  }

  describe('the background sweep (resolver pass)', () => {
    it('reads nothing before the quiet period since the close has passed', async () => {
      const returnId = await closed();
      const reads = h.backend.statusCalls().length;

      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
    });

    it('reads each closed return once a quiet period after its close and raises the late commit', async () => {
      const returnId = await closed();
      const saleId = h.repo.read(returnId)?.saleId ?? '';
      elapse(h, QUIET + 1_000);
      const reads = h.backend.statusCalls().length;

      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads + 1);
      expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
      expect(h.repo.hasUnresolvedForSale(saleId)).toBe(true);
      expect(
        h.audits.find((e) => e.action_category === 'sale.return.late_commit_after_close')
          ?.acting_operator_id,
      ).toBe('op-manager');
      expect(h.drawer.kicks).toBe(0);
    });

    it('reads a closed return that is still not recorded once, and the sale stays free', async () => {
      const returnId = await closed(false);
      const saleId = h.repo.read(returnId)?.saleId ?? '';
      elapse(h, QUIET + 1_000);
      const reads = h.backend.statusCalls().length;

      await h.resolver.tick();
      elapse(h, QUIET + 1_000);
      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads + 1);
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
      expect(h.repo.hasUnresolvedForSale(saleId)).toBe(false);
    });

    it('reads again on a later pass while the read gives no verdict', async () => {
      const returnId = await closed();
      elapse(h, QUIET + 1_000);
      statusAnswers(503);
      const reads = h.backend.statusCalls().length;

      await h.resolver.tick();
      expect(h.dispositions.stateOf(returnId)).toBe('closed');

      h.backend.onStatus = (call, backend) => backend.answerStatus(call);
      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads + 2);
      expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
    });

    it('sends no request on behalf of an actor who signed out since the pass began (RT-1553 review)', async () => {
      const returnId = await closed();
      elapse(h, QUIET + 1_000);
      const reads = h.backend.statusCalls().length;
      const live = h.resolver;
      // The pass snapshot is taken, then the operator signs out before the read starts.
      const snapshotThenSignOut = live.tick();
      h.state.role = null;
      await snapshotThenSignOut;
      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
    });

    it('does nothing without an eligible manager signed in', async () => {
      const returnId = await closed();
      elapse(h, QUIET + 1_000);
      h.state.role = 'cashier';
      const reads = h.backend.statusCalls().length;

      await h.resolver.tick();

      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
    });
  });

  describe('a new return of the same sale is quoted', () => {
    it('reads the closed return at once: a late commit refuses the quote and blocks the sale', async () => {
      const returnId = await closed();
      const saleId = h.repo.read(returnId)?.saleId ?? '';
      const posts = h.backend.returnCalls().length;

      const quote = await h.service.quote(ONE_A);

      expect(refusedReason(quote)).toBe('unresolved_return_exists');
      expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
      expect(h.repo.hasUnresolvedForSale(saleId)).toBe(true);
      expect(refusedReason(await h.service.submit(ONE_A))).toBe('unresolved_return_exists');
      expect(h.backend.returnCalls()).toHaveLength(posts);
      expect(h.drawer.kicks).toBe(0);
    });

    it('quotes as before when the closed return is still not recorded', async () => {
      const returnId = await closed(false);

      const quote = await h.service.quote(ONE_A);

      expect(quote.kind).toBe('ok');
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
    });

    it('quotes as before when the read gives no verdict (the server still bounds a new return)', async () => {
      const returnId = await closed();
      statusAnswers(503);

      const quote = await h.service.quote(ONE_A);

      expect(quote.kind).toBe('ok');
      expect(h.dispositions.stateOf(returnId)).toBe('closed');
    });
  });

  describe('a void of the same sale is quoted (checkSaleLive)', () => {
    it('raises the late commit, so the void guard sees a live return again', async () => {
      const returnId = await closed();
      const saleId = h.repo.read(returnId)?.saleId ?? '';
      expect(voidBlocked(saleId)).toBe(false);

      await h.checkSaleLive(saleId);

      expect(h.dispositions.stateOf(returnId)).toBe('late_commit');
      expect(voidBlocked(saleId)).toBe(true);
    });

    it('reads nothing for a cashier (best effort: the sweep covers it)', async () => {
      const returnId = await closed();
      const saleId = h.repo.read(returnId)?.saleId ?? '';
      h.state.role = 'cashier';
      const reads = h.backend.statusCalls().length;

      await h.checkSaleLive(saleId);

      expect(h.backend.statusCalls()).toHaveLength(reads);
      expect(voidBlocked(saleId)).toBe(false);
    });

    it('reads nothing for a sale with no closed return', async () => {
      setup();
      const reads = h.backend.statusCalls().length;

      await h.checkSaleLive('sale-without-returns');

      expect(h.backend.statusCalls()).toHaveLength(reads);
    });
  });
});

describe('RT-1498 return_journal_origin on close and mismatch', () => {
  const SARA = '0190f5a2-3b4c-7d8e-9f01-00000000000c';
  const SARA_REF = 'ref-sara';

  it('captures originator atomically, refuses originator PIN & spend, and omits origin_user_unknown on close audit', async () => {
    const { createReturnOriginRepository } = await import('../returns-origin-repository.js');
    const { spendResolveApproval } = await import('../returns-resolve-approval.js');
    const closePins: Pick<ManagerPinStore, 'verify' | 'list'> = {
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
    userId = SARA;
    availability = createStatusReadAvailability();
    h = returnsHarness({
      role: 'manager',
      statusAvailability: availability,
      actorUserId: () => userId,
      escalation: ({ handle, state }) => {
        const origins = createReturnOriginRepository(handle);
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
          managerPins: closePins,
          resolvers: {
            [RETURN_RESOLVE_ACTION_KIND]: createReturnResolveApprovalResolver({
              repo: createReturnsRepository(handle),
              dispositions: createReturnDispositionsRepository(handle),
              terminalId: () => state.terminalId,
              closeAvailable: () => availability.isAvailable(),
              originUserIdOf: (id) => origins.originUserIdOf(id),
            }),
          },
          now: () => state.now,
        });
        return { approvals, userId: () => userId };
      },
    });
    seedSyncedSale(h.db);

    const returnId = await unknownReturn();
    expect(createReturnOriginRepository(h.handle).originUserIdOf(returnId)).toBe(SARA);

    // Move to requester Mona, elapse quiet period, readStatus -> not_recorded.
    userId = MONA;
    elapse(h, QUIET + 1_000);
    const read = await h.service.readStatus({ returnId });
    expect(read).toMatchObject({ kind: 'not_recorded', close: { ready: true } });

    // Originator Sara's PIN is refused via approval_unavailable.
    const denied = await approvals.request({
      action_kind: RETURN_RESOLVE_ACTION_KIND,
      subject_ref: resolveSubjectRef(returnId, 'close'),
      reason_code: 'close_unknown',
      approver_ref: SARA_REF,
      pin: PIN,
    });
    expect(denied).toEqual({ kind: 'refused', reason: 'approval_unavailable' });

    // Omar approves, spendResolveApproval refuses if originUserId is passed as Omar, and a fresh approval closes cleanly with true origin Sara.
    const badSpendApproval = await approve(returnId, 'close');
    const entry = h.repo.read(returnId);
    if (entry === null) throw new Error('expected journal entry');
    expect(
      spendResolveApproval(
        { approvals, userId: () => userId },
        { operatorId: 'op-manager', scope: SCOPE },
        badSpendApproval,
        entry,
        'close',
        OMAR,
      ),
    ).toEqual({ kind: 'refused', reason: 'approval_invalid' });

    const approvalId = await approve(returnId, 'close');
    const closed = await h.service.close({ returnId, approvalId });
    expect(closed.kind).toBe('closed');
    const event = h.audits.find((a) => a.action_category === 'sale.return.closed_not_recorded');
    expect(event?.payload).toEqual({
      return_id: returnId,
      approval_id: approvalId,
      read_verdict_at: h.state.now,
    });
  });

  it('omits origin_user_unknown on mismatch needs_support when return originator is known', async () => {
    const { createReturnOriginRepository } = await import('../returns-origin-repository.js');
    userId = SARA;
    availability = createStatusReadAvailability();
    h = returnsHarness({
      role: 'manager',
      statusAvailability: availability,
      actorUserId: () => userId,
    });
    seedSyncedSale(h.db);

    const returnId = await recordedButUnknownReturn();
    expect(createReturnOriginRepository(h.handle).originUserIdOf(returnId)).toBe(SARA);

    h.backend.onStatus = (call, backend) => {
      const key = new URL(call.url).searchParams.get('externalId') ?? '';
      return jsonResponse(200, {
        status: 'recorded',
        creditLinked: true,
        saleReturn: backend.recorded.get(key),
      });
    };
    const res = await h.service.readStatus({ returnId });
    expect(res).toMatchObject({ kind: 'recorded', outcome: 'support' });
    const event = h.audits.find((a) => a.action_category === 'sale.return.needs_support');
    expect(event?.payload).toEqual({
      return_id: returnId,
      approval_id: null,
      verdict_source: 'provenance_read',
      reason: 'mismatch',
    });
  });
});
