/**
 * RT-1403 S2 - the steps of the void payout (see `sale-void-payout.ts` for the order and the rules):
 * the gate on fresh reads, the claim with its kick mark and audit, the retry mark, the kick's outcome
 * and the commit of the record. Each is one synchronous transaction behind the same gate.
 */
import type { LocalVoidRefusal } from '../../shared/sale-void/types.js';
import type {
  SaleVoidPayOutRequest,
  SaleVoidPayOutResponse,
} from '../../shared/sale-void/types.js';
import type { PayoutActor } from './sale-void-payout-audit.js';
import {
  GateRefused,
  claimActionRefusal,
  payOutRefusal,
  refuse as refuseWith,
  type DrawerResult,
  type PayoutContext,
  type PayoutSession,
  type SaleVoidPayoutDeps,
} from './sale-void-payout-gate.js';
import type { KickResult, NewPayout } from './sale-void-payout-repository.js';
import type { VoidEntry } from './sale-void-repository.js';

export const refuse = (
  reason: LocalVoidRefusal,
  drawerMayBeOpen = false,
): SaleVoidPayOutResponse =>
  drawerMayBeOpen ? { ...refuseWith(reason), drawer_may_be_open: true } : refuseWith(reason);

/** What a kick's answer proves about the drawer (as RT-15's `kickResultOf`). */
const KICK_RESULT: Readonly<Record<DrawerResult, KickResult>> = {
  opened: 'opened',
  no_drawer: 'failed_before_send',
  failed: 'unknown',
};

/** The method of the record a kick completes; a manual completion needs no kick. */
type Method = 'drawer' | 'no_drawer' | 'manual';

interface PayoutSteps {
  refusalOf: (
    entry: VoidEntry,
    action: SaleVoidPayOutRequest['action'],
    now: string,
  ) => LocalVoidRefusal | null;
  claimAndMark: (session: PayoutSession, voidId: string) => void;
  markRetry: (session: PayoutSession, voidId: string) => LocalVoidRefusal | null;
  persistKick: (session: PayoutSession, voidId: string, kick: DrawerResult) => void;
  commit: (
    session: PayoutSession,
    voidId: string,
    method: Method,
    drawerMayBeOpen: boolean,
  ) => SaleVoidPayOutResponse;
}

