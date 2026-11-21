/**
 * RT-1540 (W8 P-07 part 2) — the result types of the replay of `msx-eval/2`. Types only, so the report
 * generator does not import the runner (which needs Jest and the Nest test module).
 */
import type { EvidenceReads, MsxGate, Reservation } from "./msx.types";

export interface ObservedEffects {
  readonly evidenceReads: EvidenceReads;
  readonly reservation: Reservation;
  /** The settlement outcome that released the reservation (`not_attempted`), or null. */
  readonly releaseReason: string | null;
  readonly reserves: number;
  readonly budgetChecks: number;
  readonly entitlementChecks: number;
  readonly commits: number;
  readonly releases: number;
  readonly committedUnits: number;
  readonly auditEvents: number;
  readonly providerRequests: number;
  readonly tokens: number;
}

export type GateVerdict = "pass" | "fail" | "not_applicable";

export interface CaseResult {
  readonly id: string;
  readonly section6: number;
  readonly expected: string;
  readonly actual: string;
  readonly outcomeMatches: boolean;
  /** Why the outcome, the body or the effects differ from gold (empty when the case passes). */
  readonly failures: readonly string[];
  readonly effects: ObservedEffects;
  readonly gates: Readonly<Record<MsxGate, GateVerdict>>;
  readonly gateFailures: readonly string[];
  /** The observed HTTP body (kept for diagnosis; the report never prints it). */
  readonly body: unknown;
}

export interface ReplayRun {
  readonly results: readonly CaseResult[];
}

