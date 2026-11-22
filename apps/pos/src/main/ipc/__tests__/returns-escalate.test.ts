/**
 * RT-1498 S4/S5 — `returns:escalate` IPC (hand ONE unresolved return to support). The renderer is
 * untrusted: the request is exactly `{ returnId, approvalId }`, two canonical UUIDs. No scope,
 * operator, amount, disposition or reason can be smuggled in (main derives them from the row and
 * from the approval), and the channel is refused while the session is locked (default deny: it is
 * not on the lock allowlist). The close and the status read have their own channels and tests
 * (`returns-close.test.ts`); the disposition is fixed by the channel, never by the request.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../../shared/returns/channels.js';
import type { ReturnsBridgeAPI } from '../../../shared/returns/types.js';
import { readEscalateRequest, registerReturnsHandlers } from '../returns.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000a';
const APPROVAL_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000b';
const INVALID = { kind: 'refused', reason: 'invalid_input', ret: null };

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: () => raw,
  } as unknown as IpcMain;
  const service = {
    escalate: vi.fn(() => Promise.resolve({ kind: 'escalated', ret: null })),
  };
  registerReturnsHandlers(
    createSessionLockGuardedIpcMain(raw, () => locked),
    { service: service as unknown as ReturnsBridgeAPI },
  );
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return await handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, invoke };
}

describe('returns:escalate', () => {
  it('is named returns:escalate and is not on the locked-session allowlist', () => {
    expect(RETURNS_IPC_CHANNELS.ESCALATE).toBe('returns:escalate');
    expect(LOCKED_ALLOWED_CHANNELS.has(RETURNS_IPC_CHANNELS.ESCALATE)).toBe(false);
  });

  it('is refused while the session is locked, and nothing is escalated', async () => {
    const { invoke, service } = setup(true);
    await expect(
      invoke(RETURNS_IPC_CHANNELS.ESCALATE, { returnId: RETURN_ID, approvalId: APPROVAL_ID }),
    ).rejects.toBeInstanceOf(SessionLockedError);
    expect(service.escalate).not.toHaveBeenCalled();
  });

  it('forwards exactly { returnId, approvalId } to the service and returns its answer', async () => {
    const { invoke, service } = setup();
    await expect(
      invoke(RETURNS_IPC_CHANNELS.ESCALATE, { returnId: RETURN_ID, approvalId: APPROVAL_ID }),
    ).resolves.toEqual({ kind: 'escalated', ret: null });
    expect(service.escalate).toHaveBeenCalledTimes(1);
    expect(service.escalate).toHaveBeenCalledWith({
      returnId: RETURN_ID,
      approvalId: APPROVAL_ID,
    });
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
    ['an injection string', { returnId: "x' OR 1=1", approvalId: APPROVAL_ID }],
    [
      'a smuggled disposition',
      { returnId: RETURN_ID, approvalId: APPROVAL_ID, disposition: 'close' },
    ],
    ['a smuggled reason', { returnId: RETURN_ID, approvalId: APPROVAL_ID, reason: 'x' }],
    ['a smuggled operator', { returnId: RETURN_ID, approvalId: APPROVAL_ID, operatorId: 'op-x' }],
    ['a smuggled scope', { returnId: RETURN_ID, approvalId: APPROVAL_ID, tenantId: 't2' }],
    ['a smuggled amount', { returnId: RETURN_ID, approvalId: APPROVAL_ID, amountMinor: 1 }],
    ['a smuggled approver', { returnId: RETURN_ID, approvalId: APPROVAL_ID, approverUserId: 'u' }],
  ])('refuses %s as invalid_input without calling the service', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.ESCALATE, payload)).resolves.toEqual(INVALID);
    expect(service.escalate).not.toHaveBeenCalled();
  });

  it('readEscalateRequest reads the closed shape only', () => {
    expect(readEscalateRequest({ returnId: RETURN_ID, approvalId: APPROVAL_ID })).toEqual({
      returnId: RETURN_ID,
      approvalId: APPROVAL_ID,
    });
    expect(readEscalateRequest({ returnId: RETURN_ID })).toBeNull();
  });
});