export function createPayoutSteps(deps: SaleVoidPayoutDeps, ctx: PayoutContext): PayoutSteps {
  const actorOf = (s: PayoutSession): PayoutActor => ({
    operatorId: s.operatorId,
    sessionId: s.sessionId,
  });

  /**
   * Why the action is refused on fresh reads at `now`, or null: the claim rule first (RT-15's), then
   * the window gate. A claimed payout is gated on its own shift.
   */
  function refusalOf(entry: VoidEntry, action: SaleVoidPayOutRequest['action'], now: string) {
    const claim = deps.payouts.readClaim(entry.voidId);
    const existing = ctx.existingFor(entry);
    if (existing !== null) return 'payout_already_recorded';
    const byClaim = claimActionRefusal({ claim, action, now });
    if (byClaim !== null) return byClaim;
    return payOutRefusal({ entry, existing, block: ctx.blockAt(entry, now, claim) });
  }

  /** The gate on fresh reads; throws a `GateRefused` when the action may not go on. */
  function gate(
    session: PayoutSession,
    voidId: string,
    action: SaleVoidPayOutRequest['action'],
    now: string,
  ): VoidEntry {
    const entry = ctx.voidOf(session, voidId);
    if (entry === null) throw new GateRefused('invalid_input');
    const refusal = refusalOf(entry, action, now);
    if (refusal !== null) throw new GateRefused(refusal);
    return entry;
  }

  /** Step 3: the claim, its kick mark and its audit, ONE transaction, before the drawer is kicked. */
  function claimAndMark(session: PayoutSession, voidId: string): void {
    deps.payouts.transaction(() => {
      const now = deps.now();
      const entry = gate(session, voidId, 'start', now);
      const shift = ctx.shiftNow(entry.scope);
      if (shift === null) throw new GateRefused('payout_no_open_shift');
      const started = deps.payouts.startClaim({
        voidId: entry.voidId,
        saleId: entry.saleId,
        scope: entry.scope,
        shiftId: shift.shiftId,
        businessDate: entry.businessDate,
        claimedBy: {
          operatorId: session.operatorId,
          displayName: session.displayName,
          sessionId: session.sessionId,
        },
        claimedAt: now,
      });
      if (!started) throw new GateRefused('payout_started');
      markSending(entry.voidId, now);
      const claim = deps.payouts.readClaim(entry.voidId);
      if (claim !== null) {
        deps.audit.payoutStarted(actorOf(session), claim, {
          amountMinor: entry.cashMinor,
          currencyCode: entry.currencyCode,
        });
      }
    });
  }

  function markSending(voidId: string, now: string): void {
    if (!deps.payouts.markSending({ voidId, now })) {
      throw new Error('sale-void-payout: claim not kickable');
    }
  }

  /** A retry: the kick about to be sent, only after one that provably never left. */
  function markRetry(session: PayoutSession, voidId: string): LocalVoidRefusal | null {
    try {
      gate(session, voidId, 'retry_drawer', deps.now());
    } catch (err) {
      if (err instanceof GateRefused) return err.reason;
      throw err;
    }
    return deps.payouts.markSending({ voidId, now: deps.now() })
      ? null
      : 'payout_drawer_retry_unsafe';
  }

  /** The kick's outcome and its audit, in one transaction (a drawer that opened is remembered). */
  function persistKick(session: PayoutSession, voidId: string, kick: DrawerResult): void {
    deps.payouts.transaction(() => {
      if (!deps.payouts.recordKick({ voidId, outcome: KICK_RESULT[kick] })) return;
      const claim = deps.payouts.readClaim(voidId);
      if (claim !== null) deps.audit.payoutDrawer(actorOf(session), claim, KICK_RESULT[kick]);
    });
  }

  /** The record of the gated payout, built INSIDE the commit transaction from fresh reads. */
  function build(session: PayoutSession, voidId: string, method: Method): NewPayout {
    // ONE clock read: the payment day, the window check and `paid_at` agree (M2).
    const paidAt = deps.now();
    // The claim exists and its kick is settled: the same rule as a manual completion.
    const entry = gate(session, voidId, 'manual', paidAt);
    const shift = ctx.shiftNow(entry.scope);
    if (shift === null) throw new GateRefused('payout_no_open_shift');
    return {
      payoutId: deps.newPayoutId(),
      voidId: entry.voidId,
      saleId: entry.saleId,
      scope: entry.scope,
      shiftId: shift.shiftId,
      businessDate: deps.localDayOf(paidAt),
      kind: 'payout',
      method,
      amountMinor: entry.cashMinor,
      currencyCode: entry.currencyCode,
      voidState: 'confirmed',
      mismatchReason: null,
      paidAt,
      paidBy: {
        operatorId: session.operatorId,
        displayName: session.displayName,
        sessionId: session.sessionId,
      },
      exception: null,
    };
  }

  /** Step 5: the same admitted session must still hold, then the record, atomically with its audit. */
  function commit(
    session: PayoutSession,
    voidId: string,
    method: Method,
    drawerMayBeOpen: boolean,
  ): SaleVoidPayOutResponse {
    const again = ctx.admit();
    if (again.kind !== 'ok') return refuse(again.reason, drawerMayBeOpen);
    if (again.session.sessionId !== session.sessionId) return refuse('no_session', drawerMayBeOpen);
    try {
      deps.payouts.insertFrom(
        () => build(session, voidId, method),
        (inserted) => {
          deps.audit.paidOut(inserted);
        },
      );
    } catch (err) {
      if (err instanceof GateRefused) return refuse(err.reason, drawerMayBeOpen);
      throw err;
    }
    return { kind: 'paid_out' };
  }

  return { refusalOf, claimAndMark, markRetry, persistKick, commit };
}
