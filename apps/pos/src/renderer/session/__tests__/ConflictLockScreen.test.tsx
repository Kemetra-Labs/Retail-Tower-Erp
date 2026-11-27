import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { SessionLockGate } from '../SessionLockGate';
import type {
  LockStateView,
  ResolveConflictRequest,
  ResolveConflictResponse,
  SessionStateEvent,
} from '../../../shared/bridge-api';

afterEach(cleanup);

/** The owner-approved D9 copy (RT-309 c19114), byte for byte. */
const CONFLICT_LOCK_COPY = {
  message: 'أنت مسجّل الدخول على جهاز آخر. البيع الحالي محفوظ.',
} as const;

/**
 * RT-309 D9 (10763 D9; owner approval RT-309 c19114) — the authority-conflict
 * lock screen: nothing of the sale, the approved message, two PIN-gated
 * actions («استلام هنا» / «إنهاء هنا»), the approved copy on a takeover 429,
 * and no other way out (no plain unlock, no switch to another operator).
 */

const CONFLICT: LockStateView = {
  state: 'locked',
  locked_at: '2026-11-27T10:00:00.000Z',
  role: 'cashier',
  display_name: 'Cashier One',
  // main sends null for a conflict lock; a non-null one here proves the screen never reads it.
  summary: { line_count: 3, total_minor: 5275, tender_applied_minor: 1000, has_live_tender: true },
  lock_cause: 'authority_conflict',
};

function fakeOperator(
  resolve: ((req: ResolveConflictRequest) => Promise<ResolveConflictResponse>) | undefined,
) {
  let push: ((e: SessionStateEvent) => void) | null = null;
  const api = {
    getLockState: vi.fn(() => Promise.resolve(CONFLICT)),
    unlockSession: vi.fn(() => Promise.resolve({ kind: 'unlocked' as const })),
    onSessionStateChanged: vi.fn((cb: (e: SessionStateEvent) => void) => {
      push = cb;
      return () => {
        push = null;
      };
    }),
    ...(resolve === undefined ? {} : { resolveConflict: vi.fn(resolve) }),
  };
  return {
    api,
    push: (e: SessionStateEvent) => {
      act(() => push?.(e));
    },
  };
}

/** `null`: a bridge without `resolveConflict`. */
async function renderConflict(
  resolve: ((req: ResolveConflictRequest) => Promise<ResolveConflictResponse>) | null = () =>
    Promise.resolve({ kind: 'resolved', action: 'take_over_here' }),
) {
  const op = fakeOperator(resolve ?? undefined);
  render(
    <SessionLockGate operator={op.api}>
      <p>sale behind</p>
    </SessionLockGate>,
  );
  await screen.findByText(CONFLICT_LOCK_COPY.message);
  return op;
}

async function typePin(pin: string): Promise<void> {
  const user = userEvent.setup();
  for (const d of pin) {
    await user.click(screen.getByRole('button', { name: d }));
  }
}

describe('RT-309 D9 conflict lock screen', () => {
  it('shows the approved message and the two actions, nothing of the sale, no other way out', async () => {
    await renderConflict();
    expect(screen.getByText('أنت مسجّل الدخول على جهاز آخر. البيع الحالي محفوظ.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'استلام هنا' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'إنهاء هنا' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'فتح القفل' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'دخول موظف آخر' })).toBeNull();
    expect(screen.queryByText(/Cashier One/)).toBeNull();
    expect(screen.queryByText(/52\.75|5275|3 /)).toBeNull();
    expect(screen.getByTestId('session-lock-app')).toHaveAttribute('inert');
  });

  it('«استلام هنا» sends take_over_here with the PIN and clears the lock on resolved', async () => {
    const resolve = vi.fn<(req: ResolveConflictRequest) => Promise<ResolveConflictResponse>>(() =>
      Promise.resolve({ kind: 'resolved', action: 'take_over_here' }),
    );
    await renderConflict(resolve);
    await typePin('1234');
    await userEvent.setup().click(screen.getByRole('button', { name: 'استلام هنا' }));
    expect(resolve).toHaveBeenCalledWith({ action: 'take_over_here', pin: '1234' });
    await waitFor(() => {
      expect(screen.queryByText(CONFLICT_LOCK_COPY.message)).toBeNull();
    });
  });

  it('«إنهاء هنا» sends end_here; the lock stays until main pushes ended', async () => {
    const resolve = vi.fn<(req: ResolveConflictRequest) => Promise<ResolveConflictResponse>>(() =>
      Promise.resolve({ kind: 'resolved', action: 'end_here' }),
    );
    const op = await renderConflict(resolve);
    await typePin('1234');
    await userEvent.setup().click(screen.getByRole('button', { name: 'إنهاء هنا' }));
    expect(resolve).toHaveBeenCalledWith({ action: 'end_here', pin: '1234' });
    expect(screen.getByText(CONFLICT_LOCK_COPY.message)).toBeVisible();
    op.push({ state: 'ended' });
    expect(screen.queryByText(CONFLICT_LOCK_COPY.message)).toBeNull();
  });

  it('a takeover 429 shows the approved copy exactly and keeps the lock', async () => {
    await renderConflict(() => Promise.resolve({ kind: 'takeover_rate_limited' }));
    await typePin('1234');
    await userEvent.setup().click(screen.getByRole('button', { name: 'استلام هنا' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('حاولت كثيراً، انتظر قليلاً ثم أعد المحاولة');
    expect(screen.getByText(CONFLICT_LOCK_COPY.message)).toBeVisible();
  });

  it.each([
    ['invalid_input', 'بيانات الدخول غير صحيحة. حاول مرة أخرى.'],
    ['rate_limited', 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.'],
    ['no_connection', 'تعذّر الوصول إلى الخادم. حاول مرة أخرى.'],
    ['state_invalid', 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.'],
    ['not_signed_in', 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.'],
  ] as const)(
    'a %s refusal shows the existing copy and never echoes the PIN',
    async (category, copy) => {
      await renderConflict(() => Promise.resolve({ kind: 'refused', category }));
      await typePin('2468');
      await userEvent.setup().click(screen.getByRole('button', { name: 'إنهاء هنا' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(copy);
      expect(document.body.textContent).not.toContain('2468');
    },
  );

  it('a PIN outside 4–6 digits never reaches main', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve<ResolveConflictResponse>({ kind: 'resolved', action: 'end_here' }),
    );
    await renderConflict(resolve);
    await typePin('12');
    await userEvent.setup().click(screen.getByRole('button', { name: 'إنهاء هنا' }));
    expect(resolve).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('الرقم السري من 4 إلى 6 أرقام.');
  });

  it('without the bridge call every action fails closed with the generic copy', async () => {
    await renderConflict(null);
    await typePin('1234');
    await userEvent.setup().click(screen.getByRole('button', { name: 'استلام هنا' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية.',
    );
    expect(screen.getByText(CONFLICT_LOCK_COPY.message)).toBeVisible();
  });

  it('Escape clears the entry and never dismisses the lock', async () => {
    await renderConflict();
    await typePin('12');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByText(CONFLICT_LOCK_COPY.message)).toBeVisible();
  });
});
