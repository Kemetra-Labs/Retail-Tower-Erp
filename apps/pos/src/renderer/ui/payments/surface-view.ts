import { cashDraft } from '../../v5/checkout/cash-draft.js';
import type { PaymentAttemptRendererView } from '../../../shared/payments/types.js';
import type { SurfaceContext } from './payment-surface-state.js';

/**
 * RT-1226 — what the in-progress PaymentSurface shows, derived from one
 * render's state. Moved out of the surface body unchanged; pure.
 */

export interface SurfaceView {
  /** OZ-1 = Z-A: a fully discounted sale completes with no tender (D1 ZeroCheckout). */
  readonly zeroDue: boolean;
  readonly appliedLines: PaymentAttemptRendererView['tender_lines'];
  readonly hasAppliedLine: boolean;
  readonly hasAppliedCash: boolean;
  readonly remainingBalanceMinor: number;
  readonly appliedChangeDueMinor: number;
  readonly fullyTendered: boolean;
  readonly entryOwnsPrimary: boolean;
  readonly showSettle: boolean;
  readonly awaitingTender: boolean;
  readonly entryOpen: boolean;
  readonly ledgerDraft: ReturnType<typeof cashDraft> | null;
}

/**
 * Split-tender remaining-balance derivation (T154). Passed to entry components
 * so each successive line is scoped to what's still owed, not the full
 * subtotal.
 * CR-11: skip any line whose amount_applied_minor isn't a safe integer
 * (Constitution §II). The main-process projection should always emit safe
 * integers; this is the renderer-side belt to that braces.
 */
function remainingBalance(
  dueMinor: number,
  appliedLines: PaymentAttemptRendererView['tender_lines'],
): number {
  let sumAppliedMinor = 0;
  for (const line of appliedLines) {
    if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
    sumAppliedMinor += line.amount_applied_minor;
  }
  return Number.isSafeInteger(sumAppliedMinor) ? Math.max(dueMinor - sumAppliedMinor, 0) : 0;
}

/**
 * RT-237 — the change to hand back is main's `change_due_minor` on the
 * applied lines, never recomputed here. Shown after apply (PaymentLedger) and
 * on completion; unsafe values are skipped like the amount accumulator above.
 */
function appliedChangeDue(appliedLines: PaymentAttemptRendererView['tender_lines']): number {
  let appliedChangeDueMinor = 0;
  for (const line of appliedLines) {
    const change = line.change_due_minor;
    if (change === undefined || !Number.isSafeInteger(change) || change <= 0) continue;
    appliedChangeDueMinor += change;
  }
  if (!Number.isSafeInteger(appliedChangeDueMinor)) {
    appliedChangeDueMinor = 0;
  }
  return appliedChangeDueMinor;
}

type Applied = Pick<SurfaceView, 'zeroDue' | 'hasAppliedLine' | 'remainingBalanceMinor'>;
type PrimarySlot = Pick<
  SurfaceView,
  'fullyTendered' | 'entryOwnsPrimary' | 'showSettle' | 'awaitingTender'
>;

/** Who owns the money column's primary slot, and why settle is or is not offered. */
function primarySlotRules(
  ctx: SurfaceContext,
  applied: Applied,
  cancelOpen: boolean,
  cardVoidRequired: boolean,
): PrimarySlot {
  const { phase, afterApply } = ctx;
  const { hasAppliedLine, remainingBalanceMinor } = applied;
  // RT-238: exactly one control owns the primary slot at a time. While an entry
  // is open and money is still owed, that is the entry's own apply-commit; the
  // settle commit cannot proceed yet, so it waits out of the slot.
  const fullyTendered = hasAppliedLine && remainingBalanceMinor === 0;
  // While a post-apply read is pending or failed, nobody gets an apply or a settle:
  // the projection is not trustworthy until main has been read again.
  const entryOwnsPrimary = phase === 'entry' && remainingBalanceMinor > 0 && afterApply === 'idle';
  const showSettle = hasAppliedLine && !entryOwnsPrimary && afterApply === 'idle' && !cancelOpen;
  // RT-1025: no method chosen and nothing recorded yet; at 0 due «إتمام البيع» owns the slot.
  // Never beside a refusal line or M-P13, which must not suggest completing the payment,
  // and not while the chosen tender is starting (a method is already chosen).
  const awaitingTender =
    phase === 'tender_selection' &&
    !ctx.isStarting &&
    !hasAppliedLine &&
    !applied.zeroDue &&
    afterApply === 'idle' &&
    !cancelOpen &&
    ctx.bridgeRefusalCopy === null &&
    !cardVoidRequired;
  return { fullyTendered, entryOwnsPrimary, showSettle, awaitingTender };
}

/** Whether an entry is open, and the cash preview the pinned ledger shows for it. */
function entryRules(
  ctx: SurfaceContext,
  remainingBalanceMinor: number,
  cancelOpen: boolean,
): Pick<SurfaceView, 'entryOpen' | 'ledgerDraft'> {
  const { phase, afterApply } = ctx;
  const entryOpen =
    ctx.bridge !== null && phase === 'entry' && ctx.paymentAttemptId !== null && !cancelOpen;
  // RT-243 W1-C (RT-255 item 1) — the change or shortfall of the cash being
  // typed is previewed in the pinned ledger, only while money is still owed and
  // the projection is current. Once the due is covered the ledger shows main's
  // recorded change instead; a preview against a zero due would show the amount
  // received as change (RT-237).
  const cashEntryOpen = entryOpen && ctx.selectedTender === 'cash';
  const ledgerDraft =
    cashEntryOpen && afterApply === 'idle' && remainingBalanceMinor > 0
      ? cashDraft(ctx.cashDraftMinor, remainingBalanceMinor)
      : null;
  return { entryOpen, ledgerDraft };
}

export function deriveSurfaceView(
  ctx: SurfaceContext,
  cancelOpen: boolean,
  cardVoidRequired: boolean,
): SurfaceView {
  const appliedLines = (ctx.paymentSlice?.tender_lines ?? []).filter((l) => l.state === 'applied');
  const applied: Applied = {
    zeroDue: ctx.dueMinor === 0,
    hasAppliedLine: appliedLines.length > 0,
    remainingBalanceMinor: remainingBalance(ctx.dueMinor, appliedLines),
  };
  return {
    ...applied,
    appliedLines,
    hasAppliedCash: appliedLines.some((l) => l.tender_type === 'cash'),
    appliedChangeDueMinor: appliedChangeDue(appliedLines),
    ...primarySlotRules(ctx, applied, cancelOpen, cardVoidRequired),
    ...entryRules(ctx, applied.remainingBalanceMinor, cancelOpen),
  };
}
