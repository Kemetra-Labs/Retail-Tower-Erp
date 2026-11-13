/**
 * signup-link.provider.unit.spec.ts — RT-1350 slice 3: the signup-link port, its fallback A
 * adapter (Backend-Core's own opaque token), and the service's use of the PORT only (a
 * fake provider, as a later Descope-sent adapter would be).
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import { OwnTokenSignupLinkProvider } from "../../src/signups/own-token-signup-link.provider";
import type { PreparedSignupLink, SignupLinkProvider, VerifyLinkResult } from "../../src/signups/signup-link.port";
import { CTX, FakeEmails, makeService, NOW, REQUEST } from "./signups.fakes";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("OwnTokenSignupLinkProvider (fallback A)", () => {
  it("prepare mints a 43 character base64url token, exposes only its SHA-256, and delivers the raw token by email", async () => {
    const emails = new FakeEmails();
    const link = new OwnTokenSignupLinkProvider(emails).prepare({ email: "o@example.com", locale: "en" });

    expect(emails.sent).toEqual([]); // nothing is sent until deliver()
    await link.deliver();

    const sent = emails.sent[0]!;
    expect(sent).toMatchObject({ email: "o@example.com", locale: "en" });
    expect(sent.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.tokenHash).toBe(sha256(sent.rawToken));
    expect(link.tokenHash).not.toContain(sent.rawToken);
  });

  it("two prepared links never share a token", () => {
    const provider = new OwnTokenSignupLinkProvider(new FakeEmails());
    expect(provider.prepare({ email: "a@b.test", locale: null }).tokenHash).not.toBe(
      provider.prepare({ email: "a@b.test", locale: null }).tokenHash,
    );
  });

  it("deliver propagates a queue failure", async () => {
    const emails = new FakeEmails();
    emails.fail = true;
    await expect(new OwnTokenSignupLinkProvider(emails).prepare({ email: "a@b.test", locale: null }).deliver()).rejects.toThrow("queue down");
  });

  it("verify is the pure hash of the presented token and reports no email", async () => {
    expect(await new OwnTokenSignupLinkProvider(new FakeEmails()).verify("some-token")).toEqual({
      kind: "ok",
      tokenHash: sha256("some-token"),
      email: null,
    });
  });
});

/** A provider that is not adapter A: the service must work through the port alone. */
class FakeLinkProvider implements SignupLinkProvider {
  delivered: string[] = [];
  verifyResult: VerifyLinkResult = { kind: "ok", tokenHash: "hash-from-provider", email: null };
  nextHash: string | null = "hash-from-provider";
  prepare(input: { email: string }): PreparedSignupLink {
    return { tokenHash: this.nextHash, deliver: () => Promise.resolve(void this.delivered.push(input.email)) };
  }
  verify(): Promise<VerifyLinkResult> {
    return Promise.resolve(this.verifyResult);
  }
}

function withFake(): { h: ReturnType<typeof makeService>; fake: FakeLinkProvider } {
  const h = makeService();
  const fake = new FakeLinkProvider();
  const deps = (h.service as unknown as { deps: { links: SignupLinkProvider } }).deps;
  (deps as { links: SignupLinkProvider }).links = fake;
  return { h, fake };
}

describe("SignupsService goes through the port only", () => {
  it("requestSignup stores the provider's hash (or NULL) and delivers only after the pending row is inserted", async () => {
    const { h, fake } = withFake();
    fake.nextHash = null; // a provider that keeps the credential itself
    await h.service.requestSignup(REQUEST, CTX);
    await h.service.settleWork();

    expect(h.store.inserted[0]!.tokenHash).toBeNull();
    expect(fake.delivered).toEqual(["owner@example.com"]);
    expect(h.emails.sent).toEqual([]); // the email producer is the adapter's business, not the service's
  });

  it("does not deliver when the address is not eligible", async () => {
    const { h, fake } = withFake();
    h.store.recentCompletion = true;
    await h.service.requestSignup(REQUEST, CTX);
    await h.service.settleWork();
    expect(fake.delivered).toEqual([]);
  });

  it("completeSignup looks the pending row up by the hash the provider's verify returned", async () => {
    const { h, fake } = withFake();
    h.store.pendingByTokenHash.set("hash-from-provider", {
      id: "p-1",
      emailNormalized: "owner@example.com",
      name: "Mona Hassan",
      businessName: "Hassan Market",
      locale: "ar",
      termsVersion: "2026-11",
      termsAcceptedAt: NOW,
      ipHash: "a".repeat(64),
      status: "pending",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    expect((await h.service.completeSignup({ token: "opaque", password: "Correct-Horse-Battery-9!" }, CTX)).kind).toBe("created");
    expect(fake.verifyResult.kind).toBe("ok");
  });

  it("a refused token is the generic invalid and an unavailable verifier is 503, with no store access", async () => {
    const { h, fake } = withFake();
    fake.verifyResult = { kind: "refused" };
    expect(await h.service.completeSignup({ token: "t", password: "p" }, CTX)).toEqual({ kind: "invalid" });
    fake.verifyResult = { kind: "unavailable" };
    expect(await h.service.completeSignup({ token: "t", password: "p" }, CTX)).toEqual({ kind: "unavailable" });
    expect(h.store.calls).toEqual([]);
  });

  it("a verify result with no token hash (an email-keyed provider) is refused until such an adapter adds its lookup", async () => {
    const { h, fake } = withFake();
    fake.verifyResult = { kind: "ok", tokenHash: null, email: "owner@example.com", providerUserId: "U1" };
    expect(await h.service.completeSignup({ token: "t", password: "p" }, CTX)).toEqual({ kind: "invalid" });
    expect(h.store.calls).toEqual([]);
  });
});
