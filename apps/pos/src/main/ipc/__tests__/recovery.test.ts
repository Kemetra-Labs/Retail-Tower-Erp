import { describe, expect, it, vi } from 'vitest';

import {
  readCancelAttempt,
  readCancelHeldCart,
  readCancelHeldCarts,
  readCompleteAttempt,
  readPrepareCancelHeldCarts,
  registerRecoveryHandlers,
} from '../recovery.js';
import { RECOVERY_BATCH_MAX, RECOVERY_IPC_CHANNELS } from '../../../shared/operator/recovery.js';

/** RT-441 (§A4) — `recovery:*` takes closed shapes only. */

const APPROVAL = '0190f5a2-3b4c-7d8e-9f01-000000000001';

describe('recovery IPC validators', () => {
  it('completeAttempt: ids, an optional safe non-negative cash amount, nothing else', () => {
    expect(readCompleteAttempt({ payment_attempt_id: 'pa-1', approval_id: APPROVAL })).toEqual({
      payment_attempt_id: 'pa-1',
      approval_id: APPROVAL,
    });
    expect(
      readCompleteAttempt({
        payment_attempt_id: 'pa-1',
        approval_id: APPROVAL,
        cash_received_minor: 500,
      }),
    ).toMatchObject({ cash_received_minor: 500 });
    for (const bad of [
      null,
      [],
      { payment_attempt_id: 'pa-1' },
      { payment_attempt_id: 'pa-1', approval_id: 'not-a-uuid' },
      { payment_attempt_id: 'pa 1', approval_id: APPROVAL },
      { payment_attempt_id: 'pa-1', approval_id: APPROVAL, cash_received_minor: -1 },
      { payment_attempt_id: 'pa-1', approval_id: APPROVAL, cash_received_minor: 1.5 },
      { payment_attempt_id: 'pa-1', approval_id: APPROVAL, approver_user_id: 'forged' },
    ]) {
      expect(readCompleteAttempt(bad)).toBeNull();
    }
  });

  it('cancelAttempt: boolean confirmations only', () => {
    expect(
      readCancelAttempt({
        payment_attempt_id: 'pa-1',
        approval_id: APPROVAL,
        cash_returned_confirmed: true,
      }),
    ).toEqual({ payment_attempt_id: 'pa-1', approval_id: APPROVAL, cash_returned_confirmed: true });
    expect(
      readCancelAttempt({
        payment_attempt_id: 'pa-1',
        approval_id: APPROVAL,
        cash_returned_confirmed: 'yes',
      }),
    ).toBeNull();
  });

  it('cancelHeldCart: cart and approval only', () => {
    expect(readCancelHeldCart({ cart_id: 'c-1', approval_id: APPROVAL })).toEqual({
      cart_id: 'c-1',
      approval_id: APPROVAL,
    });
    expect(readCancelHeldCart({ cart_id: 'c-1', approval_id: APPROVAL, reason: 'x' })).toBeNull();
  });

  it('prepareCancelHeldCarts (RT-1563): 1..max distinct plain cart ids, nothing else', () => {
    expect(readPrepareCancelHeldCarts({ cart_ids: ['c-1', 'c-2'] })).toEqual({
      cart_ids: ['c-1', 'c-2'],
    });
    const many = Array.from({ length: RECOVERY_BATCH_MAX }, (_, i) => `c-${String(i)}`);
    expect(readPrepareCancelHeldCarts({ cart_ids: many })?.cart_ids).toHaveLength(
      RECOVERY_BATCH_MAX,
    );
    for (const bad of [
      null,
      [],
      {},
      { cart_ids: [] },
      { cart_ids: 'c-1' },
      { cart_ids: [...many, 'one-too-many'] },
      { cart_ids: ['c-1', 'c-1'] },
      { cart_ids: ['c 1'] },
      { cart_ids: ['c-1', 7] },
      { cart_ids: ['c-1'], approval_id: APPROVAL },
      { cart_ids: ['c-1'], total_minor: 1 },
    ]) {
      expect(readPrepareCancelHeldCarts(bad)).toBeNull();
    }
  });

  it('cancelHeldCarts (RT-1563): the batch reference and the approval, nothing else', () => {
    expect(readCancelHeldCarts({ batch_id: APPROVAL, approval_id: APPROVAL })).toEqual({
      batch_id: APPROVAL,
      approval_id: APPROVAL,
    });
    for (const bad of [
      null,
      { batch_id: APPROVAL },
      { batch_id: 'not-a-uuid', approval_id: APPROVAL },
      { batch_id: APPROVAL, approval_id: 'not-a-uuid' },
      { batch_id: APPROVAL, approval_id: APPROVAL, cart_ids: ['c-1'] },
      { batch_id: APPROVAL, approval_id: APPROVAL, reason: 'x' },
    ]) {
      expect(readCancelHeldCarts(bad)).toBeNull();
    }
  });
});

