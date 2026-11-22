import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { resolveSubjectRef } from '../../../main/returns/returns-resolve-approval.js';
import type {
  ReturnJournalView,
  ReturnsReadStatusResponse,
} from '../../../shared/returns/types.js';
import { expectNoAxeViolations } from '../../test-utils/axe-config.js';
import { formatReturnTime } from '../returns-format.js';
import {
  CLOSE_COPY,
  DISPOSITION_COPY,
  ESCALATE_COPY,
  OUTCOME_COPY,
  STATUS_COPY,
  UNRESOLVED_COPY,
  refusalMessage,
} from '../returns-messages.js';
import {
  APPROVAL_ID,
  APPROVER,
  APPROVER_PIN,
  deferred,
  fakeApproval,
  fakeBridge,
  journal,
  renderReturns,
  resetStores,
  settle,
} from './returns-test-kit.js';

/**
 * RT-1498 close slice (PROPOSED Arabic copy, pending owner review) — the server status read
 * («تحديث الحالة») and the close («إغلاق كمرتجع غير مسجَّل») from the journal.
 *   • the renderer names only the return id (and the approval id), and never decides a verdict: it
 *     shows what main answered, and re-reads the journal after any answer;
 *   • «إغلاق» is offered only after a read that answered an affirmative "not recorded" with the quiet
 *     period over, and only for that return, while its last attempt is still the one the read covered;
 *   • the close is confirmed by ANOTHER manager's PIN, bound to THIS return and to `close`.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-0000000000e1';
const ATTEMPT = '2026-10-04T09:20:00.000Z';

const UNKNOWN = journal({
  returnId: RETURN_ID,
  saleNumber: 'T1-000002',
  state: 'unknown',
  quotedTotalMinor: 700,
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 2,
  lastAttemptAt: ATTEMPT,
  lastCause: 'timeout',
});
const OTHER = journal({
  returnId: 'other',
  saleNumber: 'T1-000009',
  state: 'unknown',
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 1,
  lastAttemptAt: ATTEMPT,
  lastCause: 'timeout',
});
const NEVER_SENT = journal({
  returnId: 'pen',
  saleNumber: 'T1-000003',
  state: 'pending',
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 0,
  lastAttemptAt: null,
  lastCause: null,
});
const CLOSED = journal({
  returnId: 'clo',
  saleNumber: 'T1-000008',
  state: 'unknown',
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 2,
  lastCause: 'timeout',
  disposition: 'closed',
});
const CONFIRMED = journal({ returnId: 'ok', saleNumber: 'T1-000001', state: 'confirmed' });
const PAID = journal({ returnId: 'paid', saleNumber: 'T1-000004', state: 'paid_out' });
const REFUSED = journal({
  returnId: 'ref',
  saleNumber: 'T1-000005',
  state: 'refused',
  returnRef: null,
  returnTotalMinor: null,
  refusalReason: 'over_return',
});

const STATUS = STATUS_COPY.action;
const CLOSE = CLOSE_COPY.action;

function history(): HTMLElement {
  return screen.getByRole('region', { name: 'سجل المرتجعات على هذا الجهاز' });
}

async function mount(rows: ReturnJournalView[] = [UNKNOWN], options: { approval?: boolean } = {}) {
  const bridge = fakeBridge();
  bridge.list.mockResolvedValue({ kind: 'ok', returns: rows });
  const approval = fakeApproval();
  const user = userEvent.setup();
  renderReturns({ bridge, approval: options.approval === false ? null : approval });
  await within(history()).findAllByRole('row');
  return { bridge, approval, user };
}

const READY: ReturnsReadStatusResponse = {
  kind: 'not_recorded',
  ret: UNKNOWN,
  close: { ready: true },
};

/** Read the status of the UNKNOWN row and wait for the notice. */
async function readStatus(ctx: Awaited<ReturnType<typeof mount>>, saleNumber = 'T1-000002') {
  await ctx.user.click(within(history()).getByRole('button', { name: `${STATUS} ${saleNumber}` }));
  // A notice is a `status` (info) or an `alert` (warning, danger), by its tone.
  return await waitFor(() => {
    const notice = [
      ...within(history()).queryAllByRole('status'),
      ...within(history()).queryAllByRole('alert'),
    ].find((n) => n.textContent.includes(saleNumber));
    if (notice === undefined) throw new Error('no notice yet');
    return notice;
  });
}

