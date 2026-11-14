/**
 * signups.service.request.unit.spec.ts — RT-1350 slice 3: `requestSignup` (design v6 D1-A
 * fallback, D3, D5, D6; contract `signups.openapi.yaml`). Docker-free: the store, the
 * limiter, the human-proof verifier, the email producer and the audit enqueuer are fakes.
 * The SQL itself is pinned in test/signups/signups.repository.integration.spec.ts.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import { SignupsService } from "../../src/signups/signups.service";
import { accountIdentifier } from "../../src/auth/public-auth-keys";
import { makeService, REQUEST, CTX } from "./signups.fakes";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

let h: ReturnType<typeof makeService>;
let service: SignupsService;

beforeEach(() => {
  h = makeService();
  service = h.service;
});

describe("requestSignup: refusals before anything is recorded", () => {
  it("is unavailable (503) when the terms version is not configured, and touches nothing", async () => {
    h = makeService({ env: {} });
    expect(await h.service.requestSignup(REQUEST, CTX)).toBe("unavailable");
    expect(h.humanProof.calls).toHaveLength(0);
    expect(h.store.calls).toEqual([]);
  });

  it("is the generic invalid (400) for a non-current terms version, without spending a human-proof check", async () => {
    expect(await service.requestSignup({ ...REQUEST, termsVersion: "1999-01" }, CTX)).toBe("invalid");
    expect(h.humanProof.calls).toHaveLength(0);
    expect(h.store.calls).toEqual([]);
  });

  it("is invalid for a refused human proof and unavailable when the verifier is unavailable; nothing recorded", async () => {
    h.humanProof.next = { kind: "refused" };
    expect(await service.requestSignup(REQUEST, CTX)).toBe("invalid");
    h.humanProof.next = { kind: "unavailable" };
    expect(await service.requestSignup(REQUEST, CTX)).toBe("unavailable");
    await service.settleWork();
    expect(h.store.calls).toEqual([]);
    expect(h.emails.sent).toEqual([]);
  });

  it("passes the token and the caller address to the verifier", async () => {
    await service.requestSignup(REQUEST, CTX);
    expect(h.humanProof.calls).toEqual([{ token: REQUEST.humanProof, remoteIp: CTX.ip }]);
  });
});

describe("requestSignup: an eligible address", () => {
  it("answers accepted, then expires older pending rows and inserts the new one in ONE platform-admin transaction", async () => {
    expect(await service.requestSignup(REQUEST, CTX)).toBe("accepted");
    await service.settleWork();

    expect(h.txContexts).toEqual([{ tenantId: null, privilege: "signup" }]);
    const order = h.store.calls.filter((c) => ["expirePendingByEmail", "insertPending"].includes(c));
    expect(order).toEqual(["expirePendingByEmail", "insertPending"]);
  });

  it("stores only the HASH of the token and e-mails the raw token with the locale", async () => {
    await service.requestSignup(REQUEST, CTX);
    await service.settleWork();

    const inserted = h.store.inserted[0]!;
    const sent = h.emails.sent[0]!;
    expect(sent.email).toBe("owner@example.com");
    expect(sent.locale).toBe("ar");
    expect(sent.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserted.tokenHash).toBe(sha256Hex(sent.rawToken));
    expect(inserted.tokenHash).not.toContain(sent.rawToken);
  });

  it("records the consent columns, a hashed IP, a 24 h expiry and the normalized email", async () => {
    await service.requestSignup(REQUEST, CTX);
    await service.settleWork();

    const row = h.store.inserted[0]!;
    expect(row.emailNormalized).toBe("owner@example.com");
    expect(row.name).toBe("Mona Hassan");
    expect(row.businessName).toBe("Hassan Market");
    expect(row.termsVersion).toBe("2026-11");
    expect(row.termsAcceptedAt).toEqual(h.clock.now());
    expect(row.expiresAt.getTime() - h.clock.now().getTime()).toBe(24 * 60 * 60 * 1000);
    expect(row.ipHash).not.toContain(CTX.ip);
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns before the eligibility work has finished (the 202 does the same work for every address)", async () => {
    h.store.gate = new Promise<void>(() => undefined);
    const outcome = await Promise.race([service.requestSignup(REQUEST, CTX), new Promise((r) => setTimeout(() => r("hung"), 200))]);
    expect(outcome).toBe("accepted");
  });

  it("sends a fresh link to an address that has a still-pending signup (the old row is superseded)", async () => {
    h.store.existingPending = true;
    await service.requestSignup(REQUEST, CTX);
    await service.settleWork();
    expect(h.emails.sent).toHaveLength(1);
    expect(h.store.calls).toContain("expirePendingByEmail");
  });

  it("sends a link to an address that already belongs to an active user (same shape; completion decides)", async () => {
    h.store.user = { id: "u-1", isPlatformAdmin: false, blocked: false };
    await service.requestSignup(REQUEST, CTX);
    await service.settleWork();
    expect(h.emails.sent).toHaveLength(1);
  });

  it("audits signup.requested with a keyed hash of the email, never the address", async () => {
    await service.requestSignup(REQUEST, { ...CTX, requestId: "req-9" });
    await service.settleWork();

    const audit = h.audit.events.find((e) => e.action === "signup.requested")!;
    expect(audit.request_id).toBe("req-9");
    expect(audit.tenant_id).toBeNull();
    expect(JSON.stringify(audit)).not.toContain("owner@example.com");
    expect(audit.metadata).toEqual({ email_hash: accountIdentifier("owner@example.com") });
  });
});

describe("requestSignup: silent ineligible cases (always accepted, nothing sent, nothing recorded)", () => {
  async function expectSilent(): Promise<void> {
    expect(await service.requestSignup(REQUEST, CTX)).toBe("accepted");
    await service.settleWork();
    expect(h.emails.sent).toEqual([]);
    expect(h.store.inserted).toEqual([]);
  }

  it("a disposable-domain address", async () => {
    expect(await service.requestSignup({ ...REQUEST, email: "x@mailinator.com" }, CTX)).toBe("accepted");
    await service.settleWork();
    expect(h.emails.sent).toEqual([]);
    expect(h.store.inserted).toEqual([]);
  });

  it("an address over its per-email budget", async () => {
    h.limiter.blocked.add("signup_create_email");
    await expectSilent();
  });

  it("a per-email limiter outage (fail silent for the address; the per-IP check already failed closed)", async () => {
    h.limiter.broken = true;
    await expectSilent();
  });

  it("a soft-deleted or disabled user", async () => {
    h.store.user = { id: "u-1", isPlatformAdmin: false, blocked: true };
    await expectSilent();
  });

  it("a user whose identity link was disabled", async () => {
    h = makeService({ linkState: () => Promise.resolve("disabled") });
    service = h.service;
    h.store.user = { id: "u-1", isPlatformAdmin: false, blocked: false };
    await expectSilent();
  });

  it("a platform admin's address (a platform account is never signed in by an email token)", async () => {
    h.store.user = { id: "u-1", isPlatformAdmin: true, blocked: false };
    await expectSilent();
  });

  it("an address that completed a signup in the last 24 h (owner decision B: a lost 201 must not become a second tenant)", async () => {
    h.store.recentCompletion = true;
    await expectSilent();
    expect(h.store.recentCompletionSince?.getTime()).toBe(h.clock.now().getTime() - 24 * 60 * 60 * 1000);
  });
});

describe("requestSignup: failures after the 202 never reach the caller", () => {
  it("a concurrent request that won the pending slot (23505) sends nothing and does not throw", async () => {
    h.store.insertError = Object.assign(new Error("dup"), { code: "23505" });
    expect(await service.requestSignup(REQUEST, CTX)).toBe("accepted");
    await expect(service.settleWork()).resolves.toBeUndefined();
    expect(h.emails.sent).toEqual([]);
  });

  it("a store failure is logged by class and swallowed", async () => {
    h.store.insertError = new Error("db down");
    expect(await service.requestSignup(REQUEST, CTX)).toBe("accepted");
    await expect(service.settleWork()).resolves.toBeUndefined();
    expect(h.emails.sent).toEqual([]);
  });

  it("an email-queue failure is swallowed (the row stays pending; a later request rotates the link)", async () => {
    h.emails.fail = true;
    expect(await service.requestSignup(REQUEST, CTX)).toBe("accepted");
    await expect(service.settleWork()).resolves.toBeUndefined();
  });

  it("drainWork gives up after the timeout and reports how many items were left", async () => {
    h.store.gate = new Promise<void>(() => undefined);
    await service.requestSignup(REQUEST, CTX);
    expect(await service.drainWork(20)).toBe(1);
  });
});
