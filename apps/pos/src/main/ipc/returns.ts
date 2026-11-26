/**
 * RT-15 S2 — `returns:*` IPC registration (§A4 bridge security).
 *
 * The renderer is untrusted input. Each request is validated here before the
 * service runs, and anything outside the closed shape is `invalid_input`:
 *
 *   • `saleNumber`: a string of 1..64 printable characters (no control chars);
 *   • `lines`: 1..50 entries, each exactly `{ lineRef, quantity }` with a
 *     canonical UUID `lineRef` (unique per request) and a whole `quantity` in
 *     1..10 000;
 *   • no other key anywhere (no operator id, scope, amount, key or saleRef can
 *     be smuggled in — scope, saleRef, money and the Idempotency-Key are
 *     derived in main);
 *   • `resolve` / `list` take no payload;
 *   • RT-15 S4 `payout`: exactly `{ returnId, action }` with a canonical UUID
 *     and an action in the closed set; `reprintSlip`: exactly `{ returnId }`.
 *     No amount can be sent: main pays the journal's server-confirmed total;
 *   • RT-1498 `resend`: exactly `{ returnId }` with a canonical UUID. The key,
 *     the body, the scope and the operator are derived in main from the row;
 *   • RT-1498 S4/S5 `escalate`: exactly `{ returnId, approvalId }`, both canonical UUIDs.
 *     The disposition is fixed by the channel, and the approval (bound to this return and to
 *     `escalate`) is spent in main; no operator, scope, amount or reason can be smuggled in.
 *   • RT-1498 close slice `readStatus`: exactly `{ returnId }` (a canonical UUID). The sale, the
 *     provenance and the credential are derived in main from the journaled row, and the verdict is the
 *     server's. `close`: exactly `{ returnId, approvalId }`, both canonical UUIDs; the disposition is
 *     fixed by the channel, the approval (bound to this return and to `close`) is spent in main, and no
 *     verdict, read time, reason, operator, scope or amount can be smuggled in.
 *
 * Session, role, feature gate and every business rule live in the service.
 * The channels are not on the locked-session allowlist, so the guarded
 * `ipcMain` refuses them while the session is locked.
 */
import type { IpcMain } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../shared/returns/channels.js';
import {
  RETURN_PAYOUT_ACTIONS,
  type ReturnLineInput,
  type ReturnPayoutAction,
  type ReturnsBridgeAPI,
  type ReturnsCloseRequest,
  type ReturnsEscalateRequest,
  type ReturnsPayoutRequest,
  type ReturnsQuoteRequest,
  type ReturnsReadStatusRequest,
  type ReturnsReprintRequest,
  type ReturnsResendRequest,
} from '../../shared/returns/types.js';
import { isUuid } from '../returns/returns-wire.js';
import { closed } from './validation.js';

export const RETURNS_INPUT_BOUNDS = {
  saleNumberMaxLength: 64,
  maxLines: 50,
  maxQuantity: 10_000,
} as const;

const PRINTABLE = /^[^\p{Cc}]+$/u;
const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;

const LINE_KEYS = ['lineRef', 'quantity'] as const;
const LOOKUP_KEYS = ['saleNumber'] as const;
const QUOTE_KEYS = ['saleNumber', 'lines'] as const;
const PAYOUT_KEYS = ['returnId', 'action'] as const;
const REPRINT_KEYS = ['returnId'] as const;
const RESEND_KEYS = ['returnId'] as const;
const ESCALATE_KEYS = ['returnId', 'approvalId'] as const;
const READ_STATUS_KEYS = ['returnId'] as const;
const CLOSE_KEYS = ['returnId', 'approvalId'] as const;

/** 1 ≤ n ≤ max — the one bound used for lengths, counts and quantities. */
function isWithin(n: number, max: number): boolean {
  return n >= 1 && n <= max;
}

function isSaleNumber(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return isWithin(value.length, RETURNS_INPUT_BOUNDS.saleNumberMaxLength) && PRINTABLE.test(value);
}

function isLineRef(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value);
}

function isWholeQty(value: unknown): value is number {
  return Number.isSafeInteger(value) && isWithin(value as number, RETURNS_INPUT_BOUNDS.maxQuantity);
}

function isLine(value: ReturnLineInput | null): value is ReturnLineInput {
  return value !== null;
}

function hasUniqueLineRefs(lines: readonly ReturnLineInput[]): boolean {
  return new Set(lines.map((l) => l.lineRef.toLowerCase())).size === lines.length;
}

/** A bounded sale number, or null. */
export function readSaleNumber(value: unknown): string | null {
  return isSaleNumber(value) ? value : null;
}

function readLine(value: unknown): ReturnLineInput | null {
  if (!closed(value, LINE_KEYS)) return null;
  const { lineRef, quantity } = value;
  return isLineRef(lineRef) && isWholeQty(quantity) ? { lineRef, quantity } : null;
}

/** Validated, unique-per-request lines, or null. */
export function readLines(value: unknown): ReturnLineInput[] | null {
  if (!Array.isArray(value) || !isWithin(value.length, RETURNS_INPUT_BOUNDS.maxLines)) return null;
  const lines = value.map(readLine);
  if (!lines.every(isLine)) return null;
  return hasUniqueLineRefs(lines) ? lines : null;
}

