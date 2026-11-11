/**
 * Provider sign-out failures after a password reset — RT-1327. An ALERT signal:
 * one count when the identity provider's sign-out of all sessions still fails
 * after its single retry, so
 * provider sessions opened with the old password may survive. `result` is the
 * closed set {refused, unavailable}. NEVER an email, user, subject, tenant or
 * token label.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  auth_provider_signout_failure_total: ["result"],
};
