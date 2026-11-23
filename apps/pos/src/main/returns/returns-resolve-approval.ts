/**
 * RT-1498 S4/S5 (Gap 1; owner decision RT-1498 c18144 item 1) — the manager approval of resolving a
 * permanently-unknown return.
 *
 * ONE action kind, `return.resolve_unknown`, and the chosen disposition (`close` or `escalate`) is
 * bound into the approval's payload, so an approval granted for one is not valid for the other:
 *
 *   • `subject_ref` = `<returnId>_<disposition>`. The approval service compares it for equality on
 *     consume, and migration 0070 repeats the comparison in a trigger on the disposition row;
 *   • `subject.version` = `<disposition>|<state>|<attempt_count>` and `amountMinor` = the quoted total,
 *     so an approval is stale once the return was attempted again, moved or changed;
 *   • four-eyes (approver != requester) and single use are the approval service's (RT-114).
 *
 * `escalate` hands the return to support (a `needs_support` disposition). `close` is the terminal
 * "not recorded" disposition; it needs a server status read that answered an affirmative
 * "not recorded" (RT-196 §3.2): no close subject exists unless `closeAvailable` says the server's
 * status read is available (the last probe was not a 404; unknown is unavailable), so no close approval
 * can be granted while the read is off. A close is allowed from `needs_support` (RT-1498 review LOW-1);
 * an escalation is not (any earlier disposition ends it).
 */
import type {
  ApprovalSubject,
  ApprovalSubjectResolver,
  ManagerApprovalService,
} from '../operator/manager-approval-service.js';
import type { ReturnsRefusalReason } from '../../shared/returns/types.js';
import { isReturnsRole } from './returns-auth.js';
import {
  isClosedState,
  type ReturnDispositionsRepository,
} from './returns-dispositions-repository.js';
import type { JournalEntry, ReturnScope, ReturnsRepository } from './returns-repository.js';
import { isUuid } from './returns-wire.js';

export const RETURN_RESOLVE_ACTION_KIND = 'return.resolve_unknown' as const;

export type ResolveDisposition = 'close' | 'escalate';

/** The approval subject ref of `disposition` on `returnId` (`_`: the bridge allows `[A-Za-z0-9_-]`). */
export function resolveSubjectRef(returnId: string, disposition: ResolveDisposition): string {
  return `${returnId}_${disposition}`;
}

const SUBJECT_REF = /^(.{36})_(close|escalate)$/;

/** The return and the disposition a subject ref names, or null for any other shape. */
export function parseResolveSubjectRef(
  ref: string,
): { returnId: string; disposition: ResolveDisposition } | null {
  const match = SUBJECT_REF.exec(ref);
  const returnId = match?.[1];
  const disposition = match?.[2];
  if (returnId === undefined || !isUuid(returnId)) return null;
  return disposition === 'close' || disposition === 'escalate' ? { returnId, disposition } : null;
}

/** What an approval of `disposition` is bound to: the disposition, the row as it stands, its amount. */
export function resolveSubjectOf(
  entry: Pick<JournalEntry, 'state' | 'attemptCount' | 'quotedTotalMinor'>,
  disposition: ResolveDisposition,
): ApprovalSubject {
  return {
    version: `${disposition}|${entry.state}|${String(entry.attemptCount)}`,
    amountMinor: entry.quotedTotalMinor,
  };
}

/**
 * A return can take a disposition only while it is unresolved and was sent at least once: a
 * never-sent `pending` return is sent first (RT-196 c12801 Gap 3), a resolved one needs none.
 */
export function isDisposable(entry: Pick<JournalEntry, 'state' | 'attemptCount'>): boolean {
  if (entry.state === 'unknown') return true;
  return entry.state === 'pending' && entry.attemptCount > 0;
}

export interface ResolveApprovalDeps {
  readonly repo: Pick<ReturnsRepository, 'read'>;
  readonly dispositions: Pick<ReturnDispositionsRepository, 'stateOf'>;
  /** The live paired terminal (null while unpaired): an approval is for this terminal's returns only. */
  readonly terminalId: () => string | null;
  /**
   * Whether a close can be offered for this return now: the server's status read is available (the
   * last probe was answered with a verdict, not a 404). Fail closed: the default is false.
   */
  readonly closeAvailable?: (entry: JournalEntry) => boolean;
}

