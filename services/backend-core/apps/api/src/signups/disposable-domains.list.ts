/**
 * The bundled disposable-email domain list for self-signup (RT-1350 slice 3,
 * design D5; owner decision 2026-11-13: "Bundled file + env extras").
 *
 * OWNER-REVIEW RULE: this list changes only through a pull request that the owner
 * reviews. Do not generate it from a third-party feed in CI, and do not add a domain
 * without a reason in the PR: a wrong entry silently refuses a real customer (a
 * disposable address gets the same 202 as any other, and no link). Operators add
 * short-lived extras without a deploy through `SIGNUP_DISPOSABLE_DOMAINS_EXTRA`
 * (comma-separated), which does not replace this list.
 *
 * Format: bare lower-case registrable domains. A subdomain of a listed domain matches.
 */
export const BUNDLED_DISPOSABLE_DOMAINS: readonly string[] = [
  "10minutemail.com",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
];
