/**
 * RT-1403 S2 (M1) — the return payout and the void payout share the terminal's ONE drawer: while a
 * void payout holds the slot a return payout is refused `another_payout_in_progress` (and nothing
 * is kicked), and a return payout in flight holds the slot the void payout needs until it ends.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import { createDrawerSlot, type DrawerSlot } from '../../drawer/drawer-slot.js';
import {
  confirmedReturn,
  deferredFake,
  initReturnsSql,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let slot: DrawerSlot;
let h: ReturnsHarness;

beforeEach(() => {
  slot = createDrawerSlot();
  h = returnsHarness({ drawerSlot: slot });
  seedSyncedSale(h.db);
});

afterEach(() => {
  h.close();
});

describe('one drawer for returns and voids', () => {
  it('refuses a return payout while a void payout holds the drawer, and never kicks', async () => {
    const returnId = await confirmedReturn(h.service);
    const release = slot.tryAcquire();
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'refused',
      reason: 'another_payout_in_progress',
    });
    expect(h.drawer.kicks).toBe(0);
    release?.();
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'paid_out',
    });
    expect(h.drawer.kicks).toBe(1);
  });

  it('holds the slot while the return payout runs and frees it when it ends', async () => {
    const returnId = await confirmedReturn(h.service);
    const kick = deferredFake<DrawerKickResult>();
    h.drawer.answer = () => kick.promise;
    const running = h.service.payout({ returnId, action: 'start' });
    await vi.waitFor(() => {
      expect(h.drawer.kicks).toBe(1);
    });
    expect(slot.busy()).toBe(true);
    expect(slot.tryAcquire()).toBeNull();
    kick.resolve({ ok: true });
    expect(await running).toMatchObject({ kind: 'paid_out' });
    expect(slot.busy()).toBe(false);
  });

  it('frees the slot after a refused payout, so the drawer is never held forever', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = () => Promise.resolve({ ok: false, failure_reason: 'os_error' });
    expect(await h.service.payout({ returnId, action: 'start' })).toMatchObject({
      kind: 'drawer_failed',
    });
    expect(slot.busy()).toBe(false);
  });
});
