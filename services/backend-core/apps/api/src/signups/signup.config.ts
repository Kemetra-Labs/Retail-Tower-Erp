/**
 * Signup configuration and fixed policy numbers (RT-1350 slice 3).
 *
 * `SIGNUP_CURRENT_TERMS_VERSION` is the terms version the Console must send. It is
 * required for the public signup to open (design D6, the pre-launch gate): when it is
 * unset the service answers 503, never 202, so no signup is recorded without a terms
 * version the owner or legal named.
 */
type Env = Readonly<Record<string, string | undefined>>;

/** `terms_version` column bound (pending_signups, user_consents). */
const TERMS_VERSION_MAX = 64;

/** A signup link, and so a pending row, lives 24 hours (design D5; `expires_at`). */
export const SIGNUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * After a signup COMPLETES, a new `requestSignup` for the same email sends no link
 * for this long (owner decision 2026-11-13, option B): a lost 201 must not turn into
 * a second tenant. The owner signs in instead. Still a silent 202.
 */
export const SIGNUP_RECENT_COMPLETION_MS = 24 * 60 * 60 * 1000;

/** The current terms version, or null when it is not configured (or cannot be stored). */
export function readCurrentTermsVersion(env: Env = process.env): string | null {
  const value = (env["SIGNUP_CURRENT_TERMS_VERSION"] ?? "").trim();
  return value.length >= 1 && value.length <= TERMS_VERSION_MAX ? value : null;
}
