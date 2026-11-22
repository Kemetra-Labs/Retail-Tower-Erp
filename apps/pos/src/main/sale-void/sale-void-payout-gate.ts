/**
 * RT-1403 S2 — the void payout gate (RT-530 c12022, c12028; owner decisions RT-1403 c18143; the
 * claim: orchestrator decisions H1/H2/M1/L3, c18153).
 *
 * No cash leaves the drawer on a void REQUEST. The cash of a void is paid out only when
 *
 *   • Backend-Core CONFIRMED the void (`pending`, `unknown` and `refused` give nothing);
 *   • a shift is open on this terminal;
 *   • it is the void's business day; and
 *   • that shift was already open when the void was requested (the same open shift);
 *
 * and the cash of a sale has no record yet (it leaves once). The first step CLAIMS the payout (a
 * durable row and its audit) before the drawer is kicked; once a claim exists a fresh payout is
 * never offered, only a drawer retry or a manager's manual completion (RT-15's rule). The pure rules
 * live here; the DB triggers of migration 0069 are their backstop. Anything unreadable (a failed
 * shift read, an unparseable instant) is a refusal, never a pass.
 */
import type { ApprovalSubject } from '../operator/manager-approval-service.js';
import type {
  LocalVoidRefusal,
  SaleVoidClaimAction,
  SaleVoidMismatchReason,
  SaleVoidPayoutAction,
  SaleVoidPayoutBlock,
} from '../../shared/sale-void/types.js';
import type { DrawerSlot } from '../drawer/drawer-slot.js';
import { kickStateOf } from '../returns/returns-drawer.js';
import type {
  PayoutClaim,
  PayoutRecord,
  SaleVoidPayoutRepository,
} from './sale-void-payout-repository.js';
import type { SaleVoidAudit } from './sale-void-audit.js';
import type { SaleVoidRepository, VoidEntry, VoidScope } from './sale-void-repository.js';
import { admitVoidCall } from './sale-void-session.js';
import type { ManagerApprovalService } from '../operator/manager-approval-service.js';

/** The `action_kind` of the approval a cash exception spends. */
export const SALE_VOID_CASH_EXCEPTION_ACTION_KIND = 'sale.void_cash_exception' as const;

/** What the drawer kick answered: opened, no drawer on this terminal (RT-531), or failed. */
export type DrawerResult = 'opened' | 'no_drawer' | 'failed';

/** The terminal's open shift, as the gate reads it. */
export interface OpenShiftFact {
  readonly shiftId: string;
  readonly openedAt: string;
}

/** The live operator session, as the payout needs it (a `VoidSession` satisfies it). */
export interface PayoutSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly displayName: string;
  readonly role: 'cashier' | 'manager' | 'admin';
  /** The operator's provider-neutral `users.id`, lower-case; null when unknown. */
  readonly userId: string | null;
  readonly scope: VoidScope;
}

export interface SaleVoidPayoutDeps {
  readonly isEnabled: () => boolean;
  readonly getSession: () => PayoutSession | null;
  readonly isSessionLocked: () => boolean;
  readonly isStopped: () => boolean;
  readonly voids: Pick<SaleVoidRepository, 'read'>;
  readonly payouts: SaleVoidPayoutRepository;
  /** The terminal's open shift, or null; may throw (a failed read counts as no shift). */
  readonly openShift: (scope: VoidScope) => OpenShiftFact | null;
  readonly approvals: Pick<ManagerApprovalService, 'consume' | 'evidence'>;
  /** Kick the cash drawer (the RT-15 / RT-531 port); never rejects. */
  readonly kickDrawer: () => Promise<DrawerResult>;
  readonly audit: Pick<
    SaleVoidAudit,
    | 'paidOut'
    | 'cashExceptionRecorded'
    | 'cashMismatchFlagged'
    | 'payoutStarted'
    | 'payoutRetried'
    | 'payoutDrawer'
    | 'payoutNotMade'
  >;
  /** The store business day (`YYYY-MM-DD`) of an ISO instant (RT-552). */
  readonly localDayOf: (iso: string) => string;
  readonly now: () => string;
  readonly newPayoutId: () => string;
  /**
   * The terminal's one drawer, shared with the returns payout (M1). Absent: a slot of its own.
   */
  readonly drawerSlot?: DrawerSlot;
}

/** A refusal thrown inside a commit transaction, so nothing is written. */
export class GateRefused extends Error {
  constructor(readonly reason: LocalVoidRefusal) {
    super(reason);
  }
}

/** True when the shift was already open when the void was requested (unreadable: false). */
function sameShift(entry: VoidEntry, shift: OpenShiftFact): boolean {
  return Date.parse(shift.openedAt) <= Date.parse(entry.requestedAt);
}

/**
 * Why an otherwise payable confirmed void cannot be paid out at `today`, or null. The day comes
 * first: a void whose day has passed is never payable, whatever shift is open. `claimShiftId` (a
 * payout already claimed) must still be the open shift.
 */
