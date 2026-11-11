/**
 * RT-1327 — `auth_provider_signout_failure_total` label bounds.
 *
 * After a provider-backed password reset, Backend-Core ends every provider
 * session of the user (Descope `logoutall`). When that still fails after one
 * retry, provider sessions opened with the old password may survive, so the
 * failure is an ALERT signal. Its labels must stay bounded and PII-free: one
 * `result` label from a closed set, never an email, user, subject or token.
 */
import {
  ALLOWED_METRIC_LABELS,
  METRIC_LABEL_SOURCES,
  validateMetricLabels,
} from "@data-pulse-2/shared";

import {
  PROVIDER_SIGNOUT_FAILURE_METRIC_NAME,
  PROVIDER_SIGNOUT_FAILURE_RESULTS,
  recordProviderSignOutFailure,
} from "../../src/observability/metrics/auth-provider-signout.metrics";

describe("RT-1327: auth_provider_signout_failure_total labels are bounded", () => {
  it("is registered with exactly one label, `result`, from its own fragment", () => {
    expect(PROVIDER_SIGNOUT_FAILURE_METRIC_NAME).toBe("auth_provider_signout_failure_total");
    expect(ALLOWED_METRIC_LABELS[PROVIDER_SIGNOUT_FAILURE_METRIC_NAME]).toEqual(["result"]);
    expect(METRIC_LABEL_SOURCES[PROVIDER_SIGNOUT_FAILURE_METRIC_NAME]).toBe("auth-provider-signout");
  });

  it("`result` is the closed set {refused, unavailable}", () => {
    expect([...PROVIDER_SIGNOUT_FAILURE_RESULTS].sort()).toEqual(["refused", "unavailable"]);
  });

  it.each(["email", "user_id", "subject", "tenant_id", "token"])("rejects a `%s` label", (label) => {
    expect(validateMetricLabels(PROVIDER_SIGNOUT_FAILURE_METRIC_NAME, ["result", label])).not.toBeNull();
  });

  it("recording each result never throws (no MetricReader registered)", () => {
    for (const result of PROVIDER_SIGNOUT_FAILURE_RESULTS) {
      expect(() => recordProviderSignOutFailure({ result })).not.toThrow();
    }
  });
});
