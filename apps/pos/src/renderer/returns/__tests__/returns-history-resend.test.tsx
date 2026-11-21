import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type { ReturnsResendResponse } from '../../../shared/returns/types.js';
import { OUTCOME_COPY, UNRESOLVED_COPY, refusalMessage } from '../returns-messages.js';
import { deferred, fakeBridge, journal, renderReturns, resetStores } from './returns-test-kit.js';

/**
 * RT-1498 (RT-196 S1 remainder + the history-only part of S6) — a per-row
 * «إعادة الإرسال» on an unresolved return, with its attempt history and cause.
 * The renderer names only the return id; it never decides an outcome.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const UNKNOWN = journal({
  returnId: 'unk',
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
const PENDING = journal({
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
const ROWS = [CONFIRMED, UNKNOWN, PENDING, PAID, REFUSED];

const RESEND = 'إعادة الإرسال';

function history(): HTMLElement {
  return screen.getByRole('region', { name: 'سجل المرتجعات على هذا الجهاز' });
}

async function mount(rows = ROWS) {
  const bridge = fakeBridge();
  bridge.list.mockResolvedValue({ kind: 'ok', returns: rows });
  const user = userEvent.setup();
  renderReturns({ bridge });
  await within(history()).findAllByRole('row');
  return { bridge, user };
}

describe('per-row resend (RT-1498)', () => {
  it('is offered on pending and unknown rows only', async () => {
    await mount();
    const buttons = within(history()).getAllByRole('button', { name: new RegExp(RESEND) });
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      `${RESEND} T1-000002`,
      `${RESEND} T1-000003`,
    ]);
  });

  it('sends exactly the return id of that row, then re-reads the journal', async () => {
    const { bridge, user } = await mount();
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    expect(bridge.resend).toHaveBeenCalledTimes(1);
    expect(bridge.resend).toHaveBeenCalledWith({ returnId: 'unk' });
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });

  it('confirmed: says the server registered it, from main answer, never from the click', async () => {
    const { bridge, user } = await mount();
    bridge.resend.mockResolvedValueOnce({
      kind: 'confirmed',
      ret: journal({ ...UNKNOWN, state: 'confirmed' }),
      replayed: false,
    });
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    expect(await within(history()).findByRole('status')).toHaveTextContent(OUTCOME_COPY.confirmed);
  });

  it('replayed confirmation says it was already registered', async () => {
    const { bridge, user } = await mount();
    bridge.resend.mockResolvedValueOnce({
      kind: 'confirmed',
      ret: journal({ ...UNKNOWN, state: 'confirmed' }),
      replayed: true,
    });
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    expect(await within(history()).findByRole('status')).toHaveTextContent(OUTCOME_COPY.replayed);
  });

  it('unconfirmed: stays named as unconfirmed, never as success or a decline', async () => {
    const { user } = await mount();
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    const notice = await within(history()).findByRole('alert');
    expect(notice).toHaveTextContent(OUTCOME_COPY.stillUnconfirmed);
    expect(notice).not.toHaveTextContent('مرفوض');
  });

  it('refused: shows main refusal copy', async () => {
    const { bridge, user } = await mount();
    bridge.resend.mockResolvedValueOnce({ kind: 'refused', reason: 'offline', ret: null });
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    const notice = await within(history()).findByRole('alert');
    expect(notice).toHaveTextContent(refusalMessage('offline'));
    // Several rows can be unresolved: the answer names the sale it is about.
    expect(notice).toHaveTextContent('T1-000002');
  });

  it('a rejected call is unknown, never success', async () => {
    const { bridge, user } = await mount();
    bridge.resend.mockRejectedValueOnce(new Error('locked'));
    await user.click(within(history()).getByRole('button', { name: `${RESEND} T1-000002` }));
    expect(await within(history()).findByRole('alert')).toHaveTextContent(
      OUTCOME_COPY.submitFailed,
    );
  });

  it('one resend at a time: a second click and the other rows are held while one is in flight', async () => {
    const { bridge, user } = await mount();
    const pending = deferred<ReturnsResendResponse>();
    bridge.resend.mockImplementationOnce(() => pending.promise);
    const first = within(history()).getByRole('button', { name: `${RESEND} T1-000002` });
    const other = within(history()).getByRole('button', { name: `${RESEND} T1-000003` });
    await user.dblClick(first);
    expect(bridge.resend).toHaveBeenCalledTimes(1);
    expect(first).toBeDisabled();
    expect(other).toBeDisabled();
    expect(within(history()).getByRole('button', { name: 'تحقّق من غير المؤكدة' })).toBeDisabled();
    pending.resolve({ kind: 'unconfirmed', ret: UNKNOWN });
    await waitFor(() => {
      expect(first).toBeEnabled();
    });
  });

  it('the bar check holds the per-row resend while it runs', async () => {
    const { bridge, user } = await mount();
    const pending = deferred<{
      kind: 'ok';
      confirmed: number;
      refused: number;
      unresolved: number;
    }>();
    bridge.resolve.mockImplementationOnce(() => pending.promise);
    await user.click(within(history()).getByRole('button', { name: 'تحقّق من غير المؤكدة' }));
    expect(within(history()).getByRole('button', { name: `${RESEND} T1-000002` })).toBeDisabled();
    pending.resolve({ kind: 'ok', confirmed: 0, refused: 0, unresolved: 2 });
    await waitFor(() => {
      expect(within(history()).getByRole('button', { name: `${RESEND} T1-000002` })).toBeEnabled();
    });
  });
});

describe('unresolved row detail (RT-1498)', () => {
  it('shows the attempt count, last attempt time and the cause of an unknown row', async () => {
    await mount();
    const row = within(history()).getByText('T1-000002').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(UNRESOLVED_COPY.attempts(4));
    const time = row.querySelectorAll('time');
    expect(
      Array.from(time).some((t) => t.getAttribute('dateTime') === '2026-10-04T09:20:00.000Z'),
    ).toBe(true);
    expect(row).toHaveTextContent(UNRESOLVED_COPY.cause('confirmation_mismatch'));
    expect(row).toHaveTextContent(UNRESOLVED_COPY.doNotPay);
  });

  it('a never-sent pending row says so and shows no cause', async () => {
    await mount();
    const row = within(history()).getByText('T1-000003').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(UNRESOLVED_COPY.neverSent);
    expect(row).toHaveTextContent(UNRESOLVED_COPY.doNotPay);
    expect(row).not.toHaveTextContent(UNRESOLVED_COPY.codeLabel);
  });

  it('a settled row shows no attempt detail and no do-not-pay line', async () => {
    await mount();
    for (const sale of ['T1-000001', 'T1-000004', 'T1-000005']) {
      const row = within(history()).getByText(sale).closest('tr') as HTMLElement;
      expect(row).not.toHaveTextContent(UNRESOLVED_COPY.doNotPay);
      expect(row).not.toHaveTextContent(UNRESOLVED_COPY.attemptsLabel);
    }
  });

  it('an unknown row with no recorded cause shows the attempts but no cause line', async () => {
    await mount([journal({ ...UNKNOWN, lastCause: null })]);
    const row = within(history()).getByText('T1-000002').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(UNRESOLVED_COPY.attempts(4));
    expect(row).not.toHaveTextContent(UNRESOLVED_COPY.codeLabel);
  });
});
