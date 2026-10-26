/**
 * Pre-auth rate limiting — RT-630 (RT-574 R1, owner O5). REPORT-ONLY: one
 * count per request that fails authentication while the mode is `report`.
 * `cause` is the closed set {missing, bad_token}; `outcome` is the closed set
 * {allowed, near_limit, would_limit, fail_open}. The histogram records the
 * share of the per-IP ceiling used. NEVER an IP, user, tenant, cookie or
 * token label: the IP is PII (redaction matrix) and unbounded.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  preauth_rate_limit_total: ["cause", "outcome"],
  preauth_rate_limit_utilisation: ["cause"],
};
