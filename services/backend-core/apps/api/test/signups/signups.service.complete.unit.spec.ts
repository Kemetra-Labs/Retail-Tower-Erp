/**
 * signups.service.complete.unit.spec.ts — RT-1350 slice 3: `completeSignup` (design v6 D1-A
 * fallback, D2, D3; contract `signups.openapi.yaml`; owner/coordinator decisions of
 * 2026-11-13 on RT-1350). Docker-free: fakes for the store and the provider.
 * Atomicity and the real SQL are pinned in signups.repository.integration.spec.ts.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import type { PendingSignupRecord } from "../../src/signups/signups.store";
import { CTX, makeService, NOW, type Harness } from "./signups.fakes";

const TOKEN = "raw-signup-token-0123456789012345678901234";
const PASSWORD = "Correct-Horse-Battery-9!";
const BODY = { token: TOKEN, password: PASSWORD };

function hashOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function pending(over: Partial<PendingSignupRecord> = {}): PendingSignupRecord {
  return {
    id: "p-1",
    emailNormalized: "owner@example.com",
    name: "Mona Hassan",
    businessName: "Hassan Market",
    locale: "ar",
    termsVersion: "2026-11",
    termsAcceptedAt: new Date(NOW.getTime() - 60_000),
    ipHash: "a".repeat(64),
    status: "pending",
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    ...over,
  };
}

let h: Harness;

beforeEach(() => {
  h = makeService();
  h.store.pendingByTokenHash.set(hashOf(TOKEN), pending());
});

function writes(): string[] {
  return h.store.calls.filter((c) =>
    ["insertUser", "insertIdentityLink", "createRestrictedTenant", "insertConsent", "markCompleted"].includes(c),
  );
}

describe("completeSignup: refusals (the same generic invalid; nothing created)", () => {
  it.each([
    ["an unknown token", () => h.store.pendingByTokenHash.clear()],
    ["an already completed signup", () => h.store.pendingByTokenHash.set(hashOf(TOKEN), pending({ status: "completed" }))],
    ["an expired status", () => h.store.pendingByTokenHash.set(hashOf(TOKEN), pending({ status: "expired" }))],
    ["a pending row past its expiry", () => h.store.pendingByTokenHash.set(hashOf(TOKEN), pending({ expiresAt: NOW }))],
  ])("%s", async (_label, arrange) => {
    arrange();
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(h.external.calls).toEqual([]);
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it("looks the token up only by its hash", async () => {
    await h.service.completeSignup(BODY, CTX);
    expect(JSON.stringify(h.store.calls)).not.toContain(TOKEN);
  });
});

describe("completeSignup: a NEW user", () => {
  it("creates the provider user, sets the password, then writes everything in ONE tenant-pinned platform-admin transaction", async () => {
    const result = await h.service.completeSignup(BODY, CTX);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("unreachable");

    expect(h.external.calls).toEqual(["createUser:owner@example.com", "setActivePassword:owner@example.com"]);
    expect(h.external.passwordsSet).toEqual([PASSWORD]);

    // lookup tx (no tenant), then the write tx pinned to the new tenant.
    const writeCtx = h.txContexts[h.txContexts.length - 1]!;
    expect(writeCtx).toEqual({ tenantId: result.tenantId, isPlatformAdmin: true });

    expect(h.store.calls.slice(h.store.calls.indexOf("lockPending"))).toEqual([
      "lockPending",
      "insertUser",
      "insertIdentityLink",
      "createRestrictedTenant",
      "insertConsent",
      "markCompleted",
      "insertAudit:signup.completed",
      "insertAudit:tenant.self_service_created",
    ]);
  });

  it("writes the user, the link to the provider subject, the owner tenant, the consent and the completion", async () => {
    const result = await h.service.completeSignup(BODY, CTX);
    if (result.kind !== "created") throw new Error("expected created");

    const user = h.store.users[0]!;
    expect(user).toMatchObject({ email: "owner@example.com", displayName: "Mona Hassan" });
    expect(h.store.links).toEqual([expect.objectContaining({ subject: "prov-1", userId: user.id })]);
    expect(h.store.tenants[0]).toMatchObject({
      tenantId: result.tenantId,
      name: "Hassan Market",
      ownerUserId: user.id,
    });
    expect(h.store.tenants[0]!.slug).toMatch(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/);
    expect(h.store.consents).toEqual([expect.objectContaining({ userId: user.id, termsVersion: "2026-11", pendingSignupId: "p-1" })]);
    expect(h.store.completed).toEqual([{ id: "p-1", tenantId: result.tenantId }]);
  });

  it("starts a session for the new user AFTER the transaction", async () => {
    const result = await h.service.completeSignup(BODY, CTX);
    if (result.kind !== "created") throw new Error("expected created");
    expect(h.sessions.started).toEqual([h.store.users[0]!.id]);
    expect(result.session).toMatchObject({ sessionCredential: "cookie-1" });
  });

  it("audit rows carry ids and source labels only: no token, no password, no email", async () => {
    await h.service.completeSignup({ ...BODY, token: TOKEN }, { ...CTX, requestId: "req-3" });
    const json = JSON.stringify(h.store.audits);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain("owner@example.com");
    expect(h.store.audits.every((a) => a.requestId === "req-3")).toBe(true);
  });

  it("a provider user that exists WITHOUT a password gets the password set (a half-done earlier attempt)", async () => {
    h.external.create = { kind: "rejected" };
    h.external.load = { kind: "found", userId: "prov-9", passwordSet: false };
    const result = await h.service.completeSignup(BODY, CTX);
    expect(result.kind).toBe("created");
    expect(h.external.calls).toEqual(["createUser:owner@example.com", "loadUser:owner@example.com", "setActivePassword:owner@example.com"]);
    expect(h.store.links[0]?.subject).toBe("prov-9");
  });

  it("a provider user that exists WITH a password is adopted on the email proof and its password is NEVER overwritten", async () => {
    h.external.create = { kind: "rejected" };
    h.external.load = { kind: "found", userId: "prov-9", passwordSet: true };
    const result = await h.service.completeSignup(BODY, CTX);
    expect(result.kind).toBe("created");
    expect(h.external.passwordsSet).toEqual([]);
    expect(h.store.links[0]?.subject).toBe("prov-9");
    expect(h.sessions.started).toHaveLength(1);
  });

  it("is invalid when the provider cannot create the user and cannot find it either", async () => {
    h.external.create = { kind: "rejected" };
    h.external.load = { kind: "not_found" };
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(writes()).toEqual([]);
  });

  it("is invalid (no writes, no session) when the provider rejects the password", async () => {
    h.external.setPassword = { kind: "rejected" };
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(h.store.calls).not.toContain("lockPending");
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it.each([
    ["createUser unavailable", (): void => void (h.external.create = { kind: "unavailable" })],
    ["createUser unconfigured", (): void => void (h.external.create = { kind: "unconfigured" })],
    ["setActivePassword unavailable", (): void => void (h.external.setPassword = { kind: "unavailable" })],
    ["loadUser unavailable", (): void => {
      h.external.create = { kind: "rejected" };
      h.external.load = { kind: "unavailable" };
    }],
  ])("is unavailable (503), never an invalid-token 400, when %s", async (_label, arrange) => {
    arrange();
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "unavailable" });
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it("is unavailable when no identity provider is wired", async () => {
    h = makeService({ external: null });
    h.store.pendingByTokenHash.set(hashOf(TOKEN), pending());
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "unavailable" });
  });
});

describe("completeSignup: an EXISTING Backend-Core user", () => {
  beforeEach(() => {
    h.store.user = { id: "u-existing", isPlatformAdmin: false, blocked: false };
  });

  it("never touches the provider and never applies the submitted password; adds the tenant to that user", async () => {
    const result = await h.service.completeSignup(BODY, CTX);
    if (result.kind !== "created") throw new Error("expected created");

    expect(h.external.calls).toEqual([]);
    expect(h.external.passwordsSet).toEqual([]);
    expect(h.store.calls).not.toContain("insertUser");
    expect(h.store.calls).not.toContain("insertIdentityLink");
    expect(h.store.tenants[0]).toMatchObject({ ownerUserId: "u-existing", tenantId: result.tenantId });
    expect(h.store.consents[0]?.userId).toBe("u-existing");
  });

  it("issues the session for that user per the contract, and audits the existing-user completion", async () => {
    await h.service.completeSignup(BODY, CTX);
    expect(h.sessions.started).toEqual(["u-existing"]);
    const actions = h.store.audits.map((a) => a.action);
    expect(actions).toEqual(["signup.completed", "tenant.self_service_created", "signup.existing_user_completed"]);
    expect(h.store.audits.find((a) => a.action === "signup.existing_user_completed")).toMatchObject({
      actorUserId: "u-existing",
      targetId: "u-existing",
    });
  });

  it("a platform admin is the generic invalid: no tenant, no session, no provider call; the refusal is audited", async () => {
    h.store.user = { id: "u-admin", isPlatformAdmin: true, blocked: false };
    expect(await h.service.completeSignup(BODY, { ...CTX, requestId: "req-1" })).toEqual({ kind: "invalid" });

    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
    expect(h.external.calls).toEqual([]);
    expect(h.audit.events).toEqual([
      expect.objectContaining({
        action: "signup.completion_refused",
        actor_user_id: "u-admin",
        request_id: "req-1",
        metadata: { reason: "platform_admin" },
      }),
    ]);
  });

  it("a user whose identity link was disabled is the generic invalid: no tenant, no session", async () => {
    h = makeService({ linkState: () => Promise.resolve("disabled") });
    h.store.pendingByTokenHash.set(hashOf(TOKEN), pending());
    h.store.user = { id: "u-off", isPlatformAdmin: false, blocked: false };
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it("an account disabled between the first check and the row lock is refused by the re-check under the lock (no tenant, no session)", async () => {
    let reads = 0;
    h = makeService({ linkState: () => Promise.resolve(++reads === 1 ? "active" : "disabled") });
    h.store.pendingByTokenHash.set(hashOf(TOKEN), pending());
    h.store.user = { id: "u-flip", isPlatformAdmin: false, blocked: false };
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it("a soft-deleted user is the generic invalid, with no tenant and no session", async () => {
    h.store.user = { id: "u-gone", isPlatformAdmin: false, blocked: true };
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });
});

describe("completeSignup: at most once per pending signup", () => {
  it("a second complete with the same token is the generic invalid and creates no second tenant", async () => {
    expect((await h.service.completeSignup(BODY, CTX)).kind).toBe("created");
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(h.store.tenants).toHaveLength(1);
    expect(h.sessions.started).toHaveLength(1);
  });

  it("a concurrent winner (the locked row is no longer pending) loses with the generic invalid and writes nothing", async () => {
    h.store.lockStatus = "completed";
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(writes()).toEqual([]);
    expect(h.sessions.started).toEqual([]);
  });

  it("a row that vanished before the lock is the generic invalid", async () => {
    h.store.lockStatus = "missing";
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(h.sessions.started).toEqual([]);
  });
});

describe("completeSignup: failures", () => {
  it("a store failure inside the transaction propagates (the transaction rolls back) and no session is started", async () => {
    h.store.tenantError = new Error("insert failed");
    await expect(h.service.completeSignup(BODY, CTX)).rejects.toThrow("insert failed");
    expect(h.sessions.started).toEqual([]);
  });

  it("a duplicate user or link (SQLSTATE 23505) is the generic invalid, not a 500", async () => {
    h.store.tenantError = Object.assign(new Error("dup"), { code: "23505" });
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "invalid" });
    expect(h.sessions.started).toEqual([]);
  });

  it("a session failure AFTER the commit is unavailable (503): the tenant exists and the owner can sign in", async () => {
    h.sessions.fail = true;
    expect(await h.service.completeSignup(BODY, CTX)).toEqual({ kind: "unavailable" });
    expect(h.store.tenants).toHaveLength(1);
  });
});
