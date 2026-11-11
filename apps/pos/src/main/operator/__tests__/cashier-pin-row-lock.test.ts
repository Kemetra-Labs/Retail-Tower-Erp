/**
 * RT-1326 (RT-1125 R-17) — the per-row lock every writer of a cashier PIN row
 * goes through: sign-in, the same-operator unlock, the manager PIN reset and
 * the manager unlock.
 */
import { describe, expect, it } from 'vitest';

import { withCashierPinRowLock } from '../cashier-pin-row-lock.js';
import type { PinScope } from '../pin-lockout.js';

function scope(cashier: string): PinScope {
  return {
    tenant_id: 't',
    branch_id: 'b',
    terminal_id: 'term',
    cashier_clerk_user_id: cashier,
  };
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('withCashierPinRowLock', () => {
  it('runs tasks on the same row one after another, in call order', async () => {
    const first = gate();
    const order: string[] = [];
    const a = withCashierPinRowLock(scope('c1'), async () => {
      await first.wait;
      order.push('a');
    });
    const b = withCashierPinRowLock(scope('c1'), () => {
      order.push('b');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('does not hold one row behind another', async () => {
    const held = gate();
    const a = withCashierPinRowLock(scope('c1'), () => held.wait);
    const b = await withCashierPinRowLock(scope('c2'), () => Promise.resolve('done'));
    expect(b).toBe('done');
    held.open();
    await a;
  });

  it('keeps the queue going after a task rejects', async () => {
    const failed = withCashierPinRowLock(scope('c1'), () => Promise.reject(new Error('boom')));
    const next = withCashierPinRowLock(scope('c1'), () => Promise.resolve(42));
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe(42);
  });
});
