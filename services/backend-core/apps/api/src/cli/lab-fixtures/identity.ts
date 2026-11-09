/**
 * Deterministic fixture identities — RT-1309.
 *
 * Index N always maps to the same provider loginId, Backend-Core email and
 * display name, so a re-run finds what an earlier run created.
 */
import {
  FIXTURE_DISPLAY_PREFIX,
  FIXTURE_EMAIL_DOMAIN,
  FIXTURE_LOGIN_PREFIX,
  MAX_FIXTURES,
} from "./constants";

export interface FixtureIdentity {
  readonly index: number;
  /** Provider loginId; not an email, so the provider never mails it. */
  readonly loginId: string;
  /** Backend-Core `users.email`, under the reserved `.invalid` TLD. */
  readonly email: string;
  readonly displayName: string;
}

export function fixtureIdentity(index: number): FixtureIdentity {
  if (!Number.isInteger(index) || index < 1 || index > MAX_FIXTURES) {
    throw new RangeError(`fixture index must be an integer from 1 to ${MAX_FIXTURES}`);
  }
  const suffix = String(index).padStart(3, "0");
  const loginId = `${FIXTURE_LOGIN_PREFIX}${suffix}`;
  return {
    index,
    loginId,
    email: `${loginId}@${FIXTURE_EMAIL_DOMAIN}`,
    displayName: `${FIXTURE_DISPLAY_PREFIX}${suffix}`,
  };
}

/** Indexes 1..count. */
export function fixtureIdentities(count: number): FixtureIdentity[] {
  return Array.from({ length: count }, (_, i) => fixtureIdentity(i + 1));
}
