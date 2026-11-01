/**
 * RT-626 (RT-574 issue 5d) — `auth_signin_failure_total` label bounds.
 *
 * The failed-sign-in counter is an alert signal, so its labels must stay
 * bounded and PII-free: one `cause` label from a closed set of two outcomes,
 * never an email, IP, user or tenant. Registered in its own label fragment
 * (RT-812), not in the frozen baseline.
 */
import {
  ALLOWED_METRIC_LABELS,
  METRIC_LABEL_SOURCES,
  validateMetricLabels,
} from "@data-pulse-2/shared";

import {
  recordSignInFailure,
  SIGNIN_FAILURE_CAUSES,
  SIGNIN_FAILURE_METRIC_NAME,
} from "../../src/observability/metrics/auth-signin-failure.metrics";

describe("RT-626: auth_signin_failure_total labels are bounded", () => {
  it("is registered with exactly one label, `cause`, from its own fragment", () => {
    expect(SIGNIN_FAILURE_METRIC_NAME).toBe("auth_signin_failure_total");
    expect(ALLOWED_METRIC_LABELS[SIGNIN_FAILURE_METRIC_NAME]).toEqual(["cause"]);
    expect(METRIC_LABEL_SOURCES[SIGNIN_FAILURE_METRIC_NAME]).toBe("auth-signin-failure");
  });

  it("`cause` is the closed set {invalid_credentials, rate_limited}", () => {
    expect([...SIGNIN_FAILURE_CAUSES].sort()).toEqual(["invalid_credentials", "rate_limited"]);
  });

  it("no cause value carries credential or identity material", () => {
    for (const cause of SIGNIN_FAILURE_CAUSES) {
      expect(cause).toMatch(/^[a-z_]+$/);
      expect(cause).not.toMatch(/@|email|password|token|ip|user|tenant/);
    }
  });

  it.each(["email", "ip", "user_id", "tenant_id", "route"])("rejects a `%s` label", (label) => {
    expect(validateMetricLabels(SIGNIN_FAILURE_METRIC_NAME, ["cause", label])).not.toBeNull();
  });

  it("is distinct from auth_failure_total, which also counts guard token failures", () => {
    expect(SIGNIN_FAILURE_METRIC_NAME).not.toBe("auth_failure_total");
    expect(ALLOWED_METRIC_LABELS["auth_failure_total"]).toEqual(["cause"]);
  });

  it("recording each cause never throws (no MetricReader registered)", () => {
    for (const cause of SIGNIN_FAILURE_CAUSES) {
      expect(() => recordSignInFailure({ cause })).not.toThrow();
    }
  });
});
