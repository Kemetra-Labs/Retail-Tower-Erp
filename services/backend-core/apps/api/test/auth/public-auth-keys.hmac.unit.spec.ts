/**
 * RT-1043 — the keyed identifiers the public-auth limiter buckets use in Redis.
 *
 * Criteria 1 and 3 at the function level: an identifier is an HMAC-SHA-256 of
 * the normalized value, so it holds no raw email or IP; the same input always
 * maps to the same identifier; different inputs, compound pairs included, never
 * collide; and the secret changes every identifier.
 */
import { createHmac } from "node:crypto";

import { PUBLIC_AUTH_KEY_SECRET_ENV } from "../../src/auth/public-auth-key-secret";
import {
  accountIdentifier,
  clientIpIdentifier,
  emailIpPairIdentifier,
} from "../../src/auth/public-auth-keys";

const HEX64 = /^[0-9a-f]{64}$/;

describe("RT-1043 keyed public-auth identifiers", () => {
  const saved = process.env[PUBLIC_AUTH_KEY_SECRET_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[PUBLIC_AUTH_KEY_SECRET_ENV];
    else process.env[PUBLIC_AUTH_KEY_SECRET_ENV] = saved;
  });

  it("each identifier is 64 lowercase hex characters", () => {
    expect(accountIdentifier("owner@example.com")).toMatch(HEX64);
    expect(clientIpIdentifier("203.0.113.5")).toMatch(HEX64);
    expect(emailIpPairIdentifier("owner@example.com", "203.0.113.5")).toMatch(HEX64);
  });

  it("holds neither the raw email nor the raw IP nor an IPv6 prefix string", () => {
    const all = [
      accountIdentifier("Owner@Example.com"),
      clientIpIdentifier("203.0.113.5"),
      clientIpIdentifier("2001:db8:1:2:aaaa::1"),
      emailIpPairIdentifier("Owner@Example.com", "2001:db8:1:2:aaaa::1"),
    ].join(" ");
    for (const raw of ["owner", "example", "203.0.113.5", "2001", "db8", "::/64", "@"]) {
      expect(all.toLowerCase()).not.toContain(raw);
    }
  });

  it("is deterministic", () => {
    expect(accountIdentifier("a@x.test")).toBe(accountIdentifier("a@x.test"));
    expect(clientIpIdentifier("203.0.113.5")).toBe(clientIpIdentifier("203.0.113.5"));
    expect(emailIpPairIdentifier("a@x.test", "203.0.113.5")).toBe(emailIpPairIdentifier("a@x.test", "203.0.113.5"));
  });

  it("hashes the NORMALIZED value: email trimmed and lowercased", () => {
    expect(accountIdentifier("  User@Example.COM ")).toBe(accountIdentifier("user@example.com"));
    expect(emailIpPairIdentifier("  User@Example.COM ", "203.0.113.5")).toBe(
      emailIpPairIdentifier("user@example.com", "203.0.113.5"),
    );
  });

  it("hashes the NORMALIZED value: RT-625 P2 IP rules (IPv6 /64, IPv4-mapped, zone id)", () => {
    expect(clientIpIdentifier("2001:db8:1:2:aaaa::1")).toBe(clientIpIdentifier("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
    expect(clientIpIdentifier("2001:db8:1:2::1")).not.toBe(clientIpIdentifier("2001:db8:1:3::1"));
    expect(clientIpIdentifier("::ffff:203.0.113.5")).toBe(clientIpIdentifier("203.0.113.5"));
    expect(clientIpIdentifier("fe80::1%eth0")).toBe(clientIpIdentifier("fe80::2"));
    expect(emailIpPairIdentifier("e@x.test", "2001:db8:1:2::9")).toBe(emailIpPairIdentifier("e@x.test", "2001:db8:1:2::1"));
    expect(emailIpPairIdentifier("e@x.test", "::ffff:203.0.113.5")).toBe(emailIpPairIdentifier("e@x.test", "203.0.113.5"));
  });

  it("a value that is not an IP is still keyed (and still never raw)", () => {
    expect(clientIpIdentifier("unknown")).toMatch(HEX64);
    expect(clientIpIdentifier("unknown")).not.toContain("unknown");
  });

  it("different inputs never collide, compound pairs included", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["a@x.test", "203.0.113.5"],
      ["a@x.test", "203.0.113.6"],
      ["b@x.test", "203.0.113.5"],
      // The raw concatenation `email:ip` of these two is identical.
      ["a", "b:c"],
      ["a:b", "c"],
      // Separator and length-prefix lookalikes.
      ["a|1", "2.3.4.5"],
      ["a", "1|2.3.4.5"],
      ["1:a", "b"],
      ["a", "1:b"],
      ["a@x.test", "2001:db8:1:2::1"],
      ["a@x.test", "2001:db8:1:3::1"],
    ];
    const ids = pairs.map(([email, ip]) => emailIpPairIdentifier(email, ip));
    expect(new Set(ids).size).toBe(pairs.length);
  });

  it("the three dimensions never collide with each other", () => {
    const value = "203.0.113.5";
    expect(new Set([accountIdentifier(value), clientIpIdentifier(value)]).size).toBe(2);
    expect(new Set([accountIdentifier("a@x.test"), emailIpPairIdentifier("a@x.test", value)]).size).toBe(2);
  });

  it("is HMAC-SHA-256 under the configured secret, over a versioned message", () => {
    const secret = "k".repeat(40);
    process.env[PUBLIC_AUTH_KEY_SECRET_ENV] = secret;
    const expected = createHmac("sha256", secret).update("v1|account|a@x.test").digest("hex");
    expect(accountIdentifier("A@x.test")).toBe(expected);
  });

  it("a different secret gives a different identifier for every dimension", () => {
    process.env[PUBLIC_AUTH_KEY_SECRET_ENV] = "1".repeat(40);
    const before = [
      accountIdentifier("a@x.test"),
      clientIpIdentifier("203.0.113.5"),
      emailIpPairIdentifier("a@x.test", "203.0.113.5"),
    ];
    process.env[PUBLIC_AUTH_KEY_SECRET_ENV] = "2".repeat(40);
    const after = [
      accountIdentifier("a@x.test"),
      clientIpIdentifier("203.0.113.5"),
      emailIpPairIdentifier("a@x.test", "203.0.113.5"),
    ];
    before.forEach((id, i) => expect(after[i]).not.toBe(id));
  });
});