describe('the action «تحديث الحالة» on a journal row', () => {
  it('is offered on a sent unresolved return, and on a closed one (the late-commit check), nowhere else', async () => {
    await mount([UNKNOWN, NEVER_SENT, CLOSED, CONFIRMED, PAID, REFUSED]);
    const offered = within(history())
      .getAllByRole('button', { name: new RegExp(STATUS) })
      .map((b) => b.getAttribute('aria-label'));
    expect(offered).toEqual([`${STATUS} T1-000002`, `${STATUS} T1-000008`]);
  });

  it('is the spec label «تحديث الحالة»', () => {
    expect(STATUS_COPY.action).toBe('تحديث الحالة');
    expect(CLOSE_COPY.action).toBe('إغلاق كمرتجع غير مسجَّل');
  });

  it('asks main for THIS return only, with nothing else, and re-reads the journal', async () => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue({
      kind: 'inconclusive',
      ret: UNKNOWN,
      cause: 'offline',
    });
    const lists = ctx.bridge.list.mock.calls.length;
    await readStatus(ctx);
    expect(ctx.bridge.readStatus).toHaveBeenCalledTimes(1);
    expect(ctx.bridge.readStatus).toHaveBeenCalledWith({ returnId: RETURN_ID });
    expect(ctx.bridge.resend).not.toHaveBeenCalled();
    expect(ctx.bridge.resolve).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(ctx.bridge.list.mock.calls.length).toBeGreaterThan(lists);
    });
  });
});