/** `{ saleNumber }` exactly, or null. */
export function readLookupRequest(value: unknown): { saleNumber: string } | null {
  if (!closed(value, LOOKUP_KEYS)) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  return saleNumber === null ? null : { saleNumber };
}

/** `{ saleNumber, lines }` exactly, or null. */
export function readQuoteRequest(value: unknown): ReturnsQuoteRequest | null {
  if (!closed(value, QUOTE_KEYS)) return null;
  const saleNumber = readSaleNumber(value['saleNumber']);
  const lines = readLines(value['lines']);
  return saleNumber === null || lines === null ? null : { saleNumber, lines };
}

function isReturnId(value: unknown): value is string {
  return typeof value === 'string' && isUuid(value);
}

function isPayoutAction(value: unknown): value is ReturnPayoutAction {
  return (RETURN_PAYOUT_ACTIONS as readonly unknown[]).includes(value);
}

/** `{ returnId, action }` exactly, or null. */
export function readPayoutRequest(value: unknown): ReturnsPayoutRequest | null {
  if (!closed(value, PAYOUT_KEYS)) return null;
  const { returnId, action } = value;
  return isReturnId(returnId) && isPayoutAction(action) ? { returnId, action } : null;
}

/** `{ returnId }` exactly, or null. */
export function readReprintRequest(value: unknown): ReturnsReprintRequest | null {
  if (!closed(value, REPRINT_KEYS)) return null;
  const { returnId } = value;
  return isReturnId(returnId) ? { returnId } : null;
}

/** `{ returnId }` exactly (RT-1498 `resend`), or null. */
export function readResendRequest(value: unknown): ReturnsResendRequest | null {
  if (!closed(value, RESEND_KEYS)) return null;
  const { returnId } = value;
  return isReturnId(returnId) ? { returnId } : null;
}

/** `{ returnId, approvalId }` exactly (RT-1498 `escalate`), or null. */
export function readEscalateRequest(value: unknown): ReturnsEscalateRequest | null {
  if (!closed(value, ESCALATE_KEYS)) return null;
  const { returnId, approvalId } = value;
  return isReturnId(returnId) && isReturnId(approvalId) ? { returnId, approvalId } : null;
}

/** `{ returnId }` exactly (RT-1498 close slice `readStatus`), or null. */
export function readStatusRequest(value: unknown): ReturnsReadStatusRequest | null {
  if (!closed(value, READ_STATUS_KEYS)) return null;
  const { returnId } = value;
  return isReturnId(returnId) ? { returnId } : null;
}

/** `{ returnId, approvalId }` exactly (RT-1498 close slice `close`), or null. */
export function readCloseRequest(value: unknown): ReturnsCloseRequest | null {
  if (!closed(value, CLOSE_KEYS)) return null;
  const { returnId, approvalId } = value;
  return isReturnId(returnId) && isReturnId(approvalId) ? { returnId, approvalId } : null;
}

/** `resolve` / `list` accept no payload (undefined or `{}`). */
function isEmptyPayload(value: unknown): boolean {
  return value === undefined || closed(value, []);
}

export interface ReturnsIpcDeps {
  readonly service: ReturnsBridgeAPI;
}

export function registerReturnsHandlers(ipcMain: IpcMain, deps: ReturnsIpcDeps): void {
  const { service } = deps;

  ipcMain.handle(RETURNS_IPC_CHANNELS.LOOKUP, (_event, request: unknown) => {
    const req = readLookupRequest(request);
    return req === null ? INVALID : service.lookup(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.QUOTE, (_event, request: unknown) => {
    const req = readQuoteRequest(request);
    return req === null ? INVALID : service.quote(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.SUBMIT, (_event, request: unknown) => {
    const req = readQuoteRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.submit(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.RESOLVE, (_event, request: unknown) =>
    isEmptyPayload(request) ? service.resolve() : INVALID,
  );

  ipcMain.handle(RETURNS_IPC_CHANNELS.LIST, (_event, request: unknown) =>
    isEmptyPayload(request) ? service.list() : INVALID,
  );

  ipcMain.handle(RETURNS_IPC_CHANNELS.PAYOUT, (_event, request: unknown) => {
    const req = readPayoutRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.payout(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.REPRINT_SLIP, (_event, request: unknown) => {
    const req = readReprintRequest(request);
    return req === null ? INVALID : service.reprintSlip(req);
  });

  // RT-1498: the answer shape is `submit`'s, so a refusal carries `ret: null`.
  ipcMain.handle(RETURNS_IPC_CHANNELS.RESEND, (_event, request: unknown) => {
    const req = readResendRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.resend(req);
  });

  // RT-1498 S4/S5: a refusal carries `ret: null`, like `resend`.
  ipcMain.handle(RETURNS_IPC_CHANNELS.ESCALATE, (_event, request: unknown) => {
    const req = readEscalateRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.escalate(req);
  });

  // RT-1498 close slice: a refusal carries `ret: null`, like `escalate`.
  ipcMain.handle(RETURNS_IPC_CHANNELS.READ_STATUS, (_event, request: unknown) => {
    const req = readStatusRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.readStatus(req);
  });

  ipcMain.handle(RETURNS_IPC_CHANNELS.CLOSE, (_event, request: unknown) => {
    const req = readCloseRequest(request);
    return req === null ? { ...INVALID, ret: null } : service.close(req);
  });
}
