/**
 * RT-1440 (U1): what the close-without-a-count dialog does with each server answer.
 * `consoleForceCloseShift` is idempotent per shift and reason, so the answers split into
 * "done" (201 and the 200 replays), "look again" (preview_stale), "refused with a reason that
 * stays on screen" (shift_not_stuck and its blockers), "already decided" (a force close or a
 * cash-up got there first), and the shared refusals (403, 404, 429, 425, 5xx).
 */
import {
  type ForceCloseOutcome,
  classifyForceCloseOutcome,
  blockerKeys,
} from "@/force-actions/forceCloseOutcomes";
import { describe, expect, it } from "vitest";

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "server words never show", request_id: "req-1", ...extra },
});

describe("classifyForceCloseOutcome", () => {
  it("201 is a first-time close", () => {
    expect(classifyForceCloseOutcome({ status: 201 })).toEqual<ForceCloseOutcome>({
      kind: "closed",
      replay: false,
    });
  });

  it("200 is a replay of the recorded close, and still a success", () => {
    expect(classifyForceCloseOutcome({ status: 200 })).toEqual<ForceCloseOutcome>({
      kind: "closed",
      replay: true,
    });
  });

  it("409 preview_stale asks for a fresh preview, and sends nothing on its own", () => {
    expect(
      classifyForceCloseOutcome({ status: 409, error: err("preview_stale") }),
    ).toEqual<ForceCloseOutcome>({ kind: "stale" });
  });

  it("409 shift_not_stuck keeps the server's blockers as the persistent reason", () => {
    const out = classifyForceCloseOutcome({
      status: 409,
      error: err("shift_not_stuck", { details: { blockers: ["live_operator_session", "not_stale"] } }),
    });
    expect(out).toEqual<ForceCloseOutcome>({
      kind: "blocked",
      blockers: ["live_operator_session", "not_stale"],
    });
  });

  it("409 shift_not_stuck with no usable blockers is still blocked, never closed", () => {
    expect(
      classifyForceCloseOutcome({ status: 409, error: err("shift_not_stuck") }),
    ).toEqual<ForceCloseOutcome>({ kind: "blocked", blockers: [] });
  });

  it("409 shift_force_closed and shift_closed are final outcomes of another actor", () => {
    expect(classifyForceCloseOutcome({ status: 409, error: err("shift_force_closed") })).toMatchObject({
      kind: "settled",
      by: "force_close",
      requestId: "req-1",
    });
    expect(classifyForceCloseOutcome({ status: 409, error: err("shift_closed") })).toMatchObject({
      kind: "settled",
      by: "cash_up",
    });
  });

  it("409 idempotency_key_conflict is a rejected attempt with a request id, not a success", () => {
    expect(
      classifyForceCloseOutcome({ status: 409, error: err("idempotency_key_conflict") }),
    ).toMatchObject({ kind: "rejected", messageKey: "forceActions.close.error.generic" });
  });

  it("403 in a support session says the session is read-only", () => {
    expect(
      classifyForceCloseOutcome({ status: 403, error: err("support_session_read_only") }),
    ).toMatchObject({ kind: "rejected", messageKey: "forceActions.close.error.readOnlySession" });
  });

  it("any other 403 (role, origin) is a plain refusal", () => {
    expect(classifyForceCloseOutcome({ status: 403, error: err("origin_rejected") })).toMatchObject({
      kind: "rejected",
      messageKey: "forceActions.close.error.forbidden",
    });
  });

  it("404 is the non-disclosing 'not available for you'", () => {
    expect(classifyForceCloseOutcome({ status: 404, error: err("shift_not_found") })).toMatchObject({
      kind: "rejected",
      messageKey: "forceActions.close.error.notAvailable",
    });
  });

  it("429 force_action_rate_limited and the per-user 429 are told apart by their code", () => {
    expect(
      classifyForceCloseOutcome({ status: 429, error: err("force_action_rate_limited") }),
    ).toMatchObject({ kind: "rejected", messageKey: "forceActions.close.error.capReached" });
    expect(classifyForceCloseOutcome({ status: 429, error: err("rate_limited") })).toMatchObject({
      kind: "rejected",
      messageKey: "forceActions.close.error.rateLimited",
    });
  });

  it("400 is a rejected value; nothing was recorded", () => {
    expect(classifyForceCloseOutcome({ status: 400, error: err("validation_failure") })).toMatchObject({
      kind: "rejected",
      messageKey: "forceActions.close.error.validation",
    });
  });

  it("425, 5xx and a lost answer (status 0) may have recorded the close: keep the key, retry the same body", () => {
    for (const status of [425, 500, 503, 0]) {
      expect(classifyForceCloseOutcome({ status })).toMatchObject({ kind: "retryable" });
    }
  });

  it("401 is the session, not a refusal of the action", () => {
    expect(classifyForceCloseOutcome({ status: 401 })).toMatchObject({ kind: "session" });
  });
});

describe("blockerKeys", () => {
  it("maps each known blocker to its own catalog key, in the server's order", () => {
    expect(blockerKeys(["live_cashier_admission", "shift_not_open"])).toEqual([
      "forceActions.close.blocker.live_cashier_admission",
      "forceActions.close.blocker.shift_not_open",
    ]);
  });

  it("an unknown blocker never leaks its code: it reads as 'not closable now'", () => {
    expect(blockerKeys(["something_new"])).toEqual(["forceActions.close.blocker.unknown"]);
  });
});
