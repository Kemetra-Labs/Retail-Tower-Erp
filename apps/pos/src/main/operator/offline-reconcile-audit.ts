import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

import type { ActionCategory, AuditEvent } from '../../shared/audit/event-shape.js';

import type { OfflineReconcileAuditHooks, OfflineReconcileFailure } from './offline-reconcile.js';
import type { OperatorSessionRecord } from './session-manager.js';

/**
 * RT-309 (RT-113 planning record 10763 D8 and §3) — the durable, main-owned
 * audit of the offline reconcile's decisions:
 *
 *  - `operator.session.offline_reconciled`: `reconcile_offline` answered
 *    `admitted`. Written BEFORE the session becomes online-confirmed: the
 *    {@link OfflineReconciler} adopts the admission only when this write is
 *    durable (it returns true), so there is never upgraded authority without
 *    its record. The event id is stable for the whole reconcile, so a retry
 *    after a write that landed but reported a failure is ignored by the
 *    store (`INSERT OR IGNORE` on the id): exactly one record per conversion.
 *  - `operator.session.offline_reconcile_failed`: a definite answer (400 or a
 *    malformed 200, 409) could not establish authority, so new sales were
 *    blocked. Payload: the closed outcome only.
 *
 * Both categories are main-only (a renderer cannot forge them) and POS-local
 * (not in the central audit catalogue). Attribution is the session's operator,
 * tenant, branch, this terminal and the session id; no payload carries a grant
 * field, admission id or generation, user id, name, PIN or secret.
 *
 * A write that cannot be made (the store throws, the terminal is unknown) is
 * logged with the event name only, never silently dropped.
 */

export const OFFLINE_RECONCILED_CATEGORY = 'operator.session.offline_reconciled';
export const OFFLINE_RECONCILE_FAILED_CATEGORY = 'operator.session.offline_reconcile_failed';

export interface OfflineReconcileAuditDeps {
  audit: { emit(event: AuditEvent): void };
  /** The paired terminal; null when unpaired (then nothing is written). */
  resolveTerminalId: () => string | null;
  uuid?: () => string;
  now?: () => Date;
  logger?: Pick<Logger, 'warn'>;
}

function warn(deps: OfflineReconcileAuditDeps, event: string): void {
  try {
    deps.logger?.warn({ event }, 'offline reconcile audit not written');
  } catch {
    // Logging is best-effort.
  }
}

/** Write one event; true only when the store accepted it. Never throws. */
function write(
  deps: OfflineReconcileAuditDeps,
  record: OperatorSessionRecord,
  category: ActionCategory,
  event_id: string,
  payload: Record<string, unknown>,
): boolean {
  try {
    const terminal_id = deps.resolveTerminalId();
    if (terminal_id === null || terminal_id.length === 0) {
      warn(deps, `${category}.no_terminal`);
      return false;
    }
    deps.audit.emit({
      event_id,
      tenant_id: record.tenant_id,
      branch_id: record.branch_id,
      originating_terminal_id: terminal_id,
      acting_operator_id: record.operator_id,
      session_id: record.id,
      shift_id: null,
      action_category: category,
      created_at: (deps.now ?? (() => new Date()))().toISOString(),
      approving_supervisor_id: null,
      payload,
    });
    return true;
  } catch {
    warn(deps, `${category}.audit_failed`);
    return false;
  }
}

/** Build the reconciler's audit hooks. They never throw. */
export function createOfflineReconcileAudit(
  deps: OfflineReconcileAuditDeps,
): OfflineReconcileAuditHooks {
  return {
    reconciled: (record, event_id) =>
      write(deps, record, OFFLINE_RECONCILED_CATEGORY, event_id, {}),
    failed: (record, outcome: OfflineReconcileFailure) => {
      write(deps, record, OFFLINE_RECONCILE_FAILED_CATEGORY, (deps.uuid ?? randomUUID)(), {
        outcome,
      });
    },
  };
}
