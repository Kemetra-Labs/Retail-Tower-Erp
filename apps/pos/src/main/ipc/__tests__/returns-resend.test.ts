/**
 * RT-1498 (RT-196 S1 remainder) — `returns:resend` IPC (§A4 record C-1,
 * `docs/security-review/RT-196/a4-unknown-return-s1-review.md`). The renderer
 * is untrusted: the request is exactly `{ returnId }` with a canonical UUID.
 * No key, body, operator, scope or amount can be smuggled in (main derives
 * them from the journaled row), and the channel is refused while the session
 * is locked (default deny: it is not on the lock allowlist).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { RETURNS_IPC_CHANNELS } from '../../../shared/returns/channels.js';
import type { ReturnsBridgeAPI } from '../../../shared/returns/types.js';
import { registerReturnsHandlers } from '../returns.js';
import {
  createSessionLockGuardedIpcMain,
  LOCKED_ALLOWED_CHANNELS,
  SessionLockedError,
} from '../session-lock-guard.js';

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const RETURN_ID = '0190f5a2-7b3c-4d4e-8f90-00000000000a';
const INVALID_RESEND = { kind: 'refused', reason: 'invalid_input', ret: null };

function setup(locked = false) {
  const handlers = new Map<string, Listener>();
  const raw = {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: () => raw,
  } as unknown as IpcMain;
  const service = {
    resend: vi.fn(() => Promise.resolve({ kind: 'unconfirmed' })),
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

describe('returns:resend', () => {
  it('is named returns:resend and is not on the locked-session allowlist', () => {
    expect(RETURNS_IPC_CHANNELS.RESEND).toBe('returns:resend');
    expect(LOCKED_ALLOWED_CHANNELS.has(RETURNS_IPC_CHANNELS.RESEND)).toBe(false);
  });

  it('is refused while the session is locked, and nothing is resent', async () => {
    const { invoke, service } = setup(true);
    await expect(
      invoke(RETURNS_IPC_CHANNELS.RESEND, { returnId: RETURN_ID }),
    ).rejects.toBeInstanceOf(SessionLockedError);
    expect(service.resend).not.toHaveBeenCalled();
  });

  it('forwards exactly { returnId } to the service and returns its answer', async () => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.RESEND, { returnId: RETURN_ID })).resolves.toEqual({
      kind: 'unconfirmed',
    });
    expect(service.resend).toHaveBeenCalledTimes(1);
    expect(service.resend).toHaveBeenCalledWith({ returnId: RETURN_ID });
  });

  it.each<[string, unknown]>([
    ['no payload', undefined],
    ['null', null],
    ['an array', [RETURN_ID]],
    ['a bare string id', RETURN_ID],
    ['a missing id', {}],
    ['a non-UUID id', { returnId: 'ret-1' }],
    ['a numeric id', { returnId: 42 }],
    ['an injection string', { returnId: "x' OR 1=1" }],
    ['a smuggled Idempotency-Key', { returnId: RETURN_ID, idempotencyKey: 'k' }],
    ['a smuggled body', { returnId: RETURN_ID, body: '{}' }],
    ['a smuggled operator', { returnId: RETURN_ID, operatorId: 'op-x' }],
    ['a smuggled scope', { returnId: RETURN_ID, tenantId: 't2' }],
    ['a smuggled amount', { returnId: RETURN_ID, amountMinor: 1 }],
  ])('refuses %s as invalid_input without calling the service', async (_label, payload) => {
    const { invoke, service } = setup();
    await expect(invoke(RETURNS_IPC_CHANNELS.RESEND, payload)).resolves.toEqual(INVALID_RESEND);
    expect(service.resend).not.toHaveBeenCalled();
  });
});
