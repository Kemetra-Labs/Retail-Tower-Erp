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
 * "not recorded" (RT-196 §3.2), which is owed (RT-1498 C0): until `closeAvailable` says otherwise
 * no close subject exists, so no close approval can be granted.
 */
import type {
  ApprovalSubject,
  ApprovalSubjectResolver,
} from '../operator/manager-approval-service.js';
import { isReturnsRole } from './returns-auth.js';
import type { ReturnDispositionsRepository } from './returns-dispositions-repository.js';
import type { JournalEntry, ReturnsRepository } from './returns-repository.js';
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
   * Whether a close can be offered for this return now. The close needs a server status read that
   * answered an affirmative "not recorded"; that read is owed (RT-1498 C0), so the default is false.
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
    if (!isDisposable(entry) || deps.dispositions.stateOf(entry.returnId) !== null) return null;
    if (named.disposition === 'close' && !closeAvailable(entry)) return null;
    return resolveSubjectOf(entry, named.disposition);
  };
}
