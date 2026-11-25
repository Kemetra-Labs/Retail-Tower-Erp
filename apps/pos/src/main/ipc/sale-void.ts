/**
 * RT-530 — `sale-void:*` IPC.
 *
 * Closed shapes, validated before the service runs; anything else answers
 * `invalid_input` and reaches nothing. None of these channels is on the
 * locked-session allowlist (default deny). An unexpected failure is logged by
 * its name only and answers `void_unavailable`.
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import {
  SALE_VOID_IPC_CHANNELS,
  SALE_VOID_PAYOUT_ACTIONS,
  type SaleVoidPayoutAction,
  type SaleVoidAcknowledgeRequest,
  type SaleVoidCashExceptionRequest,
  type SaleVoidLookupRequest,
  type SaleVoidPayOutRequest,
  type SaleVoidRefused,
  type SaleVoidRequest,
} from '../../shared/sale-void/types.js';
import type { SaleVoidService } from '../sale-void/sale-void-service.js';
import { closed, createIpcRunner } from './validation.js';

const INVALID: SaleVoidRefused = { kind: 'refused', reason: 'invalid_input' };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SALE_NUMBER_MAX_LENGTH = 64;

const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export function readLookup(value: unknown): SaleVoidLookupRequest | null {
  if (!closed(value, ['sale_number'])) return null;
  const { sale_number } = value;
  const valid =
    typeof sale_number === 'string' &&
    sale_number.trim().length > 0 &&
    sale_number.length <= SALE_NUMBER_MAX_LENGTH;
  return valid ? { sale_number: sale_number.trim() } : null;
}

export function readRequest(value: unknown): SaleVoidRequest | null {
  if (!closed(value, ['sale_id', 'approval_id'])) return null;
  const { sale_id, approval_id } = value;
  const valid = isId(sale_id) && typeof approval_id === 'string' && APPROVAL_ID.test(approval_id);
  return valid ? { sale_id, approval_id } : null;
}

export function readAcknowledge(value: unknown): SaleVoidAcknowledgeRequest | null {
  if (!closed(value, ['void_id'])) return null;
  return isId(value['void_id']) ? { void_id: value['void_id'] } : null;
}

const isPayoutAction = (v: unknown): v is SaleVoidPayoutAction =>
  typeof v === 'string' && (SALE_VOID_PAYOUT_ACTIONS as readonly string[]).includes(v);

/**
 * RT-1403 S2: a payout names the void and its step; the amount is the journal's, the shift is main's.
 */
export function readPayOut(value: unknown): SaleVoidPayOutRequest | null {
  if (!closed(value, ['void_id', 'action'])) return null;
  const { void_id, action } = value;
  return isId(void_id) && isPayoutAction(action) ? { void_id, action } : null;
}

/** RT-1403 S2: a cash exception names the void and its single-use approval, nothing else. */
export function readCashException(value: unknown): SaleVoidCashExceptionRequest | null {
  if (!closed(value, ['void_id', 'approval_id'])) return null;
  const { void_id, approval_id } = value;
  const valid = isId(void_id) && typeof approval_id === 'string' && APPROVAL_ID.test(approval_id);
  return valid ? { void_id, approval_id } : null;
}

export interface SaleVoidIpcDeps {
  service: Pick<
    SaleVoidService,
    'lookup' | 'request' | 'list' | 'acknowledge' | 'payOut' | 'recordCashException'
  >;
  logger: Pick<Logger, 'warn'>;
}

export function registerSaleVoidHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: SaleVoidIpcDeps,
): void {
  const { service, logger } = deps;
  const { runIpc: run } = createIpcRunner<SaleVoidRefused>(logger, 'sale_void:failed', () => ({
    kind: 'refused',
    reason: 'void_unavailable',
  }));

  ipcMain.handle(SALE_VOID_IPC_CHANNELS.LOOKUP, (_event, request: unknown) => {
    const req = readLookup(request);
    return req === null ? INVALID : run('lookup', () => service.lookup(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.REQUEST, (_event, request: unknown) => {
    const req = readRequest(request);
    return req === null ? INVALID : run('request', () => service.request(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    request === undefined ? run('list', () => service.list()) : INVALID,
  );
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.ACKNOWLEDGE, (_event, request: unknown) => {
    const req = readAcknowledge(request);
    return req === null ? INVALID : run('acknowledge', () => service.acknowledge(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.PAY_OUT, (_event, request: unknown) => {
    const req = readPayOut(request);
    return req === null ? INVALID : run('payOut', () => service.payOut(req));
  });
  ipcMain.handle(SALE_VOID_IPC_CHANNELS.CASH_EXCEPTION, (_event, request: unknown) => {
    const req = readCashException(request);
    return req === null ? INVALID : run('cashException', () => service.recordCashException(req));
  });
}
