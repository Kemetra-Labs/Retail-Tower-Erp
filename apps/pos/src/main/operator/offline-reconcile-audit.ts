import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';

import type { AuditEvent } from '../../shared/audit/event-shape.js';

import type { OperatorSessionRecord } from './session-manager.js';

/**
 * RT-309 (RT-113 planning record 10763 D8 and §3) — the audit record of a
 * reconnect reconciliation that converted an offline-admitted cashier session
 * to online-confirmed (`reconcile_offline` answered `admitted`).
 *
 * Main-owned: only the {@link OfflineReconciler} calls this, after the session
 * adopted the admission, so it is written exactly once per conversion. The
 * category is in the main-only set, so a renderer cannot forge it.
 *
 * The event's attribution records who (the session's operator), where (tenant,
 * branch, this terminal) and which session. The payload is empty: no grant
 * field, admission id or generation, user id, name, PIN or secret. The
 * category stays POS-local (it is not in the central audit catalogue).
 *
 * An audit failure, or an unknown terminal id, never changes the outcome: the
 * session stays adopted (the RT-444 precedent).
 */

export const OFFLINE_RECONCILED_CATEGORY = 'operator.session.offline_reconciled';

export interface OfflineReconciledAuditDeps {
  audit: { emit(event: AuditEvent): void };
  /** The paired terminal; null when unpaired (then nothing is written). */
  resolveTerminalId: () => string | null;
  uuid?: () => string;
  now?: () => Date;
  logger?: Pick<Logger, 'warn'>;
}

function warn(deps: OfflineReconciledAuditDeps, event: string): void {
  try {
    deps.logger?.warn({ event }, 'offline reconcile audit not written');
  } catch {
    // Logging is best-effort.
  }
}

/** Build the reconciler's `onReconciled` hook. The hook never throws. */
export function createOfflineReconciledAudit(
  deps: OfflineReconciledAuditDeps,
): (record: OperatorSessionRecord) => void {
  return (record) => {
    try {
      const terminal_id = deps.resolveTerminalId();
      if (terminal_id === null || terminal_id.length === 0) {
        warn(deps, 'operator.session.offline_reconciled.no_terminal');
        return;
      }
      deps.audit.emit({
        event_id: (deps.uuid ?? randomUUID)(),
        tenant_id: record.tenant_id,
        branch_id: record.branch_id,
        originating_terminal_id: terminal_id,
        acting_operator_id: record.operator_id,
        session_id: record.id,
        shift_id: null,
        action_category: OFFLINE_RECONCILED_CATEGORY,
        created_at: (deps.now ?? (() => new Date()))().toISOString(),
        approving_supervisor_id: null,
        payload: {},
      });
    } catch {
      warn(deps, 'operator.session.offline_reconciled.audit_failed');
    }
  };
}
