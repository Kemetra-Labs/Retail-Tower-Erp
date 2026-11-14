/**
 * RT-1358 — the pure provisioning state machine: lease, attempt floor, backoff,
 * capacity hold, heartbeat hold and the exhaustive transition table (note 2 of
 * the #569 review: the DB lets the provisioner change unfrozen columns, so the
 * service is the only writer and enforces the machine).
 */
import {
  ALLOWED_TRANSITIONS,
  CAPACITY_HOLD_MS,
  decideOutcome,
  decideStepAck,
  isOfferable,
  MAX_TRANSIENT_RETRIES,
  REQUEST_STATUSES,
  TERMINAL_STATUSES,
  transitionAllowed,
  type RequestState,
  type RequestStatus,
  type StepAckInput,
} from "../../src/erp-provisioning/provisioning-state";

const NOW = new Date("2026-11-14T10:00:00Z");
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

function state(over: Partial<RequestState> = {}): RequestState {
  return { status: "requested", attemptFloor: 0, leaseHolder: null, leaseExpiresAt: null, notBefore: null, lastErrorClass: null, lastReason: null, ...over };
}
function leased(status: RequestStatus, over: Partial<RequestState> = {}): RequestState {
  return state({ status, leaseHolder: "lab-03", leaseExpiresAt: later(600_000), attemptFloor: 1, ...over });
}
function ack(over: Partial<StepAckInput> = {}): StepAckInput {
  return { host: "lab-03", step: "site_created", outcome: "done", attempt: 2, reason: null, now: NOW, priorTransientFailures: 0, credentialIssued: false, ...over };
}

describe("isOfferable (pull)", () => {
  it("offers requested and expired-lease requests, never a live lease, a backoff, a terminal or a reported one", () => {
    expect(isOfferable(state(), NOW)).toBe(true);
    expect(isOfferable(leased("site_created", { leaseExpiresAt: later(-1) }), NOW)).toBe(true);
    expect(isOfferable(leased("site_created"), NOW)).toBe(false);
    expect(isOfferable(state({ status: "failed_retryable", notBefore: later(60_000) }), NOW)).toBe(false);
    expect(isOfferable(state({ status: "failed_retryable", notBefore: later(-1) }), NOW)).toBe(true);
    for (const t of TERMINAL_STATUSES) expect(isOfferable(state({ status: t }), NOW)).toBe(false);
    expect(isOfferable(state({ status: "compensating" }), NOW)).toBe(false);
    // a reported outcome (verifying, no lease) is never re-offered; a provisioner that crashed after
    // `verified` and before its outcome (verifying, expired lease) is offered again
    expect(isOfferable(state({ status: "verifying" }), NOW)).toBe(false);
    expect(isOfferable(leased("verifying", { leaseExpiresAt: later(-1) }), NOW)).toBe(true);
  });
});

describe("decideStepAck", () => {
  it("claimed takes a lease on an offerable request and moves requested -> claimed", () => {
    const d = decideStepAck(state(), ack({ step: "claimed", attempt: 1 }));
    expect(d).toMatchObject({ kind: "apply", patch: { status: "claimed", lease: "take", attemptFloor: 1 } });
  });

  it("a re-claim after a lost lease keeps the recorded progress", () => {
    const d = decideStepAck(leased("erp_configured", { leaseExpiresAt: later(-1) }), ack({ step: "claimed", attempt: 2 }));
    expect(d.kind).toBe("apply");
    if (d.kind === "apply") expect(d.patch.status).toBeUndefined();
  });

  it("another provisioner's live lease, a missing lease and a terminal request are lease_lost", () => {
    expect(decideStepAck(leased("claimed", { leaseHolder: "lab-04" }), ack({ step: "claimed" })).kind).toBe("lease_lost");
    expect(decideStepAck(leased("claimed", { leaseHolder: "lab-04" }), ack()).kind).toBe("lease_lost");
    expect(decideStepAck(state({ status: "claimed" }), ack()).kind).toBe("lease_lost");
    expect(decideStepAck(leased("claimed", { leaseExpiresAt: later(-1) }), ack()).kind).toBe("lease_lost");
    expect(decideStepAck(state({ status: "succeeded" }), ack({ step: "claimed" })).kind).toBe("lease_lost");
  });

  it("a request under backoff cannot be claimed early", () => {
    expect(decideStepAck(state({ status: "failed_retryable", notBefore: later(60_000) }), ack({ step: "claimed" })).kind).toBe("lease_lost");
  });

  it("an attempt at or below the floor is idempotency_key_conflict", () => {
    expect(decideStepAck(leased("claimed", { attemptFloor: 5 }), ack({ attempt: 5 })).kind).toBe("idempotency_key_conflict");
    expect(decideStepAck(leased("claimed", { attemptFloor: 5 }), ack({ attempt: 6 })).kind).toBe("apply");
  });

  it("done moves the status forward only and renews the lease", () => {
    const fwd = decideStepAck(leased("claimed"), ack({ step: "erp_configured" }));
    expect(fwd).toMatchObject({ kind: "apply", patch: { status: "erp_configured", lease: "renew" } });
    const back = decideStepAck(leased("connector_installed"), ack({ step: "site_created" }));
    expect(back.kind === "apply" && back.patch.status).toBeFalsy();
  });

  it("credential_bound needs an issued credential; verified needs credential_bound", () => {
    expect(decideStepAck(leased("connector_installed"), ack({ step: "credential_bound" })).kind).toBe("invalid_transition");
    expect(decideStepAck(leased("connector_installed"), ack({ step: "credential_bound", credentialIssued: true })).kind).toBe("apply");
    expect(decideStepAck(leased("connector_installed"), ack({ step: "verified" })).kind).toBe("invalid_transition");
    expect(decideStepAck(leased("credential_bound"), ack({ step: "verified" }))).toMatchObject({ kind: "apply", patch: { status: "verifying" } });
  });

  it("failed_transient backs off 1, 5, 15 minutes, then fails permanently with an alert", () => {
    const wait = (n: number): number | null => {
      const d = decideStepAck(leased("site_created"), ack({ outcome: "failed_transient", priorTransientFailures: n }));
      return d.kind === "apply" && d.patch.notBefore ? d.patch.notBefore.getTime() - NOW.getTime() : null;
    };
    expect([wait(0), wait(1), wait(2)]).toEqual([60_000, 300_000, 900_000]);
    const spent = decideStepAck(leased("site_created"), ack({ outcome: "failed_transient", priorTransientFailures: MAX_TRANSIENT_RETRIES }));
    expect(spent).toMatchObject({ kind: "apply", patch: { status: "failed_permanent", terminal: true, alert: true, lease: "clear" } });
  });

  it("capacity is a hold: retryable, 15 minutes, never counted, never failed", () => {
    const d = decideStepAck(leased("site_created"), ack({ outcome: "capacity", priorTransientFailures: 99 }));
    expect(d).toMatchObject({ kind: "apply", patch: { status: "failed_retryable", lease: "clear", lastErrorClass: "capacity", terminal: false } });
    if (d.kind === "apply") expect(d.patch.notBefore!.getTime() - NOW.getTime()).toBe(CAPACITY_HOLD_MS);
  });

  it("stop classes record the step and keep the lease and the status", () => {
    for (const outcome of ["permanently_rejected", "conflict", "compatibility", "dependency"] as const) {
      const d = decideStepAck(leased("site_created"), ack({ outcome, reason: "r" }));
      expect(d).toMatchObject({ kind: "apply", patch: { lease: "renew", lastErrorClass: outcome, terminal: false } });
      if (d.kind === "apply") expect(d.patch.status).toBeUndefined();
    }
  });

  it("claimed only takes outcome done", () => {
    expect(decideStepAck(state(), ack({ step: "claimed", outcome: "conflict", attempt: 1 })).kind).toBe("invalid_transition");
  });
});

