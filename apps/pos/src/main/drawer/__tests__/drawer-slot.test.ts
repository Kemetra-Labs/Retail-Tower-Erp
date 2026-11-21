/** RT-1403 S2 (M1) — the one drawer slot returns and void payouts share. */
import { describe, expect, it } from 'vitest';

import { createDrawerSlot, terminalDrawerSlot } from '../drawer-slot.js';

describe('drawer slot', () => {
  it('is held by one payout at a time and free again after its release', () => {
    const slot = createDrawerSlot();
    expect(slot.busy()).toBe(false);
    const release = slot.tryAcquire();
    expect(release).not.toBeNull();
    expect(slot.busy()).toBe(true);
    expect(slot.tryAcquire()).toBeNull();
    release?.();
    expect(slot.busy()).toBe(false);
    expect(slot.tryAcquire()).not.toBeNull();
  });

  it('a stale release never frees the slot of a later holder', () => {
    const slot = createDrawerSlot();
    const first = slot.tryAcquire();
    first?.();
    const second = slot.tryAcquire();
    first?.();
    expect(slot.busy()).toBe(true);
    second?.();
    expect(slot.busy()).toBe(false);
  });

  it('the terminal slot is one shared instance', () => {
    expect(terminalDrawerSlot.busy()).toBe(false);
  });
});
