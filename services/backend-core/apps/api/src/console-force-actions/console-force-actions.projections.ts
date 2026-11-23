/**
 * Wire projections of the Console force-action reads (RT-1445;
 * `console-force-actions.openapi.yaml`: `OpenShiftSummary`, `OpenShiftList`,
 * `ForceClosePreview`). Recorded counts and amounts only: never an expected-cash
 * or variance figure (Constitution §III), never an e-mail, a phone or a PIN.
 */
import { stuckBlockers, type StoreShiftRow, type StuckVerdict } from "../pos-shifts";
import type { TerminalTrustState } from "../pos-shifts/shift-force-close.facts";

type ShiftBlocker = "shift_not_open" | "not_stale" | "live_operator_session" | "live_cashier_admission";

interface ShiftVerdictBody {
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

/** One store's open shifts counted by verdict (`StoreOpenShiftCounts`, RT-1450). */
export interface StoreOpenShiftCountsBody {
  readonly storeId: string;
  readonly openShiftCount: number;
  readonly staleShiftCount: number;
  readonly eligibleShiftCount: number;
}

/** `OpenShiftsSummary` (RT-1450): the tenant's open shifts counted by verdict, per store and in total. */
export interface OpenShiftsSummaryBody {
  readonly evaluatedAt: string;
  readonly staleThresholdMinutes: number;
  readonly openShiftCount: number;
  readonly staleShiftCount: number;
  readonly eligibleShiftCount: number;
  readonly stores: StoreOpenShiftCountsBody[];
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
function toVerdictBody(shift: StoreShiftRow, verdict: StuckVerdict): ShiftVerdictBody {
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

/**
 * One store's counts, over the very rows the open-shifts read lists and with the very verdict body it
 * shows (`toVerdictBody`), so a count can never disagree with that read (RT-1450).
 */
export function countStoreOpenShifts(
  storeId: string,
  rows: readonly Pick<OpenShiftRow, "shift" | "verdict">[],
): StoreOpenShiftCountsBody {
  const verdicts = rows.map((row) => toVerdictBody(row.shift, row.verdict));
  return {
    storeId,
    openShiftCount: verdicts.length,
    staleShiftCount: verdicts.filter((v) => v.stale).length,
    eligibleShiftCount: verdicts.filter((v) => v.eligible).length,
  };
}

/** The tenant summary: each total is the sum of the same count over `stores`. */
export function toOpenShiftsSummaryBody(input: {
  readonly evaluatedAt: Date;
  readonly thresholdMinutes: number;
  readonly stores: readonly StoreOpenShiftCountsBody[];
}): OpenShiftsSummaryBody {
  const total = (field: "openShiftCount" | "staleShiftCount" | "eligibleShiftCount"): number =>
    input.stores.reduce((n, store) => n + store[field], 0);
  return {
    evaluatedAt: input.evaluatedAt.toISOString(),
    staleThresholdMinutes: input.thresholdMinutes,
    openShiftCount: total("openShiftCount"),
    staleShiftCount: total("staleShiftCount"),
    eligibleShiftCount: total("eligibleShiftCount"),
    stores: [...input.stores],
  };
}
