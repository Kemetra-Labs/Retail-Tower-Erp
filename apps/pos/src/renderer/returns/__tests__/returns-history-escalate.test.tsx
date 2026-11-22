import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { resolveSubjectRef } from '../../../main/returns/returns-resolve-approval.js';
import type { ReturnJournalView } from '../../../shared/returns/types.js';
import {
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
 * RT-1498 S4/S5 (PROPOSED Arabic copy, pending owner review) — handing an unresolved return to
 * support from the journal: «تحويل إلى الدعم» opens a manager-PIN sheet (another manager approves,
 * RT-114); the approval is bound to THIS return and to the disposition `escalate`; main spends it.
 * The renderer names only the return id and the approval id, and never decides an outcome.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-0000000000e1';

const UNKNOWN = journal({
  returnId: RETURN_ID,
  saleNumber: 'T1-000002',
  state: 'unknown',
  quotedTotalMinor: 700,
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 4,
  lastAttemptAt: '2026-10-04T09:20:00.000Z',
  lastCause: 'confirmation_mismatch',
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
const SENT_PENDING = journal({
  returnId: 'sent-pen',
  saleNumber: 'T1-000006',
  state: 'pending',
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 1,
  lastCause: null,
});
const SUPPORT = journal({
  returnId: 'sup',
  saleNumber: 'T1-000007',
  state: 'unknown',
  returnTotalMinor: null,
  returnRef: null,
  confirmedAt: null,
  attemptCount: 2,
  lastCause: 'confirmation_mismatch',
  disposition: 'needs_support',
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

const ESCALATE = ESCALATE_COPY.action;

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

const rowOf = (saleNumber: string): HTMLElement =>
  within(history())
    .getAllByRole('row')
    .find((r) => r.textContent.includes(saleNumber)) as HTMLElement;

describe('the action «تحويل إلى الدعم» on a journal row', () => {
  it('is offered on a sent unresolved return (unknown, or pending that was sent) only', async () => {
    await mount([UNKNOWN, NEVER_SENT, SENT_PENDING, SUPPORT, CLOSED, CONFIRMED, PAID, REFUSED]);
    const offered = within(history())
      .getAllByRole('button', { name: new RegExp(ESCALATE) })
      .map((b) => b.getAttribute('aria-label'));
    expect(offered).toEqual([`${ESCALATE} T1-000002`, `${ESCALATE} T1-000006`]);
  });

  it('is not offered at all without the manager approval bridge', async () => {
    await mount([UNKNOWN], { approval: false });
    expect(
      within(history()).queryByRole('button', { name: new RegExp(ESCALATE) }),
    ).not.toBeInTheDocument();
    // The per-row resend of RT-1498 is unaffected.
    expect(
      within(history()).getByRole('button', { name: `${UNRESOLVED_COPY.resend} T1-000002` }),
    ).toBeInTheDocument();
  });

  it('opens a sheet naming the sale and the amount, and calls nothing yet', async () => {
    const { bridge, approval, user } = await mount();
    await user.click(within(history()).getByRole('button', { name: `${ESCALATE} T1-000002` }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(ESCALATE_COPY.title);
    expect(dialog).toHaveTextContent('T1-000002');
    expect(approval.listApprovers).toHaveBeenCalledWith({ action_kind: 'return.resolve_unknown' });
    expect(approval.request).not.toHaveBeenCalled();
    expect(bridge.escalate).not.toHaveBeenCalled();
  });

  it('«رجوع» closes the sheet without any call', async () => {
    const { bridge, approval, user } = await mount();
    await user.click(within(history()).getByRole('button', { name: `${ESCALATE} T1-000002` }));
    await user.click(await screen.findByRole('button', { name: 'رجوع' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(approval.request).not.toHaveBeenCalled();
    expect(bridge.escalate).not.toHaveBeenCalled();
  });
});

describe('the approval sheet binds the disposition', () => {
  async function open(rows: ReturnJournalView[] = [UNKNOWN]) {
    const ctx = await mount(rows);
    await ctx.user.click(within(history()).getByRole('button', { name: `${ESCALATE} T1-000002` }));
    await screen.findByRole('dialog');
    return ctx;
  }

  const commit = () => screen.getByRole('button', { name: ESCALATE_COPY.approve });

  async function chooseManagerAndPin(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByLabelText(APPROVER.display_name));
    await user.type(await screen.findByLabelText('الرقم السري للمدير'), APPROVER_PIN);
  }

  it('stays disabled until a manager and a PIN are set', async () => {
    const { user } = await open();
    expect(commit()).toBeDisabled();
    await chooseManagerAndPin(user);
    expect(commit()).toBeEnabled();
  });

  it('asks for an approval of THIS return for the escalate disposition, then escalates with it', async () => {
    const { bridge, approval, user } = await open();
    await chooseManagerAndPin(user);
    await user.click(commit());

    await waitFor(() => {
      expect(bridge.escalate).toHaveBeenCalledTimes(1);
    });
    expect(approval.request).toHaveBeenCalledWith({
      action_kind: 'return.resolve_unknown',
      subject_ref: `${RETURN_ID}_escalate`,
      reason_code: 'escalate_unknown',
      approver_ref: APPROVER.approver_ref,
      pin: APPROVER_PIN,
    });
    expect(bridge.escalate).toHaveBeenCalledWith({ returnId: RETURN_ID, approvalId: APPROVAL_ID });
  });

  it('builds the same subject ref as main does (renderer and main agree)', () => {
    expect(`${RETURN_ID}_escalate`).toBe(resolveSubjectRef(RETURN_ID, 'escalate'));
  });

  it('on success: closes the sheet, says what main recorded, names the sale, and re-reads the journal', async () => {
    const { bridge, user } = await open();
    await chooseManagerAndPin(user);
    await user.click(commit());

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const notice = await within(history()).findByRole('status');
    expect(notice).toHaveTextContent('T1-000002');
    expect(notice).toHaveTextContent(ESCALATE_COPY.raised);
    expect(bridge.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('never reaches the escalation when the approval is refused, and names the four-eyes rule', async () => {
    const { bridge, approval, user } = await open();
    approval.request.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_unavailable' });
    await chooseManagerAndPin(user);
    await user.click(commit());

    expect(await screen.findByRole('alert')).toHaveTextContent(ESCALATE_COPY.approvalUnavailable);
    expect(bridge.escalate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows any other approval refusal with its own message', async () => {
    const { approval, user } = await open();
    approval.request.mockResolvedValueOnce({ kind: 'refused', reason: 'approval_invalid' });
    await chooseManagerAndPin(user);
    await user.click(commit());
    expect(await screen.findByRole('alert')).toHaveTextContent(refusalMessage('approval_invalid'));
  });

  it('shows main’s refusal of the escalation, keeps the sheet open and re-reads the journal', async () => {
    const { bridge, user } = await open();
    bridge.escalate.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'approval_stale',
      ret: UNKNOWN,
    });
    await chooseManagerAndPin(user);
    await user.click(commit());

    expect(await screen.findByRole('alert')).toHaveTextContent(refusalMessage('approval_stale'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(history()).queryByRole('status')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('a lost call is named, never success', async () => {
    const { bridge, user } = await open();
    bridge.escalate.mockRejectedValueOnce(new Error('locked'));
    await chooseManagerAndPin(user);
    await user.click(commit());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(within(history()).queryByRole('status')).not.toBeInTheDocument();
  });

  it('one escalation at a time: the commit is held while main answers', async () => {
    const { bridge, user } = await open();
    const pending = deferred<Awaited<ReturnType<typeof bridge.escalate>>>();
    bridge.escalate.mockReturnValueOnce(pending.promise);
    await chooseManagerAndPin(user);
    await user.click(commit());
    await waitFor(() => {
      expect(bridge.escalate).toHaveBeenCalledTimes(1);
    });
    expect(commit()).toBeDisabled();
    await settle(pending, { kind: 'escalated', ret: null });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(bridge.escalate).toHaveBeenCalledTimes(1);
  });
});

describe('a return with a disposition', () => {
  it('needs_support: «بانتظار الدعم», no escalate, no automatic-check bar, resend still there', async () => {
    await mount([SUPPORT]);
    const row = rowOf('T1-000007');
    expect(row).toHaveTextContent(DISPOSITION_COPY.label.needs_support);
    expect(row).toHaveTextContent(DISPOSITION_COPY.supportDetail);
    expect(row).toHaveTextContent(UNRESOLVED_COPY.doNotPay);
    expect(
      within(row).queryByRole('button', { name: new RegExp(ESCALATE) }),
    ).not.toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: `${UNRESOLVED_COPY.resend} T1-000007` }),
    ).toBeInTheDocument();
    // The resolver skips it, so the bar «تحقّق من غير المؤكدة» has nothing to check.
    expect(
      within(history()).queryByRole('button', { name: 'تحقّق من غير المؤكدة' }),
    ).not.toBeInTheDocument();
  });

  it('closed: «لم يُسجَّل — مغلق», its own line, and only the server status read (the late-commit check)', async () => {
    await mount([CLOSED]);
    const row = rowOf('T1-000008');
    expect(row).toHaveTextContent(DISPOSITION_COPY.label.closed);
    expect(row).toHaveTextContent(DISPOSITION_COPY.closedDetail);
    expect(row).not.toHaveTextContent(UNRESOLVED_COPY.doNotPay);
    // No resend, no escalation, no close: a closed return is never sent again. Only «تحديث الحالة»,
    // the one way a late commit of its key can be seen (RT-1548).
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([`${STATUS_COPY.action} T1-000008`]);
    expect(row).not.toHaveTextContent(OUTCOME_COPY.unconfirmed);
  });

  it('a plain unknown row still shows the bar next to rows with a disposition', async () => {
    await mount([UNKNOWN, SUPPORT]);
    expect(
      within(history()).getByRole('button', { name: 'تحقّق من غير المؤكدة' }),
    ).toBeInTheDocument();
  });
});