describe('what the read shows (the server’s words, never an inference)', () => {
  it.each<[string, ReturnsReadStatusResponse, string]>([
    [
      'an affirmative not_recorded with the period over',
      { kind: 'not_recorded', ret: UNKNOWN, close: { ready: true } },
      STATUS_COPY.readNotRecordedReady,
    ],
    [
      'an affirmative not_recorded while the period runs: when it ends',
      {
        kind: 'not_recorded',
        ret: UNKNOWN,
        close: { ready: false, reason: 'too_soon', notBefore: '2026-10-04T09:35:00.000Z' },
      },
      STATUS_COPY.readNotRecordedWait(formatReturnTime('2026-10-04T09:35:00.000Z')),
    ],
    [
      'a not_recorded whose period this POS cannot show',
      { kind: 'not_recorded', ret: UNKNOWN, close: { ready: false, reason: 'unproven' } },
      refusalMessage('quiet_period_unproven'),
    ],
    [
      'a recorded return that is this one: resend to confirm',
      { kind: 'recorded', ret: UNKNOWN, outcome: 'resend' },
      STATUS_COPY.readRecordedResend,
    ],
    [
      'a recorded return that is not this one: handed to support',
      { kind: 'recorded', ret: UNKNOWN, outcome: 'support' },
      STATUS_COPY.readRecordedSupport,
    ],
    [
      'a refusal main made',
      { kind: 'refused', reason: 'send_in_flight', ret: UNKNOWN },
      refusalMessage('send_in_flight'),
    ],
    [
      'a 404 (the server read is off): unavailable, never a verdict',
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'unavailable' },
      refusalMessage('returns_unavailable'),
    ],
    [
      'no connection',
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'offline' },
      refusalMessage('offline'),
    ],
    [
      'a refused credential',
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'unauthorized' },
      refusalMessage('read_unauthorized'),
    ],
    [
      'a server error',
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'server' },
      STATUS_COPY.readNoVerdict,
    ],
    [
      'an unreadable answer',
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'unreadable' },
      STATUS_COPY.readNoVerdict,
    ],
  ])('%s', async (_name, answer, expected) => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(answer);
    const notice = await readStatus(ctx);
    expect(notice).toHaveTextContent('T1-000002');
    expect(notice).toHaveTextContent(expected);
  });

  it('a late commit on a closed return says so and sends the manager to support', async () => {
    const ctx = await mount([CLOSED]);
    ctx.bridge.readStatus.mockResolvedValue({
      kind: 'recorded',
      ret: CLOSED,
      outcome: 'late_commit',
    });
    const notice = await readStatus(ctx, 'T1-000008');
    expect(notice).toHaveTextContent(STATUS_COPY.readLateCommit);
    expect(notice).toHaveAttribute('data-tone', 'danger');
  });

  it('a closed return that is still not recorded says it is closed', async () => {
    const ctx = await mount([CLOSED]);
    ctx.bridge.readStatus.mockResolvedValue({
      kind: 'not_recorded',
      ret: CLOSED,
      close: { ready: false, reason: 'closed' },
    });
    expect(await readStatus(ctx, 'T1-000008')).toHaveTextContent(STATUS_COPY.readNotRecordedClosed);
  });

  it.each<[string, ReturnsReadStatusResponse]>([
    ['the period is over', { kind: 'not_recorded', ret: UNKNOWN, close: { ready: true } }],
    [
      'the period is running',
      {
        kind: 'not_recorded',
        ret: UNKNOWN,
        close: { ready: false, reason: 'too_soon', notBefore: '2026-10-04T09:35:00.000Z' },
      },
    ],
    [
      'the period cannot be shown',
      { kind: 'not_recorded', ret: UNKNOWN, close: { ready: false, reason: 'unproven' } },
    ],
  ])('an affirmative not_recorded says automatic resends stopped (%s)', async (_n, answer) => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(answer);
    expect(await readStatus(ctx)).toHaveTextContent(STATUS_COPY.readHeldNote);
  });

  it('a read that wrote no hold (recorded, no verdict, closed) does not say so', async () => {
    const answers: ReturnsReadStatusResponse[] = [
      { kind: 'recorded', ret: UNKNOWN, outcome: 'resend' },
      { kind: 'inconclusive', ret: UNKNOWN, cause: 'server' },
    ];
    for (const answer of answers) {
      cleanup();
      const ctx = await mount();
      ctx.bridge.readStatus.mockResolvedValue(answer);
      expect(await readStatus(ctx)).not.toHaveTextContent(STATUS_COPY.readHeldNote);
    }
    cleanup();
    const closed = await mount([CLOSED]);
    closed.bridge.readStatus.mockResolvedValue({
      kind: 'not_recorded',
      ret: CLOSED,
      close: { ready: false, reason: 'closed' },
    });
    expect(await readStatus(closed, 'T1-000008')).not.toHaveTextContent(STATUS_COPY.readHeldNote);
  });

  it('no line of the read calls a return paid, and a server answer is never called success', async () => {
    const lines = [
      STATUS_COPY.readNotRecordedReady,
      STATUS_COPY.readNotRecordedWait('10:00'),
      STATUS_COPY.readNotRecordedClosed,
      STATUS_COPY.readHeldNote,
      STATUS_COPY.readRecordedResend,
      STATUS_COPY.readRecordedSupport,
      STATUS_COPY.readLateCommit,
      STATUS_COPY.readNoVerdict,
    ];
    for (const line of lines) expect(line).not.toContain('تم الصرف');
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(READY);
    expect(await readStatus(ctx)).toHaveAttribute('data-tone', 'info');
  });

  it('a lost call is named, never a verdict', async () => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockRejectedValue(new Error('locked'));
    await ctx.user.click(within(history()).getByRole('button', { name: `${STATUS} T1-000002` }));
    expect(await within(history()).findByRole('alert')).toHaveTextContent(OUTCOME_COPY.callFailed);
    expect(within(history()).queryByRole('button', { name: new RegExp(CLOSE) })).toBeNull();
  });

  it('one call at a time: every action on an unresolved return waits while main reads', async () => {
    const ctx = await mount([UNKNOWN, OTHER]);
    const pending = deferred<ReturnsReadStatusResponse>();
    ctx.bridge.readStatus.mockReturnValueOnce(pending.promise);
    await ctx.user.click(within(history()).getByRole('button', { name: `${STATUS} T1-000002` }));
    await waitFor(() => {
      expect(ctx.bridge.readStatus).toHaveBeenCalledTimes(1);
    });
    expect(within(history()).getByRole('button', { name: `${STATUS} T1-000009` })).toBeDisabled();
    expect(
      within(history()).getByRole('button', { name: `${UNRESOLVED_COPY.resend} T1-000002` }),
    ).toBeDisabled();
    expect(within(history()).getByRole('button', { name: 'تحقّق من غير المؤكدة' })).toBeDisabled();
    await settle(pending, { kind: 'inconclusive', ret: UNKNOWN, cause: 'offline' });
    await waitFor(() => {
      expect(within(history()).getByRole('button', { name: `${STATUS} T1-000009` })).toBeEnabled();
    });
    expect(ctx.bridge.readStatus).toHaveBeenCalledTimes(1);
  });
});

