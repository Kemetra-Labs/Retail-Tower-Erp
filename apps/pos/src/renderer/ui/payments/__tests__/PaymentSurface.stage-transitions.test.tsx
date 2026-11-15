/**
 * RT-1226 AC2 — characterization of the PaymentSurface stage transitions AC2
 * names, written BEFORE the surface was split into stage sub-components.
 *
 * Each walk drives the real surface against a fake main (a stateful bridge) and
 * pins, at every stage: the whole rendered DOM (markup, order, classes, ARIA,
 * `data-testid` hooks, Arabic copy, money text), where focus is, and the bridge
 * calls made. The snapshots were recorded on the unsplit surface; the split
 * must reproduce them byte for byte. A snapshot change here is a behaviour
 * change, not a refactor.
 *
 * Walks: cash exact, cash with change, card, split tender (cash then card),
 * cancel before settle, the card-cancel confirm (M-P7), the cancel holds
 * (unconfirmed and live tender), a failed read-back, the 0-due completion, Esc
 * then Back, the settled screen with sale finalization off (the fail-closed
 * receipt warning) and on, and the settled screen's own sale number (RT-1322).
 *
 * Not walked here (covered by their own suites, unchanged by the split):
 * Slice-1 with no bridge, voucher entry, reversal pending, the session-refusal
 * `blocked` read, remount resume (`PaymentSurface.remount`,
 * `PaymentSurface.ledger-remount`), and a refused start.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope.js';
import type { PaymentAttemptRendererView } from '../../../../shared/payments/types.js';
import type {
  PaymentsBridgeAPI,
  SaleSummary,
  SalesBridgeAPI,
  SalesReadForHandoffResponse,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';
import { usePaymentStore } from '../../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store.js';
import { PaymentSurface } from '../PaymentSurface.js';

type Line = PaymentAttemptRendererView['tender_lines'][number];
type AttemptState = PaymentAttemptRendererView['state'];

function makeEnvelope(dueMinor: number): PaymentIntentEnvelope {
  return {
    envelope_version: 'v1',
    cart_id: 'cart-001',
    operator_session_id: 'sess-001',
    owning_operator_id: 'op-001',
    tenant_id: 'tenant-001',
    branch_id: 'branch-001',
    terminal_id: 'terminal-001',
    lines: [
      {
        line_id: 'line-001',
        item_ref: 'item-001',
        display_name: 'باراسيتامول ٥٠٠ مجم',
        quantity: 1,
        unit_price_minor: dueMinor,
        line_subtotal_minor: dueMinor,
        note: null,
        version: 1,
        last_action_id: 'act-001',
      },
    ],
    discount_placeholders: [],
    subtotal_minor: dueMinor,
    created_at: '2026-11-15T09:00:00.000Z',
    handoff_action_id: 'hid-001',
  };
}

function signIn(): void {
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'sess-001',
        operator_id: 'op-001',
        display_name: 'أحمد',
        role: 'cashier',
        tenant_id: 'tenant-001',
        branch_id: 'branch-001',
        started_at: '2026-11-15T08:00:00.000Z',
      },
    },
  });
}

interface FakeMainOptions {
  /** What `payments.cancel` does: reverse every line, or lose the answer. */
  cancel?: 'ok' | 'lost';
  /** `payments.read` fails from the n-th call on (1-based), when set. */
  readFailsFrom?: number;
  /** `payments.confirm` is refused with this reason, and main ends the attempt. */
  confirmRefusal?: { reason: 'attempt_terminal'; endState: AttemptState };
  /** RT-1322 — `sales.readForHandoff` answers these in turn (the last one repeats). */
  saleNumberAnswers?: readonly SalesReadForHandoffResponse[];
}

interface FakeMain {
  bridge: { payments: PaymentsBridgeAPI; tender: TenderBridgeAPI; sales?: SalesBridgeAPI };
  calls: string[];
}

/** RT-1322 — the sales bridge with only `readForHandoff`, answering in turn. */
function makeSales(
  answers: readonly SalesReadForHandoffResponse[],
  calls: string[],
): SalesBridgeAPI {
  let asked = 0;
  return {
    readForHandoff: vi.fn((req: { handoff_action_id: string; payment_attempt_id: string }) => {
      calls.push(
        `sales.readForHandoff handoff=${req.handoff_action_id} attempt=${req.payment_attempt_id}`,
      );
      const answer = answers[Math.min(asked, answers.length - 1)];
      asked += 1;
      return Promise.resolve(answer);
    }),
  } as unknown as SalesBridgeAPI;
}

