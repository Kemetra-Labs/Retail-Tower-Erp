/**
 * Disposable-domain check for self-signup (RT-1350 slice 3, design D5). The list is
 * `disposable-domains.list.ts` (owner-reviewed PRs) plus `SIGNUP_DISPOSABLE_DOMAINS_EXTRA`.
 */
import { BUNDLED_DISPOSABLE_DOMAINS } from "./disposable-domains.list";

type Env = Readonly<Record<string, string | undefined>>;

const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Parse the comma-separated extras: trimmed, lower-cased; blanks and malformed entries dropped. */
export function parseExtraDisposableDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => DOMAIN_SHAPE.test(entry));
}

/** True when the address's domain is, or is a subdomain of, a listed disposable domain. */
export function isDisposableEmail(email: string, env: Env = process.env): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0) return false;
  const listed = [...BUNDLED_DISPOSABLE_DOMAINS, ...parseExtraDisposableDomains(env["SIGNUP_DISPOSABLE_DOMAINS_EXTRA"])];
  return listed.some((d) => domain === d || domain.endsWith(`.${d}`));
}