function isOwnScope(
  entry: JournalEntry,
  session: { tenant_id: string; branch_id: string },
  terminalId: string | null,
): boolean {
  return (
    terminalId !== null &&
    entry.scope.tenantId === session.tenant_id &&
    entry.scope.branchId === session.branch_id &&
    entry.scope.terminalId === terminalId
  );
}

/**
 * The approval subject of `return.resolve_unknown`: named only for a manager or admin session of this
 * terminal, for a return of this terminal that can take that disposition now (not closed, not already
 * needs_support, unresolved and sent).
 */
export function createReturnResolveApprovalResolver(
  deps: ResolveApprovalDeps,
): ApprovalSubjectResolver {
  const closeAvailable = deps.closeAvailable ?? (() => false);
  return ({ subjectRef, session }) => {
    if (!isReturnsRole(session.role)) return null;
    const named = parseResolveSubjectRef(subjectRef);
    if (named === null) return null;
    const entry = deps.repo.read(named.returnId);
    if (entry === null || !isOwnScope(entry, session, deps.terminalId())) return null;
    if (!isDisposable(entry)) return null;
    // Escalate: any earlier disposition ends it. Close: allowed from `needs_support`
    // (needs_support -> close, spec 3.4); only an already-`closed` return is refused.
    const earlier = deps.dispositions.stateOf(entry.returnId);
    if (named.disposition === 'escalate' ? earlier !== null : isClosedState(earlier)) return null;
    if (named.disposition === 'close' && !closeAvailable(entry)) return null;
    return resolveSubjectOf(entry, named.disposition);
  };
}

/** What spending a resolve approval needs: the approval service and the live operator's `users.id`. */
export interface ResolveApprovalSpender {
  readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  readonly userId: () => string | null;
}

export type SpendResolveApproval =
  | { readonly kind: 'spent'; readonly approverUserId: string }
  | { readonly kind: 'refused'; readonly reason: ReturnsRefusalReason };

/**
 * Spend the single-use approval `approvalId` for `disposition` on `entry` and prove it: bound to this
 * return and to this disposition (`approval_invalid` for another return, the other disposition, a spent
 * or an expired one), bound to the row as it stands (`approval_stale` once it moved), granted under the
 * disposition's own reason code, to THIS operator as requester, by a manager who is not them
 * (four-eyes). Call it INSIDE the transaction that writes the disposition, so any later refusal rolls
 * the spend back. Fail closed: with no spender, or no live user id, it refuses `approval_invalid`.
 */
export function spendResolveApproval(
  spender: ResolveApprovalSpender | undefined,
  actor: { readonly operatorId: string; readonly scope: ReturnScope },
  approvalId: string,
  entry: JournalEntry,
  disposition: ResolveDisposition,
): SpendResolveApproval {
  const userId = spender?.userId()?.toLowerCase() ?? null;
  if (spender === undefined || userId === null)
    return { kind: 'refused', reason: 'approval_invalid' };
  const consumed = spender.approvals.consume({
    approvalId,
    actionKind: RETURN_RESOLVE_ACTION_KIND,
    subjectRef: resolveSubjectRef(entry.returnId, disposition),
    subject: resolveSubjectOf(entry, disposition),
    session: {
      operator_id: actor.operatorId,
      tenant_id: actor.scope.tenantId,
      branch_id: actor.scope.branchId,
    },
  });
  if (consumed.kind === 'refused') return { kind: 'refused', reason: consumed.reason };
  const evidence = spender.approvals.evidence(approvalId);
  const granted =
    evidence !== null &&
    consumed.reasonCode === `${disposition}_unknown` &&
    evidence.requesterUserId?.toLowerCase() === userId &&
    evidence.approverUserId.toLowerCase() !== userId;
  if (!granted) return { kind: 'refused', reason: 'approval_invalid' };
  return { kind: 'spent', approverUserId: evidence.approverUserId };
}
