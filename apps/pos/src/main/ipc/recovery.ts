/**
 * RT-441 (RT-116 §5.2, §7.2) — `recovery:*` IPC.
 *
 * Closed shapes, validated before the service runs; anything else answers
 * `invalid_input` and reaches nothing. None of these channels is on the
 * locked-session allowlist (default deny). An unexpected failure is logged by
 * its name only and answers `recovery_unavailable`.
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import {
  RECOVERY_BATCH_MAX,
  RECOVERY_IPC_CHANNELS,
  type RecoveryCancelAttemptRequest,
  type RecoveryCancelHeldCartRequest,
  type RecoveryCancelHeldCartsRequest,
  type RecoveryCompleteAttemptRequest,
  type RecoveryPrepareCancelHeldCartsRequest,
  type RecoveryRefusal,
} from '../../shared/operator/recovery.js';
import type { ManagerRecovery } from '../recovery/manager-recovery.js';
import { closed, createIpcRunner } from './validation.js';

const INVALID: RecoveryRefusal = { kind: 'refused', reason: 'invalid_input' };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^[0-9a-f-]{36}$/;
const MAX_CASH_MINOR = 1_000_000_000;

const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isApprovalId = (v: unknown): v is string => typeof v === 'string' && APPROVAL_ID.test(v);
const optionalFlag = (v: unknown): boolean => v === undefined || typeof v === 'boolean';

/** Integer minor units within the main-process cash bound (RT-437). */
function isCashMinor(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CASH_MINOR;
}

export function readCompleteAttempt(value: unknown): RecoveryCompleteAttemptRequest | null {
  if (!closed(value, ['payment_attempt_id', 'approval_id', 'cash_received_minor'])) return null;
  const { payment_attempt_id, approval_id, cash_received_minor } = value;
  if (!isId(payment_attempt_id) || !isApprovalId(approval_id)) return null;
  if (cash_received_minor === undefined) return { payment_attempt_id, approval_id };
  return isCashMinor(cash_received_minor)
    ? { payment_attempt_id, approval_id, cash_received_minor }
    : null;
}

export function readCancelAttempt(value: unknown): RecoveryCancelAttemptRequest | null {
  const keys = [
    'payment_attempt_id',
    'approval_id',
    'cash_returned_confirmed',
    'card_void_confirmed_on_terminal',
  ];
  if (!closed(value, keys)) return null;
  const {
    payment_attempt_id,
    approval_id,
    cash_returned_confirmed,
    card_void_confirmed_on_terminal,
  } = value;
  if (!isId(payment_attempt_id) || !isApprovalId(approval_id)) return null;
  if (!optionalFlag(cash_returned_confirmed) || !optionalFlag(card_void_confirmed_on_terminal)) {
    return null;
  }
  return {
    payment_attempt_id,
    approval_id,
    ...(cash_returned_confirmed === undefined
      ? {}
      : { cash_returned_confirmed: cash_returned_confirmed as boolean }),
    ...(card_void_confirmed_on_terminal === undefined
      ? {}
      : { card_void_confirmed_on_terminal: card_void_confirmed_on_terminal as boolean }),
  };
}

export function readCancelHeldCart(value: unknown): RecoveryCancelHeldCartRequest | null {
  if (!closed(value, ['cart_id', 'approval_id'])) return null;
  const { cart_id, approval_id } = value;
  return isId(cart_id) && isApprovalId(approval_id) ? { cart_id, approval_id } : null;
}

/** RT-1563: the cart ids to snapshot; each a plain id, none repeated, at most `RECOVERY_BATCH_MAX`. */
export function readPrepareCancelHeldCarts(
  value: unknown,
): RecoveryPrepareCancelHeldCartsRequest | null {
  if (!closed(value, ['cart_ids'])) return null;
  const { cart_ids } = value;
  if (!Array.isArray(cart_ids) || cart_ids.length < 1 || cart_ids.length > RECOVERY_BATCH_MAX) {
    return null;
  }
  return cart_ids.every(isId) && new Set(cart_ids).size === cart_ids.length ? { cart_ids } : null;
}

/** RT-1563: the batch reference (a UUID main minted) and the approval. Nothing else crosses. */
export function readCancelHeldCarts(value: unknown): RecoveryCancelHeldCartsRequest | null {
  if (!closed(value, ['batch_id', 'approval_id'])) return null;
  const { batch_id, approval_id } = value;
  return isApprovalId(batch_id) && isApprovalId(approval_id) ? { batch_id, approval_id } : null;
}

export interface RecoveryIpcDeps {
  recovery: Pick<
    ManagerRecovery,
    | 'listHeld'
    | 'completeAttempt'
    | 'cancelAttempt'
    | 'cancelHeldCart'
    | 'prepareCancelHeldCarts'
    | 'cancelHeldCarts'
  >;
  logger: Pick<Logger, 'warn'>;
}

export function registerRecoveryHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: RecoveryIpcDeps,
): void {
  const { recovery, logger } = deps;
  const { runIpc: run } = createIpcRunner<RecoveryRefusal>(logger, 'recovery:failed', () => ({
    kind: 'refused',
    reason: 'recovery_unavailable',
  }));

  ipcMain.handle(RECOVERY_IPC_CHANNELS.LIST_HELD, (_event, request: unknown) =>
    request === undefined ? run('listHeld', () => recovery.listHeld()) : INVALID,
  );
  ipcMain.handle(RECOVERY_IPC_CHANNELS.COMPLETE_ATTEMPT, (_event, request: unknown) => {
    const req = readCompleteAttempt(request);
    return req === null ? INVALID : run('completeAttempt', () => recovery.completeAttempt(req));
  });
  ipcMain.handle(RECOVERY_IPC_CHANNELS.CANCEL_ATTEMPT, (_event, request: unknown) => {
    const req = readCancelAttempt(request);
    return req === null ? INVALID : run('cancelAttempt', () => recovery.cancelAttempt(req));
  });
  ipcMain.handle(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CART, (_event, request: unknown) => {
    const req = readCancelHeldCart(request);
    return req === null ? INVALID : run('cancelHeldCart', () => recovery.cancelHeldCart(req));
  });
  ipcMain.handle(RECOVERY_IPC_CHANNELS.PREPARE_CANCEL_HELD_CARTS, (_event, request: unknown) => {
    const req = readPrepareCancelHeldCarts(request);
    return req === null
      ? INVALID
      : run('prepareCancelHeldCarts', () => recovery.prepareCancelHeldCarts(req));
  });
  ipcMain.handle(RECOVERY_IPC_CHANNELS.CANCEL_HELD_CARTS, (_event, request: unknown) => {
    const req = readCancelHeldCarts(request);
    return req === null ? INVALID : run('cancelHeldCarts', () => recovery.cancelHeldCarts(req));
  });
}