function payoutBlockOf(input: {
  entry: VoidEntry;
  shift: OpenShiftFact | null;
  today: string;
  claimShiftId?: string;
}): SaleVoidPayoutBlock | null {
  const { entry, shift, today } = input;
  if (today !== entry.businessDate) return 'payout_wrong_day';
  if (shift === null) return 'payout_no_open_shift';
  if (input.claimShiftId !== undefined && shift.shiftId !== input.claimShiftId) {
    return 'payout_other_shift';
  }
  return sameShift(entry, shift) ? null : 'payout_other_shift';
}

/** Why the FRESH payout is refused for `entry`, or null when cash may leave. */
export function payOutRefusal(input: {
  entry: VoidEntry;
  existing: PayoutRecord | null;
  block: SaleVoidPayoutBlock | null;
}): LocalVoidRefusal | null {
  const { entry } = input;
  if (input.existing !== null) return 'payout_already_recorded';
  if (entry.state === 'refused') return 'payout_void_refused';
  if (entry.state !== 'confirmed') return 'payout_void_not_confirmed';
  if (entry.cashMinor === 0) return 'payout_no_cash';
  return input.block;
}

/**
 * Why `action` is refused for a payout that is (or is not) claimed, as RT-15's rule: a fresh payout
 * is never offered once a claim exists; a drawer retry only after a kick that provably never left
 * (or none); a manual completion once no kick is in flight. Null when the action is allowed (the
 * window gate is separate).
 */
export function claimActionRefusal(input: {
  claim: PayoutClaim | null;
  action: SaleVoidPayoutAction;
  now: string;
}): LocalVoidRefusal | null {
  const { claim, action } = input;
  if (claim === null) return action === 'start' ? null : 'payout_not_started';
  if (action === 'start') return 'payout_started';
  const kick = kickStateOf({ kickOutcome: claim.kickOutcome, kickedAt: claim.kickedAt }, input.now);
  if (action === 'retry_drawer') {
    return kick === 'none' || kick === 'failed_before_send' ? null : 'payout_drawer_retry_unsafe';
  }
  return kick === 'in_flight' ? 'payout_drawer_in_progress' : null;
}

/** The steps a manager may still take on a claimed payout. */
export function claimActionsOf(claim: PayoutClaim, now: string): readonly SaleVoidClaimAction[] {
  const allowed = (action: SaleVoidClaimAction): boolean =>
    claimActionRefusal({ claim, action, now }) === null;
  return (['retry_drawer', 'manual'] as const).filter(allowed);
}

/**
 * The mismatch flag of an exception: cash left although the void is refused, unanswered, or
 * confirmed but outside its payout window. Null when cash and accounting status agree.
 */
export function mismatchOf(
  entry: VoidEntry,
  block: SaleVoidPayoutBlock | null,
): SaleVoidMismatchReason | null {
  if (entry.state === 'refused') return 'void_refused';
  if (entry.state !== 'confirmed') return 'void_unconfirmed';
  return block === null ? null : 'payout_window_closed';
}

/** The approval subject of a cash exception: this void and its cash. */
export function cashExceptionSubjectOf(entry: VoidEntry): ApprovalSubject {
  return {
    version: `sale-void-cash-exception:${entry.voidId}`,
    amountMinor: entry.cashMinor,
  };
}

type Admitted = { readonly kind: 'ok'; readonly session: PayoutSession };
type Refused = { readonly kind: 'refused'; readonly reason: LocalVoidRefusal };
export const refuse = (reason: LocalVoidRefusal): Refused => ({ kind: 'refused', reason });

/** The reads both the payout and the exception share. */
export interface PayoutContext {
  /** The admission gate: domain live, flag on, a live unlocked session. */
  admit(): Admitted | Refused;
  /** The void of this session's terminal, or null. */
  voidOf(session: PayoutSession, voidId: string): VoidEntry | null;
  /** The record that already holds this void's cash, or this SALE's cash (any of its voids). */
  existingFor(entry: VoidEntry): PayoutRecord | null;
  /** The open shift; a failed read is no shift (fail closed). */
  shiftNow(scope: VoidScope): OpenShiftFact | null;
  /** Why the void cannot be paid at `now` (one snapshot of the clock), or null. */
  blockAt(entry: VoidEntry, now: string, claim?: PayoutClaim | null): SaleVoidPayoutBlock | null;
}

export function createPayoutContext(deps: SaleVoidPayoutDeps): PayoutContext {
  function shiftNow(scope: VoidScope): OpenShiftFact | null {
    try {
      return deps.openShift(scope);
    } catch {
      return null;
    }
  }
  return {
    admit: () => admitVoidCall(deps),
    voidOf(session, voidId) {
      const entry = deps.voids.read(voidId);
      if (entry === null) return null;
      const own =
        entry.scope.tenantId === session.scope.tenantId &&
        entry.scope.branchId === session.scope.branchId &&
        entry.scope.terminalId === session.scope.terminalId;
      return own ? entry : null;
    },
    existingFor: (entry) =>
      deps.payouts.readByVoid(entry.voidId) ?? deps.payouts.readBySale(entry.saleId),
    shiftNow,
    blockAt: (entry, now, claim) =>
      payoutBlockOf({
        entry,
        shift: shiftNow(entry.scope),
        today: deps.localDayOf(now),
        ...(claim === null || claim === undefined ? {} : { claimShiftId: claim.shiftId }),
      }),
  };
}
