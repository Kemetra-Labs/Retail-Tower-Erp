import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { Banner } from '../Banner';
import { Notice } from '../Notice';

/**
 * RT-241 (VNext W1-A) — the message primitives (freeze 15 §4):
 *
 * - `Banner`: persistent operational state in the frame's status area. Never
 *   auto-dismisses; danger interrupts (alert), the rest is polite (status).
 * - `Notice`: inline validation / empty state / outcome inside its region.
 *
 * Every tone carries text plus an icon, never colour alone (P8).
 */

afterEach(cleanup);

describe('Banner', () => {
  it('a warning is polite and persistent, with a visible tone icon', () => {
    render(<Banner tone="warning">لم يُفتح درج النقود. افتحه يدويًا.</Banner>);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('لم يُفتح درج النقود. افتحه يدويًا.');
    expect(banner).toHaveAttribute('data-tone', 'warning');
    expect(banner.querySelector('[data-icon="warning"]')).not.toBeNull();
  });

  it('danger interrupts (alert)', () => {
    render(<Banner tone="danger">تعذّر حفظ البيع.</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('تعذّر حفظ البيع.');
  });

  it('carries its actions in the banner', async () => {
    const onAck = vi.fn();
    render(
      <Banner
        tone="warning"
        actions={
          <button type="button" onClick={onAck}>
            تم
          </button>
        }
      >
        نص
      </Banner>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'تم' }));
    expect(onAck).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(<Banner tone="info">معلومة</Banner>);
    await expectNoAxeViolations(container);
  });
});

describe('Notice', () => {
  it.each([
    ['info', 'status'],
    ['success', 'status'],
    ['warning', 'status'],
    ['danger', 'alert'],
  ] as const)('%s renders as %s with its tone icon', (tone, role) => {
    render(<Notice tone={tone}>نص التنبيه</Notice>);
    const notice = screen.getByRole(role);
    expect(notice).toHaveAttribute('data-tone', tone);
    expect(notice.querySelector(`[data-icon="${tone}"]`)).not.toBeNull();
  });
});

describe('Notice — announce', () => {
  it('announce={false}: a repeat of a message another live region already announces', () => {
    render(
      <Notice tone="warning" announce={false} testId="n">
        نص
      </Notice>,
    );
    const notice = screen.getByTestId('n');
    expect(notice).not.toHaveAttribute('role');
    expect(notice.querySelector('[data-icon="warning"]')).not.toBeNull();
  });
});