describe('the action «إغلاق كمرتجع غير مسجَّل»', () => {
  const closeButton = (saleNumber = 'T1-000002') =>
    within(history()).queryByRole('button', { name: `${CLOSE} ${saleNumber}` });

  it('is not offered before any read', async () => {
    await mount();
    expect(closeButton()).not.toBeInTheDocument();
  });

  it('is offered only for the return a read found ready, not for another row', async () => {
    const ctx = await mount([UNKNOWN, OTHER]);
    ctx.bridge.readStatus.mockResolvedValue(READY);
    await readStatus(ctx);
    expect(
      await within(history()).findByRole('button', { name: `${CLOSE} T1-000002` }),
    ).toBeInTheDocument();
    expect(closeButton('T1-000009')).not.toBeInTheDocument();
  });

  it.each<[string, ReturnsReadStatusResponse]>([
    [
      'the period is still running',
      {
        kind: 'not_recorded',
        ret: UNKNOWN,
        close: { ready: false, reason: 'too_soon', notBefore: '2026-10-04T09:35:00.000Z' },
      },
    ],
    [
      'the period cannot be shown',
      { kind: 'not_recorded', ret: UNKNOWN, close: { ready: false, reason: 'unproven' } },
    ],
    ['the server has the return', { kind: 'recorded', ret: UNKNOWN, outcome: 'resend' }],
    ['the server answered 404', { kind: 'inconclusive', ret: UNKNOWN, cause: 'unavailable' }],
    ['the server gave no verdict', { kind: 'inconclusive', ret: UNKNOWN, cause: 'server' }],
    ['main refused the read', { kind: 'refused', reason: 'never_sent', ret: UNKNOWN }],
  ])('is not offered when %s', async (_name, answer) => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(answer);
    await readStatus(ctx);
    expect(closeButton()).not.toBeInTheDocument();
  });

  it('goes away when a later attempt of the return makes the read stale', async () => {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(READY);
    await readStatus(ctx);
    expect(
      await within(history()).findByRole('button', { name: `${CLOSE} T1-000002` }),
    ).toBeInTheDocument();
    // The next listing shows a newer last attempt (the return was sent again).
    ctx.bridge.list.mockResolvedValue({
      kind: 'ok',
      returns: [{ ...UNKNOWN, attemptCount: 3, lastAttemptAt: '2026-10-04T09:40:00.000Z' }],
    });
    await ctx.user.click(
      within(history()).getByRole('button', { name: `${UNRESOLVED_COPY.resend} T1-000002` }),
    );
    await waitFor(() => {
      expect(closeButton()).not.toBeInTheDocument();
    });
  });

  it('is not offered at all without the manager approval bridge', async () => {
    const ctx = await mount([UNKNOWN], { approval: false });
    ctx.bridge.readStatus.mockResolvedValue(READY);
    await readStatus(ctx);
    expect(closeButton()).not.toBeInTheDocument();
    expect(
      within(history()).getByRole('button', { name: `${STATUS} T1-000002` }),
    ).toBeInTheDocument();
  });

  it('is never offered on a closed return, even after a read that says so', async () => {
    const ctx = await mount([CLOSED]);
    ctx.bridge.readStatus.mockResolvedValue({
      kind: 'not_recorded',
      ret: CLOSED,
      close: { ready: true },
    });
    await readStatus(ctx, 'T1-000008');
    expect(closeButton('T1-000008')).not.toBeInTheDocument();
  });
});