describe("decideOutcome", () => {
  const input = { host: "lab-03", outcome: "succeeded" as const, reason: null, now: NOW, heartbeatSeen: false };

  it("succeeded holds for the first heartbeat, or finishes at once when it already arrived", () => {
    expect(decideOutcome(leased("verifying"), input).kind).toBe("hold_for_heartbeat");
    expect(decideOutcome(leased("verifying"), { ...input, heartbeatSeen: true }).kind).toBe("finish_succeeded");
  });

  it("succeeded before verifying is refused; without the lease it is lease_lost", () => {
    expect(decideOutcome(leased("credential_bound"), input).kind).toBe("invalid_transition");
    expect(decideOutcome(leased("verifying", { leaseHolder: "lab-04" }), input).kind).toBe("lease_lost");
    expect(decideOutcome(leased("verifying", { leaseExpiresAt: later(-1) }), input).kind).toBe("lease_lost");
  });

  it("a repeat of the same logical outcome is a replay", () => {
    expect(decideOutcome(state({ status: "verifying" }), { ...input, reportedBy: "lab-03" }).kind).toBe("replay");
    expect(decideOutcome(state({ status: "verifying" }), { ...input, reportedBy: "lab-04" }).kind).toBe("lease_lost");
    expect(decideOutcome(state({ status: "succeeded", leaseHolder: "lab-03", leaseExpiresAt: later(-1) }), input).kind).toBe("replay");
    // RT-1389: a succeeded request keeps no lease; its recorded host is the replay key.
    expect(decideOutcome(state({ status: "succeeded", provisionedHostLabel: "lab-03" }), input).kind).toBe("replay");
    expect(decideOutcome(state({ status: "succeeded", provisionedHostLabel: "lab-04" }), input).kind).toBe("lease_lost");
    expect(decideOutcome(state({ status: "failed_permanent", lastErrorClass: "conflict", leaseHolder: "lab-03", leaseExpiresAt: later(-1) }), { ...input, outcome: "conflict", reason: "x" }).kind).toBe("replay");
  });

  it("conflict and permanently_rejected fail the request permanently", () => {
    expect(decideOutcome(leased("site_created"), { ...input, outcome: "conflict", reason: "marker" })).toMatchObject({ kind: "fail_permanent", errorClass: "conflict" });
  });
});

describe("transition table (the repository refuses anything else)", () => {
  it("terminal statuses have no way out, and every status is covered", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...REQUEST_STATUSES].sort());
    for (const t of TERMINAL_STATUSES) expect(ALLOWED_TRANSITIONS[t]).toEqual([]);
  });

  it("never moves backwards or out of a terminal state", () => {
    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        const ok = transitionAllowed(from, to);
        if (TERMINAL_STATUSES.includes(from) && from !== to) expect({ from, to, ok }).toEqual({ from, to, ok: false });
        if (to === "requested" && from !== "requested") expect({ from, to, ok }).toEqual({ from, to, ok: false });
      }
    }
    expect(transitionAllowed("verifying", "succeeded")).toBe(true);
    expect(transitionAllowed("claimed", "succeeded")).toBe(false);
    expect(transitionAllowed("failed_retryable", "claimed")).toBe(true);
  });
});