/**
 * A fake main: one attempt whose lines `tender.apply` records (cash change is
 * received − still owed), projected back by `payments.read`. Every call is
 * logged with its money-relevant fields (idempotency keys are random, so left
 * out).
 */
function makeFakeMain(dueMinor: number, options: FakeMainOptions = {}): FakeMain {
  const calls: string[] = [];
  let state: AttemptState = 'started';
  let lines: Line[] = [];
  let reads = 0;
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: 'pa-001',
    state,
    envelope_subtotal_minor: dueMinor,
    started_at: '2026-11-15T09:00:30.000Z',
    tender_lines: lines,
  });
  const owed = (): number =>
    dueMinor -
    lines.filter((l) => l.state === 'applied').reduce((s, l) => s + l.amount_applied_minor, 0);

  const payments = {
    start: vi.fn((req: { envelope_subtotal_minor: number }) => {
      calls.push(`payments.start due=${String(req.envelope_subtotal_minor)}`);
      return Promise.resolve({ kind: 'ok' as const, payment_attempt_id: 'pa-001' });
    }),
    read: vi.fn(() => {
      reads += 1;
      calls.push(`payments.read #${String(reads)}`);
      if (options.readFailsFrom !== undefined && reads >= options.readFailsFrom) {
        return Promise.reject(new Error('ipc lost'));
      }
      return Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() });
    }),
    confirm: vi.fn(() => {
      calls.push('payments.confirm');
      if (options.confirmRefusal !== undefined) {
        state = options.confirmRefusal.endState;
        return Promise.resolve({ kind: 'refused' as const, reason: options.confirmRefusal.reason });
      }
      state = 'settled';
      return Promise.resolve({ kind: 'ok' as const, settled_at: '2026-11-15T09:05:00.000Z' });
    }),
    cancel: vi.fn(() => {
      calls.push('payments.cancel');
      if (options.cancel === 'lost') return Promise.reject(new Error('ipc lost'));
      const reversed = lines.map((l) => l.tender_line_id);
      state = 'cancelled';
      lines = lines.map((l) => ({ ...l, state: 'reversed' as const }));
      return Promise.resolve({
        kind: 'ok' as const,
        reversed_tender_line_ids: reversed,
        reversal_pending_tender_line_ids: [],
      });
    }),
  } as unknown as PaymentsBridgeAPI;

  const tender = {
    apply: vi.fn(
      (req: {
        tender_type: Line['tender_type'];
        amount_applied_minor: number;
        external_reference?: string;
      }) => {
        const ref = req.external_reference === undefined ? '' : ` ref=${req.external_reference}`;
        calls.push(
          `tender.apply ${req.tender_type} amount=${String(req.amount_applied_minor)}${ref}`,
        );
        const change =
          req.tender_type === 'cash' ? Math.max(req.amount_applied_minor - owed(), 0) : 0;
        const id = `tl-${String(lines.length + 1)}`;
        lines = [
          ...lines,
          {
            tender_line_id: id,
            tender_type: req.tender_type,
            state: 'applied',
            amount_applied_minor: req.amount_applied_minor,
            ...(change > 0 ? { change_due_minor: change } : {}),
            applied_at: '2026-11-15T09:01:00.000Z',
            apply_order: lines.length + 1,
          },
        ];
        return Promise.resolve({
          kind: 'ok' as const,
          tender_line_id: id,
          applied_at: '2026-11-15T09:01:00.000Z',
          ...(change > 0 ? { change_due_minor: change } : {}),
        });
      },
    ),
  } as unknown as TenderBridgeAPI;

  const sales =
    options.saleNumberAnswers === undefined
      ? {}
      : { sales: makeSales(options.saleNumberAnswers, calls) };
  return { bridge: { payments, tender, ...sales }, calls };
}

/** Let every pending bridge promise and the renders they cause settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId));
  await settle();
}

/** The stage as the cashier meets it: the whole DOM, and where focus is. */
function stage(): { focus: string; dom: string } {
  const active = document.activeElement;
  const focus =
    active === null || active === document.body
      ? '<body>'
      : (active.getAttribute('data-testid') ?? `<${active.tagName.toLowerCase()}>`);
  return { focus, dom: document.body.innerHTML };
}

