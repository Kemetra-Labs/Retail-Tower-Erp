/**
 * RT-1358 — the provisioning state machine as pure functions (no DB, no clock,
 * no DI). The recorded `status` is a display and audit trail (contract): what
 * exists on the site is the provisioner's truth. This module decides, from the
 * stored row and one acknowledgement, which patch the repository may write.
 *
 * Writers of `erp_provisioning_request` (all through the repository):
 *   - the provisioner feed, deciding with this module;
 *   - the unlock trigger (INSERT) and the manual mark-provisioned cancel, in the
 *     platform-admin context.
 * The worker sweep (`packages/db`) is the other writer; it checks the same
 * transition table, which lives in `packages/db` (RT-1389) and is re-exported here.
 */
import {
  ERP_PROVISIONING_ALLOWED_TRANSITIONS,
  ERP_PROVISIONING_STATUSES,
  erpProvisioningTransitionAllowed,
  type ErpProvisioningStatus,
} from "@data-pulse-2/db";

export const REQUEST_STATUSES = ERP_PROVISIONING_STATUSES;
export type RequestStatus = ErpProvisioningStatus;

export const TERMINAL_STATUSES: readonly RequestStatus[] = ["succeeded", "failed_permanent", "compensated", "cancelled"];

export const STEP_NAMES = ["claimed", "site_created", "erp_configured", "connector_installed", "credential_bound", "verified"] as const;
export type StepName = (typeof STEP_NAMES)[number];

export const STEP_OUTCOMES = ["done", "failed_transient", "permanently_rejected", "conflict", "capacity", "compatibility", "dependency"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];
export type ErrorClass = Exclude<StepOutcome, "done">;

/** The status a `done` step moves the request to (`verified` -> `verifying`). */
const STEP_STATUS: Readonly<Record<StepName, RequestStatus>> = {
  claimed: "claimed",
  site_created: "site_created",
  erp_configured: "erp_configured",
  connector_installed: "connector_installed",
  credential_bound: "credential_bound",
  verified: "verifying",
};

/** Progress rank: a `done` step never moves the status backwards. */
const PROGRESS_RANK: Readonly<Partial<Record<RequestStatus, number>>> = {
  requested: 0,
  failed_retryable: 0,
  claimed: 1,
  site_created: 2,
  erp_configured: 3,
  connector_installed: 4,
  credential_bound: 5,
  verifying: 6,
};

function rank(status: RequestStatus): number {
  return PROGRESS_RANK[status] ?? -1;
}

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Backoff of a failed_transient step: the 1st, 2nd and 3rd retry wait 1, 5 and 15 minutes. */
const TRANSIENT_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
export const MAX_TRANSIENT_RETRIES = 3;
/** A `capacity` outcome is a hold, never a failure (OD-10): offered again after this. */
export const CAPACITY_HOLD_MS = 15 * 60_000;
/** The contract's lease floor: at least 15 minutes. */
export const MIN_LEASE_TTL_MS = 15 * 60_000;
/** The site ceiling per host label (OD-10): pull withholds new tenant.provision at or above it. */
export const SITE_CEILING_PER_HOST = 20;

/** The stored columns the decisions read. */
export interface RequestState {
  readonly status: RequestStatus;
  readonly attemptFloor: number;
  readonly leaseHolder: string | null;
  readonly leaseExpiresAt: Date | null;
  /** The host that provisioned a `succeeded` request (migration 0112, RT-1389); null otherwise. */
  readonly provisionedHostLabel?: string | null;
  readonly notBefore: Date | null;
  readonly lastErrorClass: ErrorClass | null;
  readonly lastReason: string | null;
}

export function leaseIsLive(state: Pick<RequestState, "leaseExpiresAt">, now: Date): boolean {
  return state.leaseExpiresAt !== null && state.leaseExpiresAt.getTime() > now.getTime();
}

/**
 * "Outcome reported" is a DERIVED state, not a marker column: after a
 * `succeeded` outcome the request stays `verifying` with NO lease (holder, id and
 * expiry all NULL). A provisioner always holds a lease while it is `verifying`,
 * and the sweep never clears a `verifying` lease, so this is exactly the request
 * that waits for its first heartbeat. It is never offered again; the worker
 * sweep finishes or fails it. (No migration: the all-or-none lease CHECK allows it.)
 */
