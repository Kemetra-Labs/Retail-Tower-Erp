import {
  extractResetToken,
  resolvePasswordResetConfirm,
  resolvePasswordResetRequest,
  validateResetEmail,
  validateResetPasswordForm,
} from "@/auth/password-reset-flow";
import { describe, expect, test } from "vitest";

describe("password-reset-flow pure logic (RT-1497)", () => {
  test("extractResetToken accepts Descope ?t= and native ?token=, preferring ?t=", () => {
    expect(extractResetToken(new URLSearchParams("?t=descope-tok"))).toBe("descope-tok");
    expect(extractResetToken(new URLSearchParams("?token=native-tok"))).toBe("native-tok");
    expect(extractResetToken(new URLSearchParams("?t=first&token=second"))).toBe("first");
    expect(extractResetToken(new URLSearchParams(""))).toBe("");
  });

  test("validateResetEmail rejects empty and malformed addresses, accepts valid email", () => {
    expect(validateResetEmail("")).toBe("auth.forgotPassword.errors.emailRequired");
    expect(validateResetEmail("   ")).toBe("auth.forgotPassword.errors.emailRequired");
    expect(validateResetEmail("not-an-email")).toBe("auth.forgotPassword.errors.invalidEmail");
    expect(validateResetEmail("user@domain")).toBe("auth.forgotPassword.errors.invalidEmail");
    expect(validateResetEmail("  ops@store.eg  ")).toBeNull();
  });

  test("validateResetPasswordForm enforces required fields and exact match without trimming", () => {
    expect(validateResetPasswordForm("", "abc")).toBe("auth.account.errors.newRequired");
    expect(validateResetPasswordForm("abc", "")).toBe("auth.account.errors.confirmRequired");
    expect(validateResetPasswordForm("secret ", "secret")).toBe("auth.account.errors.mismatch");
    expect(validateResetPasswordForm("secret ", "secret ")).toBeNull();
  });

  test("resolvePasswordResetRequest returns opaque sent on 202 and maps 400/429/503/500", () => {
    expect(resolvePasswordResetRequest({ status: 202 })).toEqual({ kind: "sent" });
    expect(
      resolvePasswordResetRequest({
        status: 429,
        retryAfterSeconds: 45,
        error: { error: { code: "rate_limited", message: "slow down", request_id: "r-429" } },
      }),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: 45, requestId: "r-429" });
    expect(resolvePasswordResetRequest({ status: 429 })).toEqual({
      kind: "rate-limited",
      retryAfterSeconds: 0,
      requestId: undefined,
    });
    expect(
      resolvePasswordResetRequest({
        status: 400,
        error: { error: { code: "bad_request", message: "bad", request_id: "r-400" } },
      }),
    ).toEqual({
      kind: "error",
      messageKey: "auth.forgotPassword.errors.invalidEmail",
      requestId: "r-400",
    });
    expect(resolvePasswordResetRequest({ status: 503 })).toEqual({
      kind: "error",
      messageKey: "auth.forgotPassword.errors.unavailable",
      requestId: undefined,
    });
    expect(resolvePasswordResetRequest({ status: 500 })).toEqual({
      kind: "error",
      messageKey: "auth.forgotPassword.errors.failed",
      requestId: undefined,
    });
  });

  test("resolvePasswordResetConfirm maps 204/400/429/503/500", () => {
    expect(resolvePasswordResetConfirm({ status: 204 })).toEqual({ kind: "done" });
    expect(
      resolvePasswordResetConfirm({
        status: 400,
        error: { error: { code: "invalid_token", message: "expired", request_id: "r-400" } },
      }),
    ).toEqual({
      kind: "error",
      messageKey: "auth.resetPassword.errors.invalidOrRefused",
      requestId: "r-400",
    });
    expect(
      resolvePasswordResetConfirm({
        status: 429,
        retryAfterSeconds: 30,
        error: { error: { code: "rate_limited", message: "wait", request_id: "r-429" } },
      }),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: 30, requestId: "r-429" });
    expect(resolvePasswordResetConfirm({ status: 503 })).toEqual({
      kind: "error",
      messageKey: "auth.resetPassword.errors.unavailable",
      requestId: undefined,
    });
    expect(resolvePasswordResetConfirm({ status: 500 })).toEqual({
      kind: "error",
      messageKey: "auth.resetPassword.errors.failed",
      requestId: undefined,
    });
  });
});