async function mountSurface(
  dueMinor: number,
  options: FakeMainOptions = {},
  onNewSale?: () => void,
  onBackToSale: () => Promise<boolean> = () => Promise.resolve(false),
): Promise<FakeMain> {
  usePaymentStore.getState().mount(makeEnvelope(dueMinor));
  const main = makeFakeMain(dueMinor, options);
  render(
    <PaymentSurface
      _testBridge={main.bridge}
      {...(onNewSale === undefined ? {} : { onNewSale })}
      onBackToSale={onBackToSale}
      backToSaleEligibility="returnable"
    />,
  );
  await settle();
  return main;
}

function typeCash(value: string): void {
  fireEvent.change(screen.getByTestId('cash-entry-amount-input'), { target: { value } });
}

function flags(saleFinalization: boolean): void {
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: true,
    saleFinalization,
    cardTender: true,
  });
}

beforeEach(() => {
  signIn();
  flags(true);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
  usePaymentStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RT-1226 AC2 — PaymentSurface stage transitions (characterization)', () => {
  it('cash exact: arrival → cash entry → exact apply → confirm → settled', async () => {
    const main = await mountSurface(5_000);
    expect(stage()).toMatchSnapshot('1 arrival (tender selection)');

    await click('tender-cash');
    expect(stage()).toMatchSnapshot('2 cash entry open');

    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    expect(stage()).toMatchSnapshot('3 exact amount typed');

    await click('cash-entry-confirm');
    expect(stage()).toMatchSnapshot('4 fully tendered (settle offered)');

    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('5 settled');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('cash with change: typed 100.00 against 62.30 → change recorded → settled', async () => {
    const main = await mountSurface(6_230);
    await click('tender-cash');
    typeCash('100.00');
    expect(stage()).toMatchSnapshot('1 change previewed');

    await click('cash-entry-confirm');
    expect(stage()).toMatchSnapshot('2 change recorded');

    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('3 settled with change');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('card: card entry → reference → apply → confirm → settled', async () => {
    const main = await mountSurface(4_000);
    await click('tender-external-card');
    expect(stage()).toMatchSnapshot('1 card entry open');

    fireEvent.change(screen.getByTestId('external-card-reference-input'), {
      target: { value: 'A1B2' },
    });
    await click('external-card-confirm');
    expect(stage()).toMatchSnapshot('2 card recorded');

    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('3 settled by card');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('split tender: partial cash → back to the tiles → card for the rest → settled', async () => {
    const main = await mountSurface(10_000);
    await click('tender-cash');
    typeCash('30.00');
    await click('cash-entry-confirm');
    expect(stage()).toMatchSnapshot('1 partial cash recorded, tiles again');

    await click('tender-external-card');
    expect(stage()).toMatchSnapshot('2 card entry for the remainder');

    fireEvent.change(screen.getByTestId('external-card-reference-input'), {
      target: { value: 'Z9' },
    });
    await click('external-card-confirm');
    expect(stage()).toMatchSnapshot('3 fully tendered by two lines');

    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('4 settled after split');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('cancel before settle: partial cash → entry again → cancel → tiles, money reversed', async () => {
    const main = await mountSurface(10_000);
    await click('tender-cash');
    typeCash('20.00');
    await click('cash-entry-confirm');
    await click('tender-cash');
    expect(stage()).toMatchSnapshot('1 entry open with money recorded');

    await click('payment-surface-cancel');
    expect(stage()).toMatchSnapshot('2 cancelled, back at the tiles');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('card cancel asks first (M-P7): «رجوع» keeps the entry, confirm cancels', async () => {
    const main = await mountSurface(10_000);
    await click('tender-cash');
    typeCash('20.00');
    await click('cash-entry-confirm');
    // A real card apply for the remainder: the entry records the RT-256 facts.
    await click('tender-external-card');
    fireEvent.change(screen.getByTestId('external-card-reference-input'), {
      target: { value: 'C3' },
    });
    await click('external-card-confirm');
    expect(usePaymentStore.getState().cardSafety).toMatchSnapshot('card facts after the apply');

    await click('payment-surface-cancel');
    expect(stage()).toMatchSnapshot('1 card-cancel confirm shown');

    fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
    await settle();
    expect(stage()).toMatchSnapshot('2 confirm dismissed');

    await click('payment-surface-cancel');
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await settle();
    expect(stage()).toMatchSnapshot('3 cancelled after confirm (terminal void notice)');
    expect(usePaymentStore.getState().cardSafety).toMatchSnapshot('card facts after the cancel');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('hold (unconfirmed): cancel answer and read-back lost → payment held, Cancel offered', async () => {
    const main = await mountSurface(10_000, { cancel: 'lost', readFailsFrom: 2 });
    await click('tender-cash');
    expect(stage()).toMatchSnapshot('1 entry open');

    await click('payment-surface-cancel');
    expect(stage()).toMatchSnapshot('2 unconfirmed hold');
    expect(usePaymentStore.getState().cancelRecovery?.hold).toBe('unconfirmed');

    // Esc must not close the entry while the hold stands, and no tile starts anything.
    fireEvent.keyDown(window, { key: 'Escape' });
    await click('tender-cash');
    expect(stage()).toMatchSnapshot('3 still held after Esc and a tile press');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('hold (live tender): a refused settle reads a force-failed attempt with live tender', async () => {
    const main = await mountSurface(5_000, {
      confirmRefusal: { reason: 'attempt_terminal', endState: 'force_failed' },
    });
    await click('tender-cash');
    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    await click('cash-entry-confirm');
    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('1 live-tender hold');
    expect(usePaymentStore.getState().cancelRecovery?.hold).toBe('live_tender');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('read-back failure after an apply: the retry owns the commit until main answers', async () => {
    const main = await mountSurface(5_000, { readFailsFrom: 2 });
    await click('tender-cash');
    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    await click('cash-entry-confirm');
    expect(stage()).toMatchSnapshot('1 read failed, retry offered');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('0 due: «إتمام البيع» owns the commit and settles with no tender', async () => {
    const main = await mountSurface(0);
    expect(stage()).toMatchSnapshot('1 zero-due arrival');

    await click('payment-surface-complete-zero');
    expect(stage()).toMatchSnapshot('2 settled at zero');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });

  it('Esc closes an open entry first, then Back is the separate action', async () => {
    const onBackToSale = vi.fn(() => Promise.resolve(false));
    await mountSurface(5_000, {}, undefined, onBackToSale);
    await click('tender-cash');
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(stage()).toMatchSnapshot('1 entry closed by Esc');
    expect(onBackToSale).not.toHaveBeenCalled();

    // The second Esc is Back; main refuses here, so the cashier stays with the reason.
    fireEvent.keyDown(window, { key: 'Escape' });
    await settle();
    expect(onBackToSale).toHaveBeenCalledTimes(1);
    expect(stage()).toMatchSnapshot('2 Back refused');
  });

  it('finalization-off guard: the settled screen says no receipt will be issued', async () => {
    flags(false);
    const onNewSale = vi.fn();
    await mountSurface(5_000, {}, onNewSale);
    await click('tender-cash');
    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    await click('cash-entry-confirm');
    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('1 settled, finalization off');
    expect(screen.getByTestId('completion-proof-receipt')).toHaveAttribute('data-tone', 'warning');

    await click('payment-surface-new-sale');
    expect(onNewSale).toHaveBeenCalledTimes(1);
  });

  it('settled sale number (RT-1322): nothing claimed while pending, then the number', async () => {
    // The poll's timers are under the test's control, so the pending stage is
    // observed before any second read, however slow the worker is.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const main = await mountSurface(5_000, {
      saleNumberAnswers: [
        { kind: 'pending' },
        {
          kind: 'ok',
          sale: { sale_number: 'TERM-01-2026-11-15-000047' } as SaleSummary,
          short_number: '47',
        },
      ],
    });
    await click('tender-cash');
    fireEvent.click(screen.getByTestId('quick-amount-exact'));
    await click('cash-entry-confirm');
    await click('payment-surface-confirm');
    expect(stage()).toMatchSnapshot('1 settled, number pending');

    // The next read is due after the 250 ms fast poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await settle();
    expect(stage()).toMatchSnapshot('2 settled, own sale number shown');
    expect(main.calls).toMatchSnapshot('bridge calls');
  });
});