function outcomeReported(state: Pick<RequestState, "status" | "leaseExpiresAt">): boolean {
  return state.status === "verifying" && state.leaseExpiresAt === null;
}

/** Pull eligibility: non-terminal, outcome not yet reported, no live lease, not under a backoff. */
export function isOfferable(state: RequestState, now: Date): boolean {
  if (isTerminal(state.status) || state.status === "compensating") return false;
  if (outcomeReported(state)) return false;
  if (leaseIsLive(state, now)) return false;
  return state.notBefore === null || state.notBefore.getTime() <= now.getTime();
}

/** The columns a decision may change. */
export interface RequestPatch {
  readonly status?: RequestStatus;
  readonly attempt?: number;
  readonly attemptFloor: number;
  /** `take`: new lease id and holder; `renew`: same lease, new expiry; `clear`: no lease. */
  readonly lease: "take" | "renew" | "clear";
  readonly notBefore: Date | null;
  readonly lastErrorClass: ErrorClass | null;
  readonly lastReason: string | null;
  readonly terminal: boolean;
  /** Alert-worthy (retry cap spent): the service audits `erp.provisioning.failed`. */
  readonly alert: boolean;
}

export interface StepAckInput {
  readonly host: string;
  readonly step: StepName;
  readonly outcome: StepOutcome;
  readonly attempt: number;
  readonly reason: string | null;
  readonly now: Date;
  /** failed_transient rows already recorded for this step in this generation. */
  readonly priorTransientFailures: number;
  /** A connector credential was issued for the registration under this request. */
  readonly credentialIssued: boolean;
}

export type StepDecision =
  | { readonly kind: "apply"; readonly patch: RequestPatch }
  | { readonly kind: "lease_lost" }
  | { readonly kind: "idempotency_key_conflict" }
  | { readonly kind: "invalid_transition"; readonly reason: string };

function holdsLease(state: RequestState, host: string, now: Date): boolean {
  return leaseIsLive(state, now) && state.leaseHolder === host;
}

type PatchBase = Pick<RequestPatch, "attemptFloor" | "notBefore" | "lastErrorClass" | "lastReason" | "terminal" | "alert">;

/**
 * Decide one step acknowledgement. The caller has already answered an exact
 * replay (same request, step and attempt with the same outcome) and a same-key
 * different-outcome conflict from the step log; this covers the rest.
 */
export function decideStepAck(state: RequestState, ack: StepAckInput): StepDecision {
  if (isTerminal(state.status) || state.status === "compensating") return { kind: "lease_lost" };
  const claiming = ack.step === "claimed";
  if (claiming) {
    if (!holdsLease(state, ack.host, ack.now) && !isOfferable(state, ack.now)) return { kind: "lease_lost" };
  } else if (!holdsLease(state, ack.host, ack.now)) {
    return { kind: "lease_lost" };
  }
  if (ack.attempt <= state.attemptFloor) return { kind: "idempotency_key_conflict" };

  const base: PatchBase = { attemptFloor: ack.attempt, notBefore: null, lastErrorClass: null, lastReason: null, terminal: false, alert: false };

  if (ack.outcome === "done") return doneDecision(state, ack, base);
  if (claiming) return { kind: "invalid_transition", reason: "claimed only takes outcome done" };

  switch (ack.outcome) {
    case "failed_transient": {
      if (ack.priorTransientFailures >= MAX_TRANSIENT_RETRIES) {
        return {
          kind: "apply",
          patch: { ...base, status: "failed_permanent", lease: "clear", lastErrorClass: "failed_transient", lastReason: ack.reason, terminal: true, alert: true },
        };
      }
      const wait = TRANSIENT_BACKOFF_MS[ack.priorTransientFailures] ?? TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1]!;
      return {
        kind: "apply",
        patch: {
          ...base,
          status: "failed_retryable",
          attempt: ack.priorTransientFailures + 1,
          lease: "clear",
          notBefore: new Date(ack.now.getTime() + wait),
          lastErrorClass: "failed_transient",
          lastReason: ack.reason,
        },
      };
    }
    case "capacity":
      return {
        kind: "apply",
        patch: {
          ...base,
          status: "failed_retryable",
          lease: "clear",
          notBefore: new Date(ack.now.getTime() + CAPACITY_HOLD_MS),
          lastErrorClass: "capacity",
          lastReason: ack.reason,
        },
      };
    default:
      // permanently_rejected, conflict, compatibility, dependency: record and keep the
      // lease; the terminal outcome call moves the request to failed_permanent.
      return { kind: "apply", patch: { ...base, lease: "renew", lastErrorClass: ack.outcome, lastReason: ack.reason } };
  }
}

