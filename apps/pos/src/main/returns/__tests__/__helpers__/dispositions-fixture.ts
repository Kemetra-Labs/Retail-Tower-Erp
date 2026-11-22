/**
 * RT-1498 S4 — fixtures for the return dispositions (migration 0070): a spent
 * `return.resolve_unknown` approval row (what a consumed RT-114 approval leaves), and a
 * disposition built for it, so a test can write the rows the 0070 triggers accept.
 */
import type { Database as SqlJsDatabase } from 'sql.js';

import type { NewDisposition } from '../../returns-dispositions-repository.js';
import { SCOPE } from './returns-fixture.js';

const RESOLVE_KIND = 'return.resolve_unknown';
export const APPROVAL_A = '0190f5a2-7b3c-7d4e-8f90-0000000000a1';
export const APPROVAL_B = '0190f5a2-7b3c-7d4e-8f90-0000000000a2';
const DISPOSITION_A = '0192f5a2-3b4c-7d8e-9f01-0000000000d1';
export const DISPOSITION_B = '0192f5a2-3b4c-7d8e-9f01-0000000000d2';
const REQUESTER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000aa';
const APPROVER_USER = '0190f5a2-3b4c-7d8e-9f01-0000000000bb';
export const READ_AT = '2026-10-04T10:05:00.000Z';

export interface SeedApprovalOptions {
  readonly returnId?: string;
  readonly disposition?: 'close' | 'escalate';
  readonly approvalId?: string;
  readonly amountMinor?: number;
  readonly consumed?: boolean;
}

/** A `return.resolve_unknown` approval of `returnId` for `disposition`, spent unless `consumed: false`. */
export function seedResolveApproval(db: SqlJsDatabase, options: SeedApprovalOptions = {}): string {
  const returnId = options.returnId ?? 'r1';
  const disposition = options.disposition ?? 'escalate';
  const approvalId = options.approvalId ?? APPROVAL_A;
  db.run(
    `INSERT INTO manager_approvals
       (approval_id, tenant_id, branch_id, terminal_id, action_kind, subject_ref, subject_version,
        amount_minor, reason_code, requester_operator_id, requester_user_id, approver_user_id,
        policy_version, issued_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'op-manager', ?, ?, 'rt114-2026-10-07',
       '2026-10-04T10:00:00.000Z', '2026-10-04T10:02:00.000Z', ?)`,
    [
      approvalId,
      SCOPE.tenantId,
      SCOPE.branchId,
      SCOPE.terminalId,
      RESOLVE_KIND,
      `${returnId}_${disposition}`,
      `${disposition}|unknown|1`,
      options.amountMinor ?? 3500,
      `${disposition}_unknown`,
      REQUESTER_USER,
      APPROVER_USER,
      options.consumed === false ? null : '2026-10-04T10:01:00.000Z',
    ],
  );
  return approvalId;
}

/** A manager's needs_support raise backed by `approvalId`. */
export function escalation(over: Partial<NewDisposition> = {}): NewDisposition {
  return {
    dispositionId: DISPOSITION_A,
    returnId: 'r1',
    kind: 'needs_support',
    verdictSource: 'operator',
    reason: 'operator',
    readVerdictAt: null,
    approvalId: APPROVAL_A,
    actorOperatorId: 'op-manager',
    createdAt: '2026-10-04T10:01:30.000Z',
    ...over,
  };
}

/** A terminal close (a provenance read answered "not recorded") backed by `approvalId`. */
export function closing(over: Partial<NewDisposition> = {}): NewDisposition {
  return escalation({
    kind: 'not_recorded_closed',
    verdictSource: 'provenance_read',
    reason: 'not_recorded',
    readVerdictAt: READ_AT,
    ...over,
  });
}

/** The automatic needs_support a mismatching 2xx writes (no approval, no actor). */
export function automaticMismatch(over: Partial<NewDisposition> = {}): NewDisposition {
  return escalation({
    verdictSource: 'send_response',
    reason: 'mismatch',
    approvalId: null,
    actorOperatorId: null,
    ...over,
  });
}
