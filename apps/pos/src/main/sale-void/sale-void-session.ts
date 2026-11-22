/**
 * RT-530 — the operator session as the void domain reads it.
 *
 * The void's requester is the signed-in operator, identified by the
 * provider-neutral `users.id` the session already carries (a cashier's
 * admitted `user_id`, a manager or admin's `manager_user_id`). The same
 * operator, holding an operator envelope, is the only sender of that void:
 * Backend-Core binds the void's requester to the envelope's operator.
 */
import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type { LocalVoidRefusal } from '../../shared/sale-void/types.js';
import type { VoidScope } from './sale-void-repository.js';
import type { VoidSession } from './sale-void-service.js';
import type { VoidSender } from './sale-void-sync.js';

/** The operator's `users.id` (lower-case), or null when the session has none. */
export function operatorUserIdOf(record: OperatorSessionRecord): string | null {
  const id = record.role === 'cashier' ? record.user_id : record.manager_user_id;
  return id === undefined || id.length === 0 ? null : id.toLowerCase();
}

function scopeOf(record: OperatorSessionRecord, terminalId: string): VoidScope {
  return { tenantId: record.tenant_id, branchId: record.branch_id, terminalId };
}

/** The live session as the domain's admission and request path read it. */
export function toVoidSession(
  record: OperatorSessionRecord,
  terminalId: string,
  envelope: string | null,
): VoidSession {
  return {
    sessionId: record.id,
    operatorId: record.operator_id,
    displayName: record.display_name,
    role: record.role,
    scope: scopeOf(record, terminalId),
    userId: operatorUserIdOf(record),
    hasEnvelope: envelope !== null && envelope.length > 0,
  };
}

/**
 * The signed-in operator as the void SENDER: needs a `users.id`. A manager or
 * admin also needs a non-empty envelope (an operator who signed in online);
 * without one they send nothing. A CASHIER holds no envelope and sends over
 * the device path (RT-1403, RT-530 c12029): the device bearer is read at send
 * time, and Backend-Core accepts it only while this cashier holds a live
 * admission on the terminal.
 */
export function toVoidSender(
  record: OperatorSessionRecord,
  terminalId: string,
  envelope: string | null,
): VoidSender | null {
  const operatorUserId = operatorUserIdOf(record);
  if (operatorUserId === null) return null;
  const scope = scopeOf(record, terminalId);
  if (record.role === 'cashier') return { via: 'device', scope, operatorUserId };
  if (envelope === null || envelope.length === 0) return null;
  return { scope, operatorUserId, envelope };
}

/**
 * The admission gate of every `saleVoid.*` call, for the void service and the payout alike: the
 * domain is live (RT-198), the feature flag is on, and a live, unlocked operator session exists.
 */
export function admitVoidCall<S>(gate: {
  readonly isStopped: () => boolean;
  readonly isEnabled: () => boolean;
  readonly getSession: () => S | null;
  readonly isSessionLocked: () => boolean;
}):
  | { readonly kind: 'ok'; readonly session: S }
  | { readonly kind: 'refused'; readonly reason: LocalVoidRefusal } {
  if (gate.isStopped()) return { kind: 'refused', reason: 'void_unavailable' };
  if (!gate.isEnabled()) return { kind: 'refused', reason: 'feature_disabled' };
  const session = gate.getSession();
  if (session === null) return { kind: 'refused', reason: 'no_session' };
  if (gate.isSessionLocked()) return { kind: 'refused', reason: 'session_locked' };
  return { kind: 'ok', session };
}