function doneDecision(state: RequestState, ack: StepAckInput, base: PatchBase): StepDecision {
  const target = STEP_STATUS[ack.step];
  if (ack.step === "claimed") {
    // A fresh claim starts at `claimed`; taking over a stale lease keeps the recorded progress.
    const keep = rank(state.status) > rank("claimed");
    return { kind: "apply", patch: { ...base, ...(keep ? {} : { status: "claimed" as const }), lease: "take" } };
  }
  if (rank(state.status) < rank("claimed")) return { kind: "invalid_transition", reason: "step before claimed" };
  if (ack.step === "credential_bound" && !ack.credentialIssued) {
    return { kind: "invalid_transition", reason: "credential_bound before a credential was issued" };
  }
  if (ack.step === "verified" && rank(state.status) < rank("credential_bound")) {
    return { kind: "invalid_transition", reason: "verified before credential_bound" };
  }
  const forward = rank(target) > rank(state.status);
  return { kind: "apply", patch: { ...base, ...(forward ? { status: target } : {}), lease: "renew" } };
}

export type OutcomeName = "succeeded" | "permanently_rejected" | "conflict";

export type OutcomeDecision =
  | { readonly kind: "lease_lost" }
  | { readonly kind: "invalid_transition"; readonly reason: string }
  /** succeeded and the first heartbeat already arrived: finish now. */
  | { readonly kind: "finish_succeeded" }
  /** succeeded: wait for the first heartbeat (the sweep finishes it). */
  | { readonly kind: "hold_for_heartbeat" }
  | { readonly kind: "fail_permanent"; readonly errorClass: "permanently_rejected" | "conflict"; readonly reason: string }
  /** The same logical outcome again: nothing changes. */
  | { readonly kind: "replay" };

/**
 * The same logical outcome again, from the host that gave it: the holder (a failed request keeps its
 * ended lease), the host recorded on a `succeeded` request, or the audited reporter while it waits.
 */
function isOutcomeReplay(state: RequestState, host: string, outcome: OutcomeName, reportedBy: string | null): boolean {
  if ((state.leaseHolder ?? state.provisionedHostLabel ?? reportedBy) !== host) return false;
  if (outcome === "succeeded") return state.status === "succeeded" || outcomeReported(state);
  return state.status === "failed_permanent" && state.lastErrorClass === outcome;
}

export function decideOutcome(
  state: RequestState,
  input: {
    readonly host: string;
    readonly outcome: OutcomeName;
    readonly reason: string | null;
    readonly now: Date;
    readonly heartbeatSeen: boolean;
    /** The host that reported `succeeded`, read from the audit trail (the request keeps no holder while it waits). */
    readonly reportedBy?: string | null;
  },
): OutcomeDecision {
  if (isOutcomeReplay(state, input.host, input.outcome, input.reportedBy ?? null)) return { kind: "replay" };
  if (isTerminal(state.status) || state.status === "compensating") return { kind: "lease_lost" };
  if (!holdsLease(state, input.host, input.now)) return { kind: "lease_lost" };
  if (input.outcome === "succeeded") {
    if (state.status !== "verifying") return { kind: "invalid_transition", reason: "succeeded needs the verified step first" };
    return input.heartbeatSeen ? { kind: "finish_succeeded" } : { kind: "hold_for_heartbeat" };
  }
  return { kind: "fail_permanent", errorClass: input.outcome, reason: input.reason ?? input.outcome };
}

/** The status transitions any writer may perform: the shared `packages/db` table (RT-1389). */
export const ALLOWED_TRANSITIONS = ERP_PROVISIONING_ALLOWED_TRANSITIONS;

export function transitionAllowed(from: RequestStatus, to: RequestStatus): boolean {
  return erpProvisioningTransitionAllowed(from, to);
}
