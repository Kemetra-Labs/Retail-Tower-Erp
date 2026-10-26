import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { OfflineSigninRefusalCategory } from '../../shared/audit/payload-schemas.js';

import type { CashierAdmissionResult } from './cashier-admission-client.js';
import type { OfflineGrantEvaluation } from './offline-grant-store.js';
import type { OfflineAdmissionFields } from './session-manager.js';

/**
 * RT-308 (RT-113 P3) — admit a cashier OFFLINE, only from a valid sealed grant
 * (Jira RT-113 planning record 10763 D3–D7 and D10; owner decisions 10874,
 * 10878 (OD12), 10907).
 *
 * The cashier sign-in calls this only after:
 *  - the PIN matched locally (the PIN is still required; lockout unchanged);
 *  - the online admission found Backend-Core unreachable
 *    ({@link backendUnreachable}). Any answer FROM Backend-Core (403, device
 *    401, `active_elsewhere`, 409, 429, 400, no device token) never falls back
 *    to offline: Backend-Core is never bypassed.
 *
 * {@link consumeOfflineAdmission} spends one of the grant's 8 offline uses and
 * persists it (a compare-and-swap re-seal in the grant store) BEFORE the caller
 * creates the session. Every failure refuses (D10): a missing, expired,
 * invalidated, tampered or unsealable grant, a scope or identity mismatch, an
 * exhausted budget, a clock set back more than 5 minutes, a failed counter
 * write or any storage error. Nothing here ever admits without proof.
 *
 * The admitted session is the same cashier on the same paired terminal: the
 * same `operator_id` (the provider subject; RT-116 seam 1) and `user_id` as
 * the grant's online admission. It is bounded by the grant's expiry
 * (`issued_at_local + min(ttl, 72 h)`; `offline-authority.ts`) and holds no
 * server admission, so nothing heartbeats or `end`s one for it (P4 reconciles).
 *
 * Accepted residual risk (10898 / 10907, RT-226): a local DB writer can write
 * an older sealed grant back and so reset its use budget or undo a known
 * invalidation. This module does not close that; P4 reconciliation is the
 * backstop and an out-of-DB anchor is tracked in RT-226.
 *
 * Privacy: audits and logs carry a closed category only. No grant field, PIN,
 * identifier or secret reaches a log line.
 */

export interface OfflineAdmissionDeps {
  /** `OfflineGrantWiring.consumeOfflineUse`: tombstones first, never throws. */
  grants: { consumeOfflineUse(user_id: string, nowWall: Date): OfflineGrantEvaluation };
  /** Local audit (main-only categories). Optional in tests. */
  audit?: { emit(event: AuditEvent): void };
  uuid?: () => string;
  /** The wall clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** The monotonic clock (ms). Defaults to `performance.now()`. */
  monotonicNow?: () => number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Who is being admitted, and where (the current pairing). */
export interface OfflineAdmissionSubject {
  user_id: string;
  /** The session `operator_id`: the provider subject the PIN row is keyed on. */
  operator_id: string;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
}

export type OfflineAdmission =
  | {
      kind: 'admitted';
      /** The server-resolved name from the grant's online admission. */
      display_name: string;
      fields: OfflineAdmissionFields;
    }
  | { kind: 'refused'; category: OfflineSigninRefusalCategory };

/**
 * Outcomes of the online admission that mean Backend-Core could not be
 * reached: a transport failure or a 5xx. Nothing else.
 */
const UNREACHABLE: ReadonlySet<CashierAdmissionResult['kind']> = new Set([
  'no_connection',
  'unavailable',
]);

export function backendUnreachable(kind: CashierAdmissionResult['kind']): boolean {
  return UNREACHABLE.has(kind);
}

const ADMITTED_CATEGORY = 'operator.signin.offline_admitted';
const REFUSED_CATEGORY = 'operator.signin.offline_refused';

function log(
  deps: OfflineAdmissionDeps,
  level: 'info' | 'warn',
  fields: Record<string, string>,
): void {
  try {
    deps.logger?.[level](fields, fields['event']?.replaceAll(/\./g, ' '));
  } catch {
    // Logging is best-effort.
  }
}

function emit(
  deps: OfflineAdmissionDeps,
  who: OfflineAdmissionSubject,
  action_category: typeof ADMITTED_CATEGORY | typeof REFUSED_CATEGORY,
  rest: { session_id: string | null; payload: Record<string, unknown> },
): void {
  if (deps.audit === undefined) return;
  try {
    deps.audit.emit({
      event_id: (deps.uuid ?? randomUUID)(),
      tenant_id: who.tenant_id,
      branch_id: who.branch_id,
      originating_terminal_id: who.terminal_id,
      acting_operator_id: who.operator_id,
      session_id: rest.session_id,
      shift_id: null,
      action_category,
      created_at: (deps.now ?? (() => new Date()))().toISOString(),
      approving_supervisor_id: null,
      payload: rest.payload,
    });
  } catch {
    // The audit write must not change the outcome (the RT-444 precedent).
    log(deps, 'warn', { event: 'operator.signin.offline_audit_failed' });
  }
}

function refuse(
  deps: OfflineAdmissionDeps,
  who: OfflineAdmissionSubject,
  category: OfflineSigninRefusalCategory,
): OfflineAdmission {
  log(deps, 'info', { event: 'operator.signin.offline_refused', category });
  emit(deps, who, REFUSED_CATEGORY, { session_id: null, payload: { category } });
  return { kind: 'refused', category };
}

function consumeUse(
  deps: OfflineAdmissionDeps,
  user_id: string,
  now: Date,
): OfflineGrantEvaluation {
  try {
    return deps.grants.consumeOfflineUse(user_id, now);
  } catch {
    return { admissible: false, category: 'storage' };
  }
}

/**
 * Spend and persist one offline use of the cashier's grant, then return the
 * session bound — or the refusal. The use is spent even when the caller then
 * refuses for another reason (fail closed: a use is never handed back).
 */
export function consumeOfflineAdmission(
  deps: OfflineAdmissionDeps,
  who: OfflineAdmissionSubject,
): OfflineAdmission {
  const nowWall = (deps.now ?? (() => new Date()))();
  const nowMono = (deps.monotonicNow ?? (() => performance.now()))();
  const evaluation = consumeUse(deps, who.user_id, nowWall);
  if (!evaluation.admissible) return refuse(deps, who, evaluation.category);
  const grant = evaluation.grant;
  // Same cashier: the grant was written for this user AND this provider subject.
  if (grant.user_id !== who.user_id || grant.operator_id !== who.operator_id) {
    return refuse(deps, who, 'scope_mismatch');
  }
  const left_ms = grant.expires_at_local_ms - nowWall.getTime();
  if (!Number.isFinite(left_ms) || !Number.isFinite(nowMono) || left_ms <= 0) {
    return refuse(deps, who, 'grant_expired');
  }
  return {
    kind: 'admitted',
    display_name: grant.display_name,
    fields: {
      user_id: grant.user_id,
      valid_until_ms: grant.expires_at_local_ms,
      deadline_mono_ms: nowMono + left_ms,
    },
  };
}

/** Audit the admission once the session exists. Never throws. */
export function auditOfflineAdmitted(
  deps: OfflineAdmissionDeps,
  who: OfflineAdmissionSubject,
  session_id: string,
): void {
  log(deps, 'info', { event: 'operator.signin.offline_admitted' });
  emit(deps, who, ADMITTED_CATEGORY, { session_id, payload: {} });
}
