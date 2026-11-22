/**
 * RT-1498 close slice — `returns:readStatus` and `returns:close` IPC. The renderer is untrusted:
 *   • `readStatus` is exactly `{ returnId }`, `close` exactly `{ returnId, approvalId }`, canonical UUIDs;
 *   • no scope, operator, amount, saleRef, provenance, verdict, disposition, reason or time can be
 *     smuggled in: the sale, the provenance and the verdict come from main and the server;
 *   • neither channel is on the locked-session allowlist, so a locked session is refused (default
 *     deny); recovery mode refuses every `returns:*` channel (`recovery-mode-guard.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../../shared/returns/channels.js';
import type { ReturnsBridgeAPI } from '../../../shared/returns/types.js';
import { readCloseRequest, readStatusRequest, registerReturnsHandlers } from '../returns.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';
import { createRecoveryModeGuardedIpcMain, RecoveryModeError } from '../recovery-mode-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000a';
const APPROVAL_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000b';
const INVALID = { kind: 'refused', reason: 'invalid_input', ret: null };

function setup(guard: { locked?: boolean; recovery?: boolean } = {}) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: () => raw,
  } as unknown as IpcMain;
  const service = {
    readStatus: vi.fn(() => Promise.resolve({ kind: 'inconclusive', ret: null, cause: 'offline' })),
    close: vi.fn(() => Promise.resolve({ kind: 'closed', ret: null })),
  };
  const guarded = createRecoveryModeGuardedIpcMain(
    createSessionLockGuardedIpcMain(raw, () => guard.locked === true),
    () => guard.recovery === true,
  );
  registerReturnsHandlers(guarded, { service: service as unknown as ReturnsBridgeAPI });
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, invoke };
}

describe('the channels', () => {
  it('are named returns:readStatus and returns:close, off the locked-session allowlist', () => {
    expect(RETURNS_IPC_CHANNELS.READ_STATUS).toBe('returns:readStatus');
    expect(RETURNS_IPC_CHANNELS.CLOSE).toBe('returns:close');
    expect(LOCKED_ALLOWED_CHANNELS.has(RETURNS_IPC_CHANNELS.READ_STATUS)).toBe(false);
    expect(LOCKED_ALLOWED_CHANNELS.has(RETURNS_IPC_CHANNELS.CLOSE)).toBe(false);
  });

  it.each([
    [RETURNS_IPC_CHANNELS.READ_STATUS, { returnId: RETURN_ID }],
    [RETURNS_IPC_CHANNELS.CLOSE, { returnId: RETURN_ID, approvalId: APPROVAL_ID }],
  ])('%s is refused while the session is locked, and nothing runs', async (channel, payload) => {
    const { invoke, service } = setup({ locked: true });
    await expect(invoke(channel, payload)).rejects.toBeInstanceOf(SessionLockedError);
    expect(service.readStatus).not.toHaveBeenCalled();
    expect(service.close).not.toHaveBeenCalled();
  });

  it.each([
    [RETURNS_IPC_CHANNELS.READ_STATUS, { returnId: RETURN_ID }],
    [RETURNS_IPC_CHANNELS.CLOSE, { returnId: RETURN_ID, approvalId: APPROVAL_ID }],
  ])('%s is refused in recovery mode, and nothing runs', async (channel, payload) => {
    const { invoke, service } = setup({ recovery: true });
    await expect(invoke(channel, payload)).rejects.toBeInstanceOf(RecoveryModeError);
    expect(service.readStatus).not.toHaveBeenCalled();
    expect(service.close).not.toHaveBeenCalled();
  });
});

describe('returns:readStatus', () => {
  it('forwards exactly { returnId } to the service and returns its answer', async () => {
    const { invoke, service } = setup();
    await expect(
      invoke(RETURNS_IPC_CHANNELS.READ_STATUS, { returnId: RETURN_ID }),
    ).resolves.toEqual({
      kind: 'inconclusive',
      ret: null,
      cause: 'offline',
    });
    expect(service.readStatus).toHaveBeenCalledWith({ returnId: RETURN_ID });
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['null', null],
    ['an array', [RETURN_ID]],
    ['a bare string', RETURN_ID],
    ['a missing return id', {}],
    ['a non-UUID return id', { returnId: 'ret-1' }],
    ['an injection string', { returnId: "x' OR 1=1" }],
    ['a smuggled sale ref', { returnId: RETURN_ID, saleRef: RETURN_ID }],
    ['a smuggled provenance', { returnId: RETURN_ID, externalId: 'pos-pulse-return:x' }],
    ['a smuggled source system', { returnId: RETURN_ID, sourceSystem: 'pos-pulse' }],
    ['a smuggled verdict', { returnId: RETURN_ID, verdict: 'not_recorded' }],
    ['a smuggled operator', { returnId: RETURN_ID, operatorId: 'op-x' }],
    ['a smuggled scope', { returnId: RETURN_ID, tenantId: 't2' }],
  ])('refuses %s as invalid_input without calling the service', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.READ_STATUS, payload)).resolves.toEqual(INVALID);
    expect(service.readStatus).not.toHaveBeenCalled();
  });

  it('readStatusRequest reads the closed shape only', () => {
    expect(readStatusRequest({ returnId: RETURN_ID })).toEqual({ returnId: RETURN_ID });
    expect(readStatusRequest({ returnId: RETURN_ID, approvalId: APPROVAL_ID })).toBeNull();
  });
});

describe('returns:close', () => {
  it('forwards exactly { returnId, approvalId } to the service and returns its answer', async () => {
    const { invoke, service } = setup();
    await expect(
      invoke(RETURNS_IPC_CHANNELS.CLOSE, { returnId: RETURN_ID, approvalId: APPROVAL_ID }),
    ).resolves.toEqual({ kind: 'closed', ret: null });
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveBeenCalledWith({ returnId: RETURN_ID, approvalId: APPROVAL_ID });
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['null', null],
    ['an array', [RETURN_ID, APPROVAL_ID]],
    ['a bare string', RETURN_ID],
    ['a missing return id', { approvalId: APPROVAL_ID }],
    ['a missing approval id', { returnId: RETURN_ID }],
    ['a non-UUID return id', { returnId: 'ret-1', approvalId: APPROVAL_ID }],
    ['a non-UUID approval id', { returnId: RETURN_ID, approvalId: 'appr-1' }],
    ['a numeric approval id', { returnId: RETURN_ID, approvalId: 7 }],
    [
      'a smuggled disposition',
      { returnId: RETURN_ID, approvalId: APPROVAL_ID, disposition: 'escalate' },
    ],
    [
      'a smuggled verdict',
      { returnId: RETURN_ID, approvalId: APPROVAL_ID, verdict: 'not_recorded' },
    ],
    ['a smuggled read time', { returnId: RETURN_ID, approvalId: APPROVAL_ID, readVerdictAt: 't' }],
    ['a smuggled reason', { returnId: RETURN_ID, approvalId: APPROVAL_ID, reason: 'x' }],
    ['a smuggled operator', { returnId: RETURN_ID, approvalId: APPROVAL_ID, operatorId: 'op-x' }],
    ['a smuggled amount', { returnId: RETURN_ID, approvalId: APPROVAL_ID, amountMinor: 1 }],
  ])('refuses %s as invalid_input without calling the service', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.CLOSE, payload)).resolves.toEqual(INVALID);
    expect(service.close).not.toHaveBeenCalled();
  });

  it('readCloseRequest reads the closed shape only', () => {
    expect(readCloseRequest({ returnId: RETURN_ID, approvalId: APPROVAL_ID })).toEqual({
      returnId: RETURN_ID,
      approvalId: APPROVAL_ID,
    });
    expect(readCloseRequest({ returnId: RETURN_ID })).toBeNull();
  });
});
