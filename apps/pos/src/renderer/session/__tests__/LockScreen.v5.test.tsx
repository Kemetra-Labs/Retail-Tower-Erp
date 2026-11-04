import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LockScreen } from '../LockScreen';
import type { LockStateView } from '../../../shared/bridge-api';

afterEach(cleanup);

/**
 * RT-593 (VN-S8 lock) — the lock screen on the V5 vocabulary.
 *
 * Owner decision L3 / doc 15 §2.1 (RT-593 comment, 2026-10-17): the lock
 * surface shows NOTHING of the sale — no lines, no count, no amounts. Main
 * still provides `summary`; the screen no longer renders it.
 */

const LOCKED: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-01T10:10:00.000Z',
  role: 'cashier',
  display_name: 'Cashier One',
  summary: { line_count: 3, total_minor: 5275, tender_applied_minor: 1000, has_live_tender: true },
};

function renderLock(view: LockStateView = LOCKED, onSwitchOperator?: () => void) {
  return render(
    <LockScreen
      view={view}
      unlock={vi.fn(() => Promise.resolve({ kind: 'unlocked' as const }))}
      onUnlocked={vi.fn()}
      {...(onSwitchOperator !== undefined ? { onSwitchOperator } : {})}
    />,
  );
}

describe('RT-593 lock hides the sale (L3)', () => {
  it.each(['cashier', 'manager'] as const)(
    'renders no line, count, amount or paid-so-far for a %s lock',
    (role) => {
      renderLock({ ...LOCKED, role });
      const text = document.body.textContent;
      // line_count 3, total 52.75, tender applied 10.00 — none may appear in any form.
      expect(text).not.toMatch(/52[.,٫]75|5275|10[.,٫]00|1000/);
      expect(text).not.toContain('مدفوع حتى الآن');
      expect(text).not.toContain('عدد الأصناف');
      expect(text).not.toContain('الإجمالي');
      expect(document.querySelector('dl, .session-lock__summary')).toBeNull();
      expect(document.body.textContent).not.toMatch(/\d{2,}\.\d{2}/);
    },
  );

  it('renders the same with and without a preserved sale', () => {
    // The Dialog portals into its DialogHost inside the lock root, so the root's markup is the whole screen.
    const markup = (): string =>
      (document.querySelector('.session-lock')?.innerHTML ?? '').replace(/_r_[0-9a-z]+_/g, '_id_');
    const withSale = renderLock();
    const a = markup();
    expect(a).not.toBe('');
    withSale.unmount();
    renderLock({ ...LOCKED, summary: null });
    expect(markup()).toBe(a);
  });

  it('never reads the summary or the money formatter in the source', () => {
    const src = readFileSync(resolve(__dirname, '../LockScreen.tsx'), 'utf-8');
    expect(src).not.toMatch(/\.summary\b/);
    expect(src).not.toMatch(/formatCheckoutMoney/);
  });
});

