/**
 * RT-1441 (U2): how the store deletion reads each answer of `consoleDeleteStore` and
 * `consoleReauthenticate`. Pure. The server decides; this only maps its answer to a dialog state
 * and a catalog key, so the server's words never show (the request id does, as a support handle).
 */
import {
  classifyDeletionOutcome,
  classifyReauthOutcome,
} from "@/store-deletion/storeDeletionOutcomes";
import { describe, expect, it } from "vitest";

const err = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "server words never show", request_id: "req-1", ...extra },
});

describe("classifyDeletionOutcome", () => {
  it("200 is deleted, and a replay says so", () => {
    expect(classifyDeletionOutcome({ status: 200 })).toEqual({ kind: "deleted", replay: false });
    expect(classifyDeletionOutcome({ status: 200, replayed: true })).toEqual({
      kind: "deleted",
      replay: true,
    });
  });

  it.each([
    "store_has_open_shift",
    "store_has_unretired_device",
    "store_device_queue_unsynced",
    "store_has_open_count_session",
  ])("409 %s is blocked, with the server's blockers {code, count}", (code) => {
    const blockers = [
      { code: "store_has_open_shift", count: 2 },
      { code: "store_has_open_count_session", count: 1 },
    ];
    expect(
      classifyDeletionOutcome({ status: 409, error: err(code, { details: { blockers } }) }),
    ).toEqual({
      kind: "blocked",
      blockers,
    });
  });

  it("a blocker entry that is not {code: string, count: number} is dropped", () => {
    const out = classifyDeletionOutcome({
      status: 409,
      error: err("store_has_open_shift", {
        details: {
          blockers: ["store_has_open_shift", { code: 1, count: 1 }, { code: "ok", count: 2 }],
        },
      }),
    });
    expect(out).toEqual({ kind: "blocked", blockers: [{ code: "ok", count: 2 }] });
  });

  it("409 preview_stale reads the preview again and sends nothing", () => {
    expect(classifyDeletionOutcome({ status: 409, error: err("preview_stale") })).toEqual({
      kind: "stale",
    });
  });

  it("409 with any other code is a rejected attempt with a generic key", () => {
    expect(
      classifyDeletionOutcome({ status: 409, error: err("idempotency_key_conflict") }),
    ).toEqual({
      kind: "rejected",
      messageKey: "storeDeletion.error.generic",
      requestId: "req-1",
    });
  });

  it("403 reauth_required asks for the password again", () => {
    expect(classifyDeletionOutcome({ status: 403, error: err("reauth_required") })).toEqual({
      kind: "reauthRequired",
    });
  });

  it("403 owner-only, a support session and any other refusal each have their own key", () => {
    expect(
      classifyDeletionOutcome({ status: 403, error: err("store_deletion_owner_only") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.ownerOnly",
    });
    expect(
      classifyDeletionOutcome({ status: 403, error: err("support_session_read_only") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.readOnlySession",
    });
    expect(classifyDeletionOutcome({ status: 403, error: err("origin_rejected") })).toMatchObject({
      messageKey: "storeDeletion.error.forbidden",
    });
  });

  it("404 is the non-disclosing not-available; 400 is a validation refusal", () => {
    expect(classifyDeletionOutcome({ status: 404 })).toMatchObject({
      kind: "rejected",
      messageKey: "storeDeletion.error.notAvailable",
    });
    expect(classifyDeletionOutcome({ status: 400, error: err("validation_error") })).toMatchObject({
      messageKey: "storeDeletion.error.validation",
    });
  });

  it("429 is the tenant cap when the server says so, else the rate limit", () => {
    expect(
      classifyDeletionOutcome({ status: 429, error: err("force_action_rate_limited") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.capReached",
    });
    expect(classifyDeletionOutcome({ status: 429, error: err("rate_limited") })).toMatchObject({
      messageKey: "storeDeletion.error.rateLimited",
    });
  });

  it("425, 5xx and no answer are retryable: the delete may already be recorded", () => {
    for (const status of [425, 500, 502, 503, 0]) {
      expect(classifyDeletionOutcome({ status }).kind).toBe("retryable");
    }
  });

  it("401 is the session; another 4xx is a generic refusal", () => {
    expect(classifyDeletionOutcome({ status: 401 })).toEqual({ kind: "session" });
    expect(classifyDeletionOutcome({ status: 418 })).toMatchObject({
      kind: "rejected",
      messageKey: "storeDeletion.error.generic",
    });
  });
});

describe("classifyReauthOutcome", () => {
  it("200 with a token is granted", () => {
    expect(classifyReauthOutcome({ status: 200, data: { reauthToken: "tok" } })).toEqual({
      kind: "granted",
      token: "tok",
    });
  });

  it("200 with no token is not a grant", () => {
    expect(classifyReauthOutcome({ status: 200, data: {} })).toMatchObject({ kind: "rejected" });
  });

  it("403 reauth_failed is one generic refusal, never saying which part was wrong", () => {
    expect(classifyReauthOutcome({ status: 403, error: err("reauth_failed") })).toEqual({
      kind: "rejected",
      messageKey: "storeDeletion.reauth.failed",
      requestId: "req-1",
    });
  });

  it("429 is rate limited (or the tenant cap); 503 and no answer mean nothing was granted", () => {
    expect(classifyReauthOutcome({ status: 429, error: err("rate_limited") })).toMatchObject({
      messageKey: "storeDeletion.reauth.rateLimited",
    });
    expect(
      classifyReauthOutcome({ status: 429, error: err("force_action_rate_limited") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.capReached",
    });
    expect(
      classifyReauthOutcome({ status: 503, error: err("identity_provider_unavailable") }),
    ).toMatchObject({
      messageKey: "storeDeletion.reauth.unavailable",
    });
    expect(classifyReauthOutcome({ status: 0 })).toMatchObject({
      messageKey: "storeDeletion.reauth.unavailable",
    });
  });

  it("owner-only, a support session, 404, 400 and 401 map to their own outcome", () => {
    expect(
      classifyReauthOutcome({ status: 403, error: err("store_deletion_owner_only") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.ownerOnly",
    });
    expect(
      classifyReauthOutcome({ status: 403, error: err("support_session_expired") }),
    ).toMatchObject({
      messageKey: "storeDeletion.error.readOnlySession",
    });
    expect(classifyReauthOutcome({ status: 404 })).toMatchObject({
      messageKey: "storeDeletion.error.notAvailable",
    });
    expect(classifyReauthOutcome({ status: 400 })).toMatchObject({
      messageKey: "storeDeletion.error.validation",
    });
    expect(classifyReauthOutcome({ status: 401 })).toEqual({ kind: "session" });
  });
});
