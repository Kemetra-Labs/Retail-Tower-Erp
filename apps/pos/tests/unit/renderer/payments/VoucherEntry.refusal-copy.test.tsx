/**
 * 006-payments-tender Wave 5c — <VoucherEntry> refusal-copy test.
 *
 * HISTORY / SUPERSEDED: this file pinned the §A4-B reviewer decision F-A4B-003
 * (`specs/006-payments-tender/reviews/a4b-vouchers-bridge-brief.md` §6): all eight voucher
 * refusal reasons map to ONE generic string. By the owner's decision (chat, 2026-11-19,
 * RT-1331) the cashier is now told which voucher problem stopped the apply
 * (`voucher-refusal-copy.ts`, pinned in `voucher-refusal-copy.test.ts`). What this file still
 * enforces from F-A4B-003:
 *
 *   The structured `refusal.reason` MUST NEVER enter the DOM, a rejected bridge promise
 *   collapses to the generic line with no error detail, and the banner clears on an input edit.
 *   (Whether a code from another organization can be told apart from an unknown one is pinned
 *   in `voucher-refusal-copy.test.ts`.)
 *
 * The 8 reasons (closed enum, from contracts/bridge-api.md
 * §"vouchers.validate" + spec FR-006 + scripts/openapi-snapshot.json
 * POS V-A error.code description):
 *   - voucher_not_found
 *   - voucher_expired
 *   - voucher_cancelled
 *   - voucher_already_redeemed
 *   - voucher_tenant_mismatch
 *   - voucher_branch_mismatch
 *   - non_cash_overpayment_refused
 *   - validation_failure
 *
 * Additional refusal reasons that may surface on the wider TenderApply
 * envelope (no_session / role_denied / attempt_terminal /
 * idempotency_payload_mismatch / wrong_owner / invalid_input /
 * tenant_isolation) MUST also collapse to the same generic copy — the
 * renderer treats EVERY non-ok response identically.
 *
 * A rejected bridge promise (IPC error / main crash / timeout) MUST
 * ALSO collapse to the same copy — no stuck-applying state, no error
 * details in the DOM.
 *
 * **Wave 5c — TDD RED.**
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { VoucherEntry } from '../../../../src/renderer/ui/payments/VoucherEntry.js';
import {
  VOUCHER_REFUSAL_GENERIC_COPY as GENERIC_VOUCHER_REFUSAL_COPY,
  voucherRefusalCopy,
} from '../../../../src/renderer/ui/payments/voucher-refusal-copy.js';
import type { TenderApplyRequest, TenderApplyResponse } from '../../../../src/shared/bridge-api.js';

afterEach(() => {
  cleanup();
});

// The 8 voucher-specific refusal reasons enumerated in the contract.
const VOUCHER_REFUSAL_REASONS = [
  'voucher_not_found',
  'voucher_expired',
  'voucher_cancelled',
  'voucher_already_redeemed',
  'voucher_tenant_mismatch',
  'voucher_branch_mismatch',
  'non_cash_overpayment_refused',
  'validation_failure',
] as const;

// Additional refusal reasons that the wider TenderApply envelope may
// surface — these keep the generic copy (`role_denied` and `dependency_unavailable` have their
// own lines, see below).
const ENVELOPE_REFUSAL_REASONS = [
  'no_session',
  'attempt_terminal',
  'idempotency_payload_mismatch',
  'wrong_owner',
  'invalid_input',
  'tenant_isolation',
] as const;

// `reason` is a plain string on purpose: the 8 voucher reasons include
// `validation_failure`, which is not a member of the typed `RefusalReason`
// union, and the component must collapse any refusal to the same copy.
async function driveRefusal(
  reason: string,
): Promise<{ refusedNode: HTMLElement; container: HTMLElement }> {
  const refused = { kind: 'refused', reason } as TenderApplyResponse;
  const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
    async () => await Promise.resolve(refused),
  );
  const user = userEvent.setup();
  const { container } = render(
    <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
  );
  await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
  await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
  await user.click(screen.getByTestId('voucher-entry-confirm'));
  await waitFor(() => {
    expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
  });
  return { refusedNode: screen.getByTestId('voucher-entry-refused'), container };
}

describe('RT-1331 — VoucherEntry per-reason refusal copy (8 voucher reasons)', () => {
  it.each(VOUCHER_REFUSAL_REASONS)(
    'voucher refusal "%s" renders its own line, and the reason code stays out of the DOM',
    async (reason) => {
      const { refusedNode } = await driveRefusal(reason);
      expect(refusedNode).toHaveTextContent(voucherRefusalCopy(reason));
      // The structured reason MUST NOT leak to the DOM.
      expect(refusedNode).not.toHaveTextContent(reason);
    },
  );

  it.each(['role_denied', 'dependency_unavailable'] as const)(
    'the session / service refusal "%s" renders its own line',
    async (reason) => {
      const { refusedNode } = await driveRefusal(reason);
      expect(refusedNode).toHaveTextContent(voucherRefusalCopy(reason));
      expect(refusedNode).not.toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
    },
  );

  it('an expired, a cancelled and an unknown voucher read differently', async () => {
    const lines = new Set<string>();
    for (const reason of ['voucher_expired', 'voucher_cancelled', 'voucher_not_found']) {
      const { refusedNode } = await driveRefusal(reason);
      lines.add(refusedNode.textContent);
      cleanup();
    }
    expect(lines.size).toBe(3);
  });

  it.each(VOUCHER_REFUSAL_REASONS)(
    'voucher refusal "%s" does NOT leak the reason anywhere in the rendered subtree',
    async (reason) => {
      const { container } = await driveRefusal(reason);
      const text = container.textContent;
      // The literal closed-enum string must not appear anywhere in the
      // VoucherEntry rendered output — not just in the refusal banner.
      expect(text).not.toContain(reason);
    },
  );
});

describe('RT-1331 — VoucherEntry envelope refusals (keep the generic copy)', () => {
  it.each(ENVELOPE_REFUSAL_REASONS)(
    'envelope refusal "%s" renders the SAME generic copy',
    async (reason) => {
      const { refusedNode } = await driveRefusal(reason);
      expect(refusedNode).toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
      expect(refusedNode).not.toHaveTextContent(reason);
    },
  );
});

describe('RT-1331 — VoucherEntry rejected-promise path (generic line, no detail)', () => {
  it('rejected bridge promise collapses to the SAME generic copy (no stuck-applying state)', async () => {
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(() =>
      Promise.reject(new Error('IPC channel closed — sensitive detail')),
    );
    const user = userEvent.setup();
    const { container } = render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
    });
    const refusedNode = screen.getByTestId('voucher-entry-refused');
    expect(refusedNode).toHaveTextContent(GENERIC_VOUCHER_REFUSAL_COPY);
    // The Error message must NOT leak to the DOM anywhere.
    const text = container.textContent;
    expect(text).not.toMatch(/IPC channel closed/i);
    expect(text).not.toMatch(/sensitive detail/i);
    // The applying spinner is gone.
    expect(screen.queryByTestId('voucher-entry-applying')).not.toBeInTheDocument();
  });
});

describe('RT-1331 — a refusal that arrives after the input was edited is discarded', () => {
  // A per-reason line states a fact about the code that was sent. If the cashier has since
  // typed another code or amount, showing it would state that fact about input no longer on
  // screen, so the late answer is dropped (the forfeit prompt already follows the same rule).
  it.each([
    ['code', 'voucher-entry-code-input', 'X'],
    ['amount', 'voucher-entry-amount-input', '{Backspace}'],
  ])('a late refusal after the %s was edited shows nothing', async (_field, inputTestId, keys) => {
    let resolveAnswer: (r: TenderApplyResponse) => void = () => undefined;
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      () =>
        new Promise<TenderApplyResponse>((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'VOUCHER10');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await user.type(screen.getByTestId(inputTestId), keys);
    resolveAnswer({ kind: 'refused', reason: 'voucher_expired' });

    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-applying')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('voucher-entry-refused')).not.toBeInTheDocument();
  });

  it('a refusal for unchanged input still shows its line', async () => {
    const { refusedNode } = await driveRefusal('voucher_expired');
    expect(refusedNode).toHaveTextContent(voucherRefusalCopy('voucher_expired'));
  });
});

describe('RT-1331 — VoucherEntry refusal banner clears on input edit', () => {
  it('typing in either input clears the refusal banner (so retry is unambiguous)', async () => {
    const bridge = vi.fn<(req: TenderApplyRequest) => Promise<TenderApplyResponse>>(
      async () => await Promise.resolve({ kind: 'refused', reason: 'voucher_not_found' }),
    );
    const user = userEvent.setup();
    render(
      <VoucherEntry remainingBalanceMinor={5000} paymentAttemptId="pa-1" tenderApply={bridge} />,
    );
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'BADCODE');
    await user.type(screen.getByTestId('voucher-entry-amount-input'), '15.00');
    await user.click(screen.getByTestId('voucher-entry-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('voucher-entry-refused')).toBeInTheDocument();
    });
    // Cashier edits the voucher code to retry.
    await user.type(screen.getByTestId('voucher-entry-code-input'), 'X');
    expect(screen.queryByTestId('voucher-entry-refused')).not.toBeInTheDocument();
  });
});
