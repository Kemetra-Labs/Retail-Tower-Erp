/**
 * Failed sign-ins — RT-626 (RT-574 issue 5d). An ALERT signal, never enforced:
 * one count per `POST /auth/signin` that fails on credentials or is refused by
 * a sign-in rate-limit bucket. `cause` is the closed set
 * {invalid_credentials, rate_limited}. NEVER an email, IP, user or tenant
 * label. Kept apart from `auth_failure_total`, which also counts token
 * failures at the auth guard.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  auth_signin_failure_total: ["cause"],
};