describe('RT-593 lock is V5, not 007', () => {
  it('does not import the 007 primitives', () => {
    const src = readFileSync(resolve(__dirname, '../LockScreen.tsx'), 'utf-8');
    expect(src).not.toMatch(/ui\/primitives/);
  });

  it('renders through the one V5 Dialog with the M-L1 copy', () => {
    renderLock();
    const dialog = screen.getByRole('dialog', { name: 'الطرفية مقفلة' });
    expect(dialog).toHaveClass('v5-dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('.v5-dialog-backdrop')).not.toBeNull();
    // M-L1 «الطرفية مقفلة. أدخل الرقم السري للمتابعة.» — title, then prompt.
    expect(screen.getByRole('heading', { name: 'الطرفية مقفلة' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('أدخل الرقم السري للمتابعة.');
    expect(dialog).toHaveAccessibleDescription('أدخل الرقم السري للمتابعة.');
    expect(document.querySelector('.dialog-overlay')).toBeNull();
  });

  it.each(['manager', 'admin'] as const)('shows M-L1b to a %s, not the PIN prompt', (role) => {
    renderLock({ ...LOCKED, role });
    // M-L1b «الطرفية مقفلة. أدخل بيانات الدخول للمتابعة.» — same title, role-specific prompt.
    const dialog = screen.getByRole('dialog', { name: 'الطرفية مقفلة' });
    expect(dialog).toHaveAccessibleDescription('أدخل بيانات الدخول للمتابعة.');
    expect(dialog).not.toHaveTextContent('أدخل الرقم السري للمتابعة.');
  });

  it('uses V5 button vocabulary and keeps the switch-operator button', () => {
    renderLock({ ...LOCKED, role: 'manager' }, vi.fn());
    const unlock = screen.getByRole('button', { name: 'فتح القفل' });
    expect(unlock).toHaveClass('v5-live-btn', 'v5-live-btn--primary');
    expect(unlock).toHaveAttribute('type', 'submit');
    const sw = screen.getByRole('button', { name: 'دخول موظف آخر' });
    expect(sw).toHaveClass('v5-live-btn');
    expect(sw).toHaveAttribute('type', 'button');
  });

  it('focuses the PIN field on open and Esc clears the entry but keeps the lock', async () => {
    renderLock();
    const field = screen.getByTestId('pin-pad-dots');
    expect(field).toHaveFocus();
    await userEvent.keyboard('12');
    expect(field).toHaveAccessibleName('الرقم السري، أُدخل 2 من 6');
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveAccessibleName('الرقم السري، أُدخل 0 من 6');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('focuses the identifier on open for a manager', () => {
    renderLock({ ...LOCKED, role: 'manager' });
    expect(screen.getByLabelText('البريد أو اسم المستخدم')).toHaveFocus();
  });
});

describe('RT-1095 lock joins the entry family (OD-13)', () => {
  function renderWith(unlock = vi.fn(() => Promise.resolve({ kind: 'unlocked' as const }))) {
    const onUnlocked = vi.fn();
    render(<LockScreen view={LOCKED} unlock={unlock} onUnlocked={onUnlocked} />);
    return { unlock, onUnlocked };
  }

  it('sets the entry-surface scope on the lock root', () => {
    renderWith();
    expect(document.querySelector('.session-lock')).toHaveAttribute('data-entry-surface');
  });

  it('carries the shared Ink band, with no second band and no sale content', () => {
    renderWith();
    expect(screen.getAllByTestId('entry-band')).toHaveLength(1);
    expect(screen.getByTestId('entry-band')).toHaveTextContent('Retail Tower');
    expect(document.querySelector('.session-lock')).toContainElement(
      screen.getByTestId('entry-band'),
    );
  });

  it('draws no ornament: the lock appears mid-sale (RT-1093, OD-5)', () => {
    renderWith();
    expect(screen.getByTestId('entry-band')).not.toHaveClass('v5-entry-band--ornament');
    expect(document.querySelector('.v5-entry-band__ornament')).toBeNull();
  });

  it('shows the sign-in PIN dock for a cashier, with no text field', () => {
    renderWith();
    expect(screen.getByTestId('pin-pad')).toBeInTheDocument();
    expect(screen.queryByLabelText('رمز PIN')).toBeNull();
    for (const k of '0123456789')
      expect(screen.getByTestId(`pin-pad-key-${k}`)).toBeInTheDocument();
    expect(screen.getByTestId('pin-pad-backspace')).toBeInTheDocument();
    expect(screen.getByTestId('pin-pad-enter')).toHaveTextContent('فتح القفل');
  });

  it('shows the Arabic-only format hint, with no Latin letters in the lock copy', () => {
    renderWith();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('من 4 إلى 6 أرقام.');
    expect(dialog.textContent).not.toMatch(/PIN/);
  });

  it('takes digits from the hardware keyboard and submits on Enter, like sign-in', async () => {
    const { unlock, onUnlocked } = renderWith();
    await userEvent.keyboard('1234');
    expect(screen.getByTestId('pin-pad-dots')).toHaveAccessibleName('الرقم السري، أُدخل 4 من 6');
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('9{Enter}');
    expect(unlock).toHaveBeenCalledWith({ method: 'pin', pin: '1239' });
    await vi.waitFor(() => {
      expect(onUnlocked).toHaveBeenCalled();
    });
  });

  it('takes digits from the on-screen keypad and clears them after a refusal', async () => {
    const unlock = vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'rate_limited' as const }),
    );
    renderWith(unlock as never);
    for (const k of '1234') await userEvent.click(screen.getByTestId(`pin-pad-key-${k}`));
    await userEvent.click(screen.getByTestId('pin-pad-enter'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.');
    expect(screen.getByTestId('pin-pad-dots')).toHaveAccessibleName('الرقم السري، أُدخل 0 من 6');
    expect(screen.getByTestId('pin-pad-dots')).toHaveAccessibleDescription(
      'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
    );
  });

  it('submits once on Enter after clicking digits (focus on a digit key), and not twice on the commit', async () => {
    const { unlock } = renderWith();
    for (const k of '1234') await userEvent.click(screen.getByTestId(`pin-pad-key-${k}`));
    await userEvent.keyboard('{Enter}');
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('Enter on the focused backspace key deletes a digit and never submits', async () => {
    const { unlock } = renderWith();
    await userEvent.keyboard('1234');
    screen.getByTestId('pin-pad-backspace').focus();
    await userEvent.keyboard('{Enter}');
    expect(unlock).not.toHaveBeenCalled();
    expect(screen.getByTestId('pin-pad-dots')).toHaveAccessibleName('الرقم السري، أُدخل 3 من 6');
  });

  it('keeps the commit inert below 4 digits and never reaches main', async () => {
    const { unlock } = renderWith();
    await userEvent.keyboard('12{Enter}');
    await userEvent.click(screen.getByTestId('pin-pad-enter'));
    expect(unlock).not.toHaveBeenCalled();
  });

  it('still takes digits when focus sits on the dialog panel, not a control', async () => {
    const { unlock } = renderWith();
    screen.getByRole('dialog').focus();
    expect(screen.getByRole('dialog')).toHaveFocus();
    await userEvent.keyboard('1234{Enter}');
    expect(unlock).toHaveBeenCalledWith({ method: 'pin', pin: '1234' });
  });

  it('keeps digits typed on the lock away from the sale behind it', async () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    renderWith();
    await userEvent.keyboard('12{Backspace}{Enter}');
    window.removeEventListener('keydown', behind);
    expect(behind).not.toHaveBeenCalled();
  });

  it('is right-to-left Arabic with an LTR keypad', () => {
    renderWith();
    expect(screen.getByRole('group', { name: 'إدخال الرقم السري' })).toHaveAttribute('dir', 'ltr');
  });

  it('spells «قليلًا» in the lock refusal and in no other way', () => {
    const src = readFileSync(resolve(__dirname, '../LockScreen.tsx'), 'utf-8');
    expect(src).toContain('قليلًا');
    expect(src).not.toContain('قليلاً');
  });

  it('keeps the manager credential form without a keypad', () => {
    render(
      <LockScreen view={{ ...LOCKED, role: 'manager' }} unlock={vi.fn()} onUnlocked={vi.fn()} />,
    );
    expect(screen.queryByTestId('pin-pad')).toBeNull();
    expect(screen.getByLabelText('كلمة المرور')).toBeInTheDocument();
  });
});
