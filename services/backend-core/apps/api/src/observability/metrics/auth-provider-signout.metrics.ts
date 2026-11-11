/**
 * Provider sign-out failure signal — RT-1327.
 *
 * After a provider-backed password reset, Backend-Core ends every provider
 * session of the user (the identity provider's sign-out of all sessions),
 * retrying an outage once. When it
 * still fails, sessions opened with the old password may survive, so this
 * counter feeds the Datadog monitor `p2-api-provider-signout-fail`
 * (`deploy/datadog/monitors.json`). An ALERT, never a control: the reset has
 * already succeeded and its response does not change.
 *
 * Same two-layer label policy as `auth-signin-failure.metrics.ts`. The `auth_`
 * prefix keeps it inside the Datadog agent's scrape allowlist.
 */
import { assertMetricLabels, getMeter, type Attributes, type Counter } from "@data-pulse-2/shared";

/** `refused`: the provider rejected the sign-out. `unavailable`: outage, twice. */
export const PROVIDER_SIGNOUT_FAILURE_RESULTS = ["refused", "unavailable"] as const satisfies readonly string[];
type ProviderSignOutFailureResult =(typeof PROVIDER_SIGNOUT_FAILURE_RESULTS)[number];

export const PROVIDER_SIGNOUT_FAILURE_METRIC_NAME = "auth_provider_signout_failure_total";

assertMetricLabels(PROVIDER_SIGNOUT_FAILURE_METRIC_NAME, ["result"]);

const _signOutFailure: Counter = getMeter("api").createCounter(PROVIDER_SIGNOUT_FAILURE_METRIC_NAME, {
  description:
    "Identity-provider sign-outs of all sessions after a provider-backed password reset that still failed after one retry, by result (refused | unavailable) (RT-1327). Alert only. No email, user, subject, tenant or token label.",
});

// Seed every series at 0 so the monitor's no-data alert means a broken scrape.
for (const result of PROVIDER_SIGNOUT_FAILURE_RESULTS) {
  _signOutFailure.add(0, { result });
}

export interface ProviderSignOutFailureAttrs {
  result: ProviderSignOutFailureResult;
}

/** Increment auth_provider_signout_failure_total{result}. A SIGNAL: never changes the response. */
export function recordProviderSignOutFailure(attrs: ProviderSignOutFailureAttrs): void {
  _signOutFailure.add(1, attrs as unknown as Attributes);
}
