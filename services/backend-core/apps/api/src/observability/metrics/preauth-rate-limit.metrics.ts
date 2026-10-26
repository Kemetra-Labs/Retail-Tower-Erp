/**
 * Pre-auth rate-limit signals — RT-630 (RT-574 R1, owner O5).
 *
 * Kept apart from `api.metrics.ts` (already at the file-size limit). Same
 * two-layer label policy: `assertMetricLabels` at module load, and helper
 * parameter types that admit only the declared label keys. No IP, user,
 * tenant, cookie or token label can compile.
 */
import {
  assertMetricLabels,
  getMeter,
  type Attributes,
  type Counter,
  type Histogram,
} from "@data-pulse-2/shared";

/** Closed causes: no credential at all, or one that did not authenticate. */
export const PREAUTH_RATE_LIMIT_CAUSES = ["missing", "bad_token"] as const satisfies readonly string[];
export type PreAuthRateLimitCause = (typeof PREAUTH_RATE_LIMIT_CAUSES)[number];

/**
 * Closed outcomes, mutually exclusive per request: `allowed` (under 50% of
 * the per-IP ceiling), `near_limit` (50% or more), `would_limit` (over the
 * ceiling; the request is still answered as before), `fail_open` (limiter
 * error, timeout or open breaker: not counted). There is no `limited`.
 */
export const PREAUTH_RATE_LIMIT_OUTCOMES = [
  "allowed",
  "near_limit",
  "would_limit",
  "fail_open",
] as const satisfies readonly string[];
export type PreAuthRateLimitOutcome = (typeof PREAUTH_RATE_LIMIT_OUTCOMES)[number];

/** Histogram buckets for `preauth_rate_limit_utilisation` (count / limit). */
export const PREAUTH_RATE_LIMIT_UTILISATION_BUCKETS = [0.1, 0.25, 0.5, 0.75, 0.9, 1, 2, 5, 10] as const;

assertMetricLabels("preauth_rate_limit_total", ["cause", "outcome"]);
assertMetricLabels("preauth_rate_limit_utilisation", ["cause"]);

const meter = getMeter("api");

const _preAuthRateLimit: Counter = meter.createCounter("preauth_rate_limit_total", {
  description:
    "Requests that failed authentication, counted per client IP against a report-only ceiling (RT-630, RT-574 R1), by cause (missing | bad_token) and outcome (allowed | near_limit | would_limit | fail_open). Emitted only when PREAUTH_RATE_LIMIT_MODE is report. Never refuses. No IP, user or tenant label.",
});

const _preAuthRateLimitUtilisation: Histogram = meter.createHistogram("preauth_rate_limit_utilisation", {
  description:
    "Share of the per-IP pre-auth ceiling used at each counted failed-auth request (count / limit; above 1 is over the ceiling), by cause (RT-630). No IP, user or tenant label.",
  advice: { explicitBucketBoundaries: [...PREAUTH_RATE_LIMIT_UTILISATION_BUCKETS] },
});

export interface PreAuthRateLimitAttrs {
  cause: PreAuthRateLimitCause;
  outcome: PreAuthRateLimitOutcome;
}

export interface PreAuthRateLimitUtilisationAttrs {
  cause: PreAuthRateLimitCause;
}

/** Increment preauth_rate_limit_total{cause,outcome}. A SIGNAL: never changes the response. */
export function recordPreAuthRateLimit(attrs: PreAuthRateLimitAttrs): void {
  _preAuthRateLimit.add(1, attrs as unknown as Attributes);
}

/** Record preauth_rate_limit_utilisation{cause} = count / limit. */
export function recordPreAuthRateLimitUtilisation(attrs: PreAuthRateLimitUtilisationAttrs, utilisation: number): void {
  _preAuthRateLimitUtilisation.record(utilisation, attrs as unknown as Attributes);
}

/** Canonical names of the pre-auth rate-limit signals (RT-630). */
export const PREAUTH_RATE_LIMIT_METRIC_NAMES = [
  "preauth_rate_limit_total",
  "preauth_rate_limit_utilisation",
] as const satisfies readonly string[];