describe('recovery IPC handlers', () => {
  function register() {
    const handlers = new Map<string, (event: unknown, req?: unknown) => unknown>();
    const recovery = {
      listHeld: vi.fn(() => ({
        kind: 'held' as const,
        recovery_mode: false,
        stuck: null,
        held: [],
      })),
      completeAttempt: vi.fn(() =>
        Promise.resolve({ kind: 'completed' as const, change_due_minor: 0 }),
      ),
      cancelAttempt: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
      cancelHeldCart: vi.fn((): { kind: 'cancelled' } => {
        throw new Error('boom');
      }),
      prepareCancelHeldCarts: vi.fn(() => ({
        kind: 'refused' as const,
        reason: 'not_found' as const,
      })),
      cancelHeldCarts: vi.fn((): { kind: 'refused'; reason: 'not_found' } => {
        throw new Error('boom');
      }),
    };
    const logger = { warn: vi.fn() };
    registerRecoveryHandlers(
      {
        handle: (c: string, fn: (event: unknown, req?: unknown) => unknown) => handlers.set(c, fn),
      } as never,
      { recovery, logger },
    );
    return { handlers, recovery, logger };
  }

  it('an invalid payload reaches nothing', async () => {
    const { handlers, recovery } = register();
    await expect(
      Promise.resolve(handlers.get(RECOVERY_IPC_CHANNELS.COMPLETE_ATTEMPT)?.({}, { bad: true })),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    expect(recovery.completeAttempt).not.toHaveBeenCalled();
  });

  it('a throw answers recovery_unavailable, logged by name only', async () => {
    const { handlers, logger } = register();
    await expect(
      Promise.resolve(
        handlers.get(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CART)?.(
          {},
          { cart_id: 'c', approval_id: APPROVAL },
        ),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'recovery_unavailable' });
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'cancelHeldCart', error: 'Error' },
      'recovery:failed',
    );
  });

  it('the batch channels validate first, then call main (RT-1563)', async () => {
    const { handlers, recovery, logger } = register();
    await expect(
      Promise.resolve(
        handlers.get(RECOVERY_IPC_CHANNELS.PREPARE_CANCEL_HELD_CARTS)?.({}, { cart_ids: [] }),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    await expect(
      Promise.resolve(
        handlers.get(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CARTS)?.(
          {},
          { batch_id: 'x', approval_id: APPROVAL },
        ),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'invalid_input' });
    expect(recovery.prepareCancelHeldCarts).not.toHaveBeenCalled();
    expect(recovery.cancelHeldCarts).not.toHaveBeenCalled();
    await expect(
      Promise.resolve(
        handlers.get(RECOVERY_IPC_CHANNELS.PREPARE_CANCEL_HELD_CARTS)?.({}, { cart_ids: ['c-1'] }),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'not_found' });
    expect(recovery.prepareCancelHeldCarts).toHaveBeenCalledWith({ cart_ids: ['c-1'] });
    await expect(
      Promise.resolve(
        handlers.get(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CARTS)?.(
          {},
          { batch_id: APPROVAL, approval_id: APPROVAL },
        ),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'recovery_unavailable' });
    expect(logger.warn).toHaveBeenCalledWith(
      { op: 'cancelHeldCarts', error: 'Error' },
      'recovery:failed',
    );
  });

  it('listHeld takes no payload', async () => {
    const { handlers } = register();
    await expect(
      Promise.resolve(handlers.get(RECOVERY_IPC_CHANNELS.LIST_HELD)?.({})),
    ).resolves.toMatchObject({
      kind: 'held',
    });
    expect(handlers.get(RECOVERY_IPC_CHANNELS.LIST_HELD)?.({}, { x: 1 })).toEqual({
      kind: 'refused',
      reason: 'invalid_input',
    });
  });
});
