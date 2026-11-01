import { describe, expect, test } from "vitest";

import { passwordChangeBody, resolvePasswordChange } from "@/account/passwordChangeLogic";

/**
 * RT-807: `changePassword` (auth.openapi.yaml, RT-937) outcome → screen state.
 * The board's states (Password-states 5-9) and the contract's responses only.
 */

const env = (code: string, requestId = "7c0e8f4a-1b2c-4d5e-8f90-a1b2c3d4e5f6") => ({
  error: { code, message: "x", request_id: requestId },
});

describe("resolvePasswordChange", () => {
  test("204 is the success that keeps this session", () => {
    expect(resolvePasswordChange({ status: 204 })).toEqual({ kind: "changed" });
  });

  test("400 is ONE generic refusal, whatever the code says", () => {
    for (const code of ["validation_error", "password_change_refused", "anything"]) {
      expect(resolvePasswordChange({ status: 400, error: env(code) })).toEqual({
        kind: "refused",
        requestId: "7c0e8f4a-1b2c-4d5e-8f90-a1b2c3d4e5f6",
      });
    }
  });

  test("409 is blocked: no identity link", () => {
    expect(resolvePasswordChange({ status: 409, error: env("conflict") }).kind).toBe("no-link");
  });

  test("429 reads Retry-After, with or without an envelope (per-user budget sends none)", () => {
    expect(resolvePasswordChange({ status: 429, retryAfter: "240" })).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 240,
    });
    expect(
      resolvePasswordChange({ status: 429, retryAfter: "12", error: env("rate_limited") }),
    ).toMatchObject({ kind: "rate-limited", retryAfterSeconds: 12 });
    // Missing header: the shared 30 s fallback.
    expect(resolvePasswordChange({ status: 429 })).toMatchObject({ retryAfterSeconds: 30 });
  });

  test("503, any other 5xx and no response at all: the outcome is not confirmed", () => {
    expect(resolvePasswordChange({ status: 503 }).kind).toBe("not-confirmed");
    expect(resolvePasswordChange({ status: 500 }).kind).toBe("not-confirmed");
    expect(resolvePasswordChange({ status: 0 }).kind).toBe("not-confirmed");
  });

  test("401 is the expired session", () => {
    expect(resolvePasswordChange({ status: 401 }).kind).toBe("session-expired");
  });

  test("403 (origin_rejected) and any other 4xx: a plain failure, never the 400 copy", () => {
    expect(resolvePasswordChange({ status: 403, error: env("origin_rejected") })).toEqual({
      kind: "failed",
      requestId: "7c0e8f4a-1b2c-4d5e-8f90-a1b2c3d4e5f6",
    });
    expect(resolvePasswordChange({ status: 404 }).kind).toBe("failed");
  });
});

describe("passwordChangeBody", () => {
  test("sends exactly current and new (additionalProperties: false), never the confirm value", () => {
    const body = passwordChangeBody({ current: " a ", next: "bé", confirm: "bé" });
    expect(Object.keys(body).sort()).toEqual(["current_password", "new_password"]);
    // Sent as typed: no trimming, no normalization (contract).
    expect(body).toEqual({ current_password: " a ", new_password: "bé" });
  });
});
