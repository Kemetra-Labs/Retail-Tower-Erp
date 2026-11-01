/**
 * Failed sign-in signal — RT-626 (RT-574 issue 5d).
 *
 * An ALERT, not a control: the counter feeds the Datadog monitor
 * `p2-api-signin-failures` (`deploy/datadog/monitors.json`) and never changes
 * a response. An enforced global cap would itself be a lockout DoS.
 *
 * Kept apart from `api.metrics.ts` (already at the file-size limit), as
 * RT-630 did. Same two-layer label policy: `assertMetricLabels` at module
 * load, and a helper parameter type that admits only the declared label key.
 *
 * The name keeps the `auth_` prefix on purpose: the Datadog agent scrapes only
 * the prefixes listed in `docker-compose.prod.yml` (`dd_openmetrics`), and
 * `auth_` is one of them.
 */
import { assertMetricLabels, getMeter, type Attributes, type Counter } from "@data-pulse-2/shared";

/**
 * Closed causes. `invalid_credentials`: the sign-in reached the credential
 * check and failed it (unknown email, wrong password, SSO-only, deleted: one
 * cause, as the response is one 401). `rate_limited`: refused by the
 * per-account or per-IP sign-in bucket (429).
 */
export const SIGNIN_FAILURE_CAUSES = ["invalid_credentials", "rate_limited"] as const satisfies readonly string[];
export type SignInFailureCause = (typeof SIGNIN_FAILURE_CAUSES)[number];

export const SIGNIN_FAILURE_METRIC_NAME = "auth_signin_failure_total";

assertMetricLabels(SIGNIN_FAILURE_METRIC_NAME, ["cause"]);

const _signInFailure: Counter = getMeter("api").createCounter(SIGNIN_FAILURE_METRIC_NAME, {
  description:
    "Sign-ins that failed on credentials or were refused by a sign-in rate-limit bucket (RT-626, RT-574 5d), by cause (invalid_credentials | rate_limited). Alert only, never enforced. No email, IP, user or tenant label.",
});

// Seed every series at 0, so a quiet API still exports the counter and the
// monitor's no-data alert means a broken scrape, not a night without failures.
for (const cause of SIGNIN_FAILURE_CAUSES) {
  _signInFailure.add(0, { cause });
}

export interface SignInFailureAttrs {
  cause: SignInFailureCause;
}

/** Increment auth_signin_failure_total{cause}. A SIGNAL: never changes the response. */
export function recordSignInFailure(attrs: SignInFailureAttrs): void {
  _signInFailure.add(1, attrs as unknown as Attributes);
}
