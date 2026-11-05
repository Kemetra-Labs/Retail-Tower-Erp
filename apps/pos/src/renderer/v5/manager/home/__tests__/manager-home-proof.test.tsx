/**
 * RT-1193 — the DEV-only manager home harness (`#/dev/manager-home-proof`): its
 * query parameters seed the two reads, and the real home renders the counts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { resetShiftStores } from '../../../__tests__/__helpers__/shift-test-kit';
import { ManagerHomeProof, mountManagerHomeProof } from '../dev/ManagerHomeProof';

afterEach(() => {
  cleanup();
  resetShiftStores();
  delete (window as unknown as { api?: unknown }).api;
  window.location.hash = '';
});

const count = (title: string): HTMLElement | null =>
  screen.getByRole('link', { name: title }).querySelector('.v5-manager-tile__count');

describe('RT-1193 ManagerHomeProof', () => {
  it('shows a stuck payment and two stuck shifts for held=stuck&shifts=some', async () => {
    window.location.hash = '#/dev/manager-home-proof?held=stuck&shifts=some';
    render(<ManagerHomeProof />);
    await waitFor(() => {
      expect(count('الورديات العالقة')).toHaveTextContent('ورديتان عالقتان');
    });
    expect(count('المبيعات المعلقة')).toHaveTextContent('دفع معلّق');
  });

  it('shows only held sales for held=held, and nothing while shifts=pending', async () => {
    window.location.hash = '#/dev/manager-home-proof?held=held&shifts=pending';
    render(<ManagerHomeProof />);
    await waitFor(() => {
      expect(count('المبيعات المعلقة')).toHaveTextContent('مبيعات محفوظة');
    });
    expect(count('الورديات العالقة')).toBeNull();
  });

  it('shows no count at all by default', async () => {
    window.location.hash = '#/dev/manager-home-proof';
    render(<ManagerHomeProof />);
    await screen.findByRole('link', { name: 'الورديات العالقة' });
    await Promise.resolve();
    expect(count('المبيعات المعلقة')).toBeNull();
    expect(count('الورديات العالقة')).toBeNull();
  });

  it('mounts itself on the root main.tsx hands over', () => {
    const render = vi.fn();
    mountManagerHomeProof({ render, unmount: vi.fn() } as unknown as Root);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
