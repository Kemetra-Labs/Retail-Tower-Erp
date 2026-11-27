import type { IpcMain } from 'electron';

import { SESSION_LOCK_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type {
  LockStateView,
  ResolveConflictRequest,
  ResolveConflictResponse,
  UnlockSessionRequest,
  UnlockSessionResponse,
} from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

/**
 * RT-117 (RT-116 §2.4, §7.2) — `operator:unlock-session` and
 * `operator:get-lock-state`. Both are on the locked-session allowlist
 * (`session-lock-guard.ts`). Boundary validation copies only the known
 * fields and refuses generically; a thrown error never crosses the bridge.
 */

export interface SessionLockHandlerDeps {
  unlockHandler: { unlock(req: UnlockSessionRequest): Promise<UnlockSessionResponse> };
  getLockState: () => LockStateView;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

type RequestFields = Record<string, unknown>;

function hasCredential(
  v: RequestFields,
): v is RequestFields & { identifier: string; password: string } {
  return nonEmpty(v['identifier']) && nonEmpty(v['password']);
}

function asPinRequest(v: RequestFields): UnlockSessionRequest | null {
  return nonEmpty(v['pin']) ? { method: 'pin', pin: v['pin'] } : null;
}

function asOnlineCredentialRequest(v: RequestFields): UnlockSessionRequest | null {
  return hasCredential(v)
    ? { method: 'online_credential', identifier: v['identifier'], password: v['password'] }
    : null;
}

/** One boundary parser per unlock method; an unknown method has none. */
const UNLOCK_REQUEST_PARSERS = new Map<unknown, (v: RequestFields) => UnlockSessionRequest | null>([
  ['pin', asPinRequest],
  ['online_credential', asOnlineCredentialRequest],
]);

function asUnlockRequest(value: unknown): UnlockSessionRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as RequestFields;
  const parse = UNLOCK_REQUEST_PARSERS.get(v['method']);
  return parse === undefined ? null : parse(v);
}

export function registerSessionLockHandlers(ipcMain: IpcMain, deps: SessionLockHandlerDeps): void {
  ipcMain.handle(
    SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
    async (_event, request: unknown): Promise<UnlockSessionResponse> => {
      const req = asUnlockRequest(request);
      if (req === null) return REFUSE_INVALID;
      try {
        return await deps.unlockHandler.unlock(req);
      } catch {
        return REFUSE_INVALID;
      }
    },
  );

  ipcMain.handle(
    SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
    (): LockStateView => deps.getLockState(),
  );
}

/**
 * RT-309 D9 (10763 D9) — `operator:resolve-conflict`, on the locked-session
 * allowlist. Boundary validation copies only `action` (one of the two closed
 * values) and `pin` (a non-empty string); anything else is refused generically
 * before the resolver runs. The PIN is never logged, and a thrown error never
 * crosses the bridge.
 */
interface ResolveConflictHandlerDeps {
  resolver: { resolve(req: ResolveConflictRequest): Promise<ResolveConflictResponse> };
}

const CONFLICT_ACTIONS: ReadonlySet<unknown> = new Set(['take_over_here', 'end_here']);

function asResolveConflictRequest(value: unknown): ResolveConflictRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as RequestFields;
  const action = v['action'];
  if (!CONFLICT_ACTIONS.has(action) || !nonEmpty(v['pin'])) return null;
  return { action: action as ResolveConflictRequest['action'], pin: v['pin'] };
}

export function registerResolveConflictHandler(
  ipcMain: IpcMain,
  deps: ResolveConflictHandlerDeps,
): void {
  ipcMain.handle(
    SESSION_LOCK_IPC_CHANNELS.RESOLVE_CONFLICT,
    async (_event, request: unknown): Promise<ResolveConflictResponse> => {
      const req = asResolveConflictRequest(request);
      if (req === null) return REFUSE_INVALID;
      try {
        return await deps.resolver.resolve(req);
      } catch {
        return REFUSE_INVALID;
      }
    },
  );
}