describe('the close sheet binds the disposition', () => {
  async function open() {
    const ctx = await mount();
    ctx.bridge.readStatus.mockResolvedValue(READY);
    await readStatus(ctx);
    await ctx.user.click(
      await within(history()).findByRole('button', { name: `${CLOSE} T1-000002` }),
    );
    await screen.findByRole('dialog');
    return ctx;
  }

  const commit = () => screen.getByRole('button', { name: CLOSE_COPY.approve });

  async function chooseManagerAndPin(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByLabelText(APPROVER.display_name));
    await user.type(await screen.findByLabelText('الرقم السري للمدير'), APPROVER_PIN);
  }

  it('opens a sheet naming the sale, and calls nothing yet', async () => {
    const { bridge, approval } = await open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(CLOSE_COPY.title);
    expect(dialog).toHaveTextContent('T1-000002');
    expect(approval.listApprovers).toHaveBeenCalledWith({ action_kind: 'return.resolve_unknown' });
    expect(approval.request).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('«رجوع» closes the sheet without any call', async () => {
    const { bridge, approval, user } = await open();
    await user.click(screen.getByRole('button', { name: 'رجوع' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(approval.request).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it('stays disabled until a manager and a PIN are set', async () => {
    const { user } = await open();
    expect(commit()).toBeDisabled();
    await chooseManagerAndPin(user);
    expect(commit()).toBeEnabled();
  });

  it('asks for an approval of THIS return for the CLOSE disposition, then closes with it', async () => {
    const { bridge, approval, user } = await open();
    await chooseManagerAndPin(user);
    await user.click(commit());

    await waitFor(() => {
      expect(bridge.close).toHaveBeenCalledTimes(1);
    });
    expect(approval.request).toHaveBeenCalledWith({
      action_kind: 'return.resolve_unknown',
      subject_ref: `${RETURN_ID}_close`,
      reason_code: 'close_unknown',
      approver_ref: APPROVER.approver_ref,
      pin: APPROVER_PIN,
    });
    expect(bridge.close).toHaveBeenCalledWith({ returnId: RETURN_ID, approvalId: APPROVAL_ID });
    // Never the escalation.
    expect(bridge.escalate).not.toHaveBeenCalled();
  });

  it('builds the same subject ref as main does (renderer and main agree)', () => {
    expect(`${RETURN_ID}_close`).toBe(resolveSubjectRef(RETURN_ID, 'close'));
    expect(`${RETURN_ID}_close`).not.toBe(resolveSubjectRef(RETURN_ID, 'escalate'));
  });

  it('on success: closes the sheet, says what main recorded, names the sale, and re-reads the journal', async () => {
    const { bridge, user } = await open();
    await chooseManagerAndPin(user);
    await user.click(commit());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const notices = await within(history()).findAllByRole('status');
    const closed = notices.find((n) => n.textContent.includes(DISPOSITION_COPY.closedDetail));
    expect(closed).toHaveTextContent('T1-000002');
    expect(bridge.list.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('never reaches the close when the approval is refused, and names the four-eyes rule', async () => {
    const { bridge, approval, user } = await open();
    approval.request.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_unavailable' });
    await chooseManagerAndPin(user);
    await user.click(commit());

    expect(await screen.findByRole('alert')).toHaveTextContent(CLOSE_COPY.approvalUnavailable);
    expect(bridge.close).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names a locked-out approver with the close wording, never the escalation’s', async () => {
    const { approval, user } = await open();
    approval.request.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_attempts_exhausted',
    });
    await chooseManagerAndPin(user);
    await user.click(commit());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(CLOSE_COPY.attemptsExhausted);
    expect(alert).not.toHaveTextContent(ESCALATE_COPY.attemptsExhausted);
  });

  it.each(['session_locked', 'no_session', 'x'])(
    'shows any other approval refusal (%s) with the close line',
    async (reason) => {
      const { approval, user } = await open();
      approval.request.mockResolvedValueOnce({ kind: 'refused', reason } as never);
      await chooseManagerAndPin(user);
      await user.click(commit());
      expect(await screen.findByRole('alert')).toHaveTextContent(CLOSE_COPY.approvalFailed);
    },
  );

  it('shows main’s refusal of the close, keeps the sheet open and re-reads the journal', async () => {
    const { bridge, user } = await open();
    bridge.close.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'close_needs_not_recorded',
      ret: UNKNOWN,
    });
    await chooseManagerAndPin(user);
    await user.click(commit());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      refusalMessage('close_needs_not_recorded'),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.list.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it.each([
    'reconcile_too_soon',
    'quiet_period_unproven',
    'returns_unavailable',
    'offline',
  ] as const)('shows main’s %s as its own line', async (reason) => {
    const { bridge, user } = await open();
    bridge.close.mockResolvedValueOnce({ kind: 'refused', reason, ret: UNKNOWN });
    await chooseManagerAndPin(user);
    await user.click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(refusalMessage(reason));
  });

  it('a lost call is named, never success', async () => {
    const { bridge, user } = await open();
    bridge.close.mockRejectedValueOnce(new Error('locked'));
    await chooseManagerAndPin(user);
    await user.click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(OUTCOME_COPY.callFailed);
    const closedNotice = within(history())
      .queryAllByRole('status')
      .find((n) => n.textContent.includes(DISPOSITION_COPY.closedDetail));
    expect(closedNotice).toBeUndefined();
  });

  it('one close at a time: the commit is held while main answers', async () => {
    const { bridge, user } = await open();
    const pending = deferred<Awaited<ReturnType<typeof bridge.close>>>();
    bridge.close.mockReturnValueOnce(pending.promise);
    await chooseManagerAndPin(user);
    await user.click(commit());
    await waitFor(() => {
      expect(bridge.close).toHaveBeenCalledTimes(1);
    });
    expect(commit()).toBeDisabled();
    await settle(pending, { kind: 'closed', ret: null });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });
});

describe('copy and accessibility', () => {
  it('the close and status lines are Arabic, distinct from each other and from every other line', () => {
    const own = [
      STATUS_COPY.readNotRecordedReady,
      STATUS_COPY.readNotRecordedWait('10:00'),
      STATUS_COPY.readNotRecordedClosed,
      STATUS_COPY.readHeldNote,
      STATUS_COPY.readRecordedResend,
      STATUS_COPY.readRecordedSupport,
      STATUS_COPY.readLateCommit,
      STATUS_COPY.readNoVerdict,
      CLOSE_COPY.title,
      CLOSE_COPY.body,
      CLOSE_COPY.approve,
      CLOSE_COPY.approvalUnavailable,
      CLOSE_COPY.attemptsExhausted,
      CLOSE_COPY.approvalFailed,
    ];
    expect(new Set(own).size).toBe(own.length);
    for (const line of own) expect(line).toMatch(/[؀-ۿ]/);
    for (const line of own) expect(line).not.toContain('—');
    const others = new Set<string>([
      ...Object.values(ESCALATE_COPY),
      ...Object.values(DISPOSITION_COPY.label),
      DISPOSITION_COPY.closedDetail,
      DISPOSITION_COPY.supportDetail,
      UNRESOLVED_COPY.doNotPay,
    ]);
    expect(own.filter((line) => others.has(line))).toEqual([]);
  });

  it('the close sheet’s body says that no cash was paid', () => {
    expect(CLOSE_COPY.body).toContain('لم يُصرف أي نقد');
  });

  it('the journal with a read result has no axe violations', async () => {
    const ctx = await mount([UNKNOWN, CLOSED]);
    ctx.bridge.readStatus.mockResolvedValue(READY);
    await readStatus(ctx);
    await expectNoAxeViolations(history());
  });
});
