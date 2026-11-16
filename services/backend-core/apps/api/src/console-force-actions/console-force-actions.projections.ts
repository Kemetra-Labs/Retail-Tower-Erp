/**
 * Wire projections of the Console force-action reads (RT-1445;
 * `console-force-actions.openapi.yaml`: `OpenShiftSummary`, `OpenShiftList`,
 * `ForceClosePreview`). Recorded counts and amounts only: never an expected-cash
 * or variance figure (Constitution §III), never an e-mail, a phone or a PIN.
 */
import { stuckBlockers, type StoreShiftRow, type StuckVerdict } from "../pos-shifts/shift-force-close.repository";
import type { TerminalTrustState } from "../pos-shifts/shift-force-close.facts";

export type ShiftBlocker = "shift_not_open" | "not_stale" | "live_operator_session" | "live_cashier_admission";

export interface ShiftVerdictBody {
  readonly eligible: boolean;
  readonly stale: boolean;
  readonly liveOperatorSession: boolean;
  readonly liveCashierAdmission: boolean;
  readonly blockers: ShiftBlocker[];
}

export interface OpenShiftSummaryBody {
  readonly shiftId: string;
  readonly storeId: string;
  readonly source: "cash_up" | "legacy";
  readonly lifecycleState: "open" | "closed" | "closed_forced";
  readonly openedAt: string;
  readonly ageMinutes: number;
  readonly cashier: { readonly userId: string; readonly displayName: string | null };
  readonly terminal: {
    readonly deviceId: string;
    readonly label: string | null;
    readonly lastSeenAt: string | null;
    readonly trustState: TerminalTrustState;
  };
  readonly verdict: ShiftVerdictBody;
}

export interface OpenShiftListBody {
  readonly storeId: string;
  readonly evaluatedAt: string;
  readonly staleThresholdMinutes: number;
  readonly items: OpenShiftSummaryBody[];
}

export interface ForceClosePreviewBody {
  readonly shift: OpenShiftSummaryBody;
  readonly recorded: {
    readonly currencyCode: string | null;
    readonly openingFloat: string | null;
    readonly cashMovementCount: number | null;
    readonly lastCashMovementReceivedAt: string | null;
    readonly saleCount: number;
    readonly refundExecutionCount: number;
  };
  readonly effects: { readonly willChange: string[]; readonly willNotChange: string[] };
  readonly reversible: false;
  readonly drawerCashUnaccounted: true;
  readonly caveats: string[];
  readonly previewFingerprint: string;
  readonly evaluatedAt: string;
}

interface TerminalFacts {
  readonly label: string | null;
  readonly lastSeenAt: Date | null;
  readonly trustState: TerminalTrustState;
}

/** One shift of the open-shifts read, before projection. */
export interface OpenShiftRow {
  readonly shift: StoreShiftRow;
  readonly cashierDisplayName: string | null;
  readonly terminal: TerminalFacts;
  readonly verdict: StuckVerdict;
}

/**
 * The verdict as the contract states it. `eligible` is true exactly when
 * `blockers` is empty. A shift that is no longer open has the one blocker
 * `shift_not_open` (the other predicates are still reported as judged).
 */
export function toVerdictBody(shift: StoreShiftRow, verdict: StuckVerdict): ShiftVerdictBody {
  const blockers: ShiftBlocker[] = shift.lifecycleState === "open" ? stuckBlockers(verdict) : ["shift_not_open"];
  return {
    eligible: blockers.length === 0,
    stale: verdict.stale,
    liveOperatorSession: verdict.liveOperatorSession,
    liveCashierAdmission: verdict.liveCashierAdmission,
    blockers,
  };
}

export function buildOpenShiftSummary(input: {
  readonly shift: StoreShiftRow;
  readonly cashierDisplayName: string | null;
  readonly terminal: TerminalFacts;
  readonly verdict: StuckVerdict;
  readonly evaluatedAt: Date;
}): OpenShiftSummaryBody {
  const { shift, terminal } = input;
  return {
    shiftId: shift.shiftId,
    storeId: shift.storeId,
    source: shift.source,
    lifecycleState: shift.lifecycleState,
    openedAt: shift.openedAt.toISOString(),
    ageMinutes: Math.max(0, Math.floor((input.evaluatedAt.getTime() - shift.openedAt.getTime()) / 60_000)),
    cashier: { userId: shift.openingUserId, displayName: input.cashierDisplayName },
    terminal: {
      deviceId: shift.openingDeviceId,
      label: terminal.label,
      lastSeenAt: terminal.lastSeenAt?.toISOString() ?? null,
      trustState: terminal.trustState,
    },
    verdict: toVerdictBody(shift, input.verdict),
  };
}

export function toOpenShiftListBody(input: {
  readonly storeId: string;
  readonly evaluatedAt: Date;
  readonly thresholdMinutes: number;
  readonly items: readonly OpenShiftRow[];
}): OpenShiftListBody {
  return {
    storeId: input.storeId,
    evaluatedAt: input.evaluatedAt.toISOString(),
    staleThresholdMinutes: input.thresholdMinutes,
    items: input.items.map((row) =>
      buildOpenShiftSummary({
        shift: row.shift,
        cashierDisplayName: row.cashierDisplayName,
        terminal: row.terminal,
        verdict: row.verdict,
        evaluatedAt: input.evaluatedAt,
      }),
    ),
  };
}
