/**
 * disposable-domains.unit.spec.ts — RT-1350 slice 3 (design D5): the disposable
 * email-domain list is a small reviewed file in the repo plus an env var for extras.
 */
import { BUNDLED_DISPOSABLE_DOMAINS } from "../../src/signups/disposable-domains.list";
import { isDisposableEmail, parseExtraDisposableDomains } from "../../src/signups/disposable-domains";

describe("bundled list", () => {
  it("holds lower-case bare domains only, with no duplicates", () => {
    for (const d of BUNDLED_DISPOSABLE_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
      expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    expect(new Set(BUNDLED_DISPOSABLE_DOMAINS).size).toBe(BUNDLED_DISPOSABLE_DOMAINS.length);
  });
});

describe("isDisposableEmail", () => {
  it("is true for a bundled domain and for a subdomain of one", () => {
    expect(isDisposableEmail("x@mailinator.com", {})).toBe(true);
    expect(isDisposableEmail("x@inbox.mailinator.com", {})).toBe(true);
  });

  it("is false for an ordinary domain and for a look-alike suffix", () => {
    expect(isDisposableEmail("x@gmail.com", {})).toBe(false);
    expect(isDisposableEmail("x@notmailinator.com", {})).toBe(false);
  });

  it("matches the domain after the LAST @ and ignores case", () => {
    expect(isDisposableEmail("a@b@MAILINATOR.com", {})).toBe(true);
  });

  it("includes extras from SIGNUP_DISPOSABLE_DOMAINS_EXTRA", () => {
    const env = { SIGNUP_DISPOSABLE_DOMAINS_EXTRA: " Burner.example , other.test " };
    expect(isDisposableEmail("x@burner.example", env)).toBe(true);
    expect(isDisposableEmail("x@sub.other.test", env)).toBe(true);
    expect(isDisposableEmail("x@fine.example", env)).toBe(false);
  });

  it("is false for an address with no domain", () => {
    expect(isDisposableEmail("nodomain", {})).toBe(false);
  });
});

describe("parseExtraDisposableDomains", () => {
  it("splits on commas, trims, lower-cases and drops blanks and malformed entries", () => {
    expect(parseExtraDisposableDomains(" A.com,,b.org , not a domain,@c.net ")).toEqual(["a.com", "b.org"]);
  });

  it("is empty when unset", () => {
    expect(parseExtraDisposableDomains(undefined)).toEqual([]);
  });
});
