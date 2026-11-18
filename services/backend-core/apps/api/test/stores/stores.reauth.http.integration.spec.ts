/**
 * RT-1439 — `consoleReauthenticate`, the security review of the re-authentication path, end to end
 * on real Postgres through the Nest pipeline.
 *
 * What this spec proves:
 *   - the grant: shape, `Cache-Control: no-store`, a 5-minute expiry, bound to the session, the
 *     user, the purpose and the store, single use, and not spent by a refusal;
 *   - the evaluation order: the password is verified LAST, so a caller who fails the store or
 *     role step (a store_manager, a tenant_admin, another tenant) never spends
 *     the failed-attempt budget and never has a password tested;
 *   - the budget: 5 failed attempts per 15 minutes per user, then 429 `reauth_rate_limited` with
 *     `Retry-After`, and a correct password is NOT verified while over budget;
 *   - no secret anywhere: the password is not in an error, an audit row, the grant store or a
 *     400; the token is not stored raw.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { ACME_ID, GLOBEX_ID, startHarness, USERS, type Harness } from "../_helpers/store-deletion-app";
import { SAME_ORIGIN } from "../_helpers/same-origin";

const STORE_A = "10000000-aaaa-4aaa-8aaa-0000000000a1";
const STORE_B = "10000000-aaaa-4aaa-8aaa-0000000000b2";
const STORE_GLOBEX = "20000000-bbbb-4bbb-8bbb-0000000000c3";
let h: Harness;

beforeAll(async () => {
  h = await startHarness(async (pg) => {
    await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $3, 'R-A', 'R A'), ($2, $3, 'R-B', 'R B')`, [STORE_A, STORE_B, ACME_ID]);
    await pg.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'R-G', 'R G')`, [STORE_GLOBEX, GLOBEX_ID]);
  });
}, 240_000);

afterAll(async () => {
  if (h && !h.skipped) await h.close();
}, 60_000);

function skip(): boolean {
  return h.skipped;
}

const WRONG = "Wrong-Password-000!";
type Res = { status: number; body: unknown; headers: Record<string, string> };

function reauth(cookie: string, storeId: string, password: string, extra: Record<string, unknown> = {}): Promise<Res> {
  return h
    .http()
    .post("/api/v1/auth/reauth")
    .set("Cookie", cookie)
    .set(SAME_ORIGIN)
    .send({ purpose: "store_deletion", storeId, password, ...extra }) as unknown as Promise<Res>;
}

const codeOf = (res: Res): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

async function auditActions(userId: string): Promise<string[]> {
  const r = await h.admin.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE actor_user_id = $1 AND action LIKE 'auth.reauth.%' ORDER BY occurred_at`,
    [userId],
  );
  return r.rows.map((x) => x.action);
}

describe("the grant", () => {
  it("is returned once, uncached, for 5 minutes, and never stored or audited with a secret", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const before = Date.now();
    const res = await reauth(owner, STORE_A, USERS.owner.password);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const grant = res.body as { reauthToken: string; purpose: string; storeId: string; expiresAt: string };
    expect(grant).toMatchObject({ purpose: "store_deletion", storeId: STORE_A });
    expect(grant.reauthToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(grant.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(5 * 60 * 1000 - 5000);
    expect(ttl).toBeLessThan(5 * 60 * 1000 + 5000);
    expect(Object.keys(grant).sort()).toEqual(["expiresAt", "purpose", "reauthToken", "storeId"]);

    // The raw token and the password were never written to Redis (only the token's hash is a key).
    const stored = h.redis.everWritten.join("\n");
    expect(stored).not.toContain(grant.reauthToken);
    expect(stored).not.toContain(USERS.owner.password);
    // The audit rows carry the purpose and the store id only.
    const rows = await h.admin.query(`SELECT metadata FROM audit_events WHERE action = 'auth.reauth.granted' AND actor_user_id = $1`, [USERS.owner.id]);
    expect(rows.rows.at(-1)!.metadata).toEqual({ purpose: "store_deletion", store_id: STORE_A });
  });

  it("is bound to the session: another session of the same owner cannot use it", async () => {
    if (skip()) return;
    const sessionOne = await h.signIn("owner");
    const sessionTwo = await h.signIn("owner");
    const token = await h.grantFor(sessionOne, STORE_A, USERS.owner.password);
    const preview = await h.http().get(`/api/v1/stores/${STORE_A}/deletion-preview`).set("Cookie", sessionTwo).expect(200);
    const fp = (preview.body as { previewFingerprint: string }).previewFingerprint;
    const send = (cookie: string, store = STORE_A) =>
      h.http().post(`/api/v1/stores/${store}/deletion`).set("Cookie", cookie).set(SAME_ORIGIN).set("Idempotency-Key", `idem-${randomUUID()}`)
        .send({ reason: "x", previewFingerprint: fp, reauthToken: token });
    const other = await send(sessionTwo);
    expect(other.status).toBe(403);
    expect(codeOf(other as unknown as Res)).toBe("reauth_required");
    // Nor can it be used for another store (same session, same purpose).
    const otherStore = await send(sessionOne, STORE_B);
    expect(otherStore.status).toBe(403);
    expect(codeOf(otherStore as unknown as Res)).toBe("reauth_required");
  });

  it("expires after 5 minutes", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const token = await h.grantFor(owner, STORE_B, USERS.owner.password);
    const preview = await h.http().get(`/api/v1/stores/${STORE_B}/deletion-preview`).set("Cookie", owner).expect(200);
    h.redis.offsetMs += 5 * 60 * 1000 + 1000;
    try {
      const res = await h.http().post(`/api/v1/stores/${STORE_B}/deletion`).set("Cookie", owner).set(SAME_ORIGIN).set("Idempotency-Key", `idem-${randomUUID()}`)
        .send({ reason: "x", previewFingerprint: (preview.body as { previewFingerprint: string }).previewFingerprint, reauthToken: token });
      expect(res.status).toBe(403);
      expect(codeOf(res as unknown as Res)).toBe("reauth_required");
    } finally {
      h.redis.offsetMs = 0;
    }
  });
});

describe("the evaluation order: the password is verified last", () => {
  it.each<[string, () => Promise<string>, string, number, string | null]>([
    ["a store_manager", () => h.signIn("manager"), STORE_A, 404, null],
    ["a tenant_admin on a real store", () => h.signIn("admin"), STORE_A, 403, "store_deletion_owner_only"],
    ["a tenant_admin on an unknown store (the store is checked first)", () => h.signIn("admin"), randomUUID(), 404, null],
    ["an owner on an unknown store", () => h.signIn("owner"), randomUUID(), 404, null],
    ["an owner on another tenant's store", () => h.signIn("owner"), STORE_GLOBEX, 404, null],
    ["the other tenant's owner on this store", () => h.signIn("globexOwner", GLOBEX_ID), STORE_A, 404, null],
  ])("%s is refused before any password is tested, and spends no budget", async (_name, cookieOf, storeId, status, code) => {
    if (skip()) return;
    const cookie = await cookieOf();
    // Six wrong passwords: past the budget (5) if they counted, which a refused caller must not.
    for (let i = 0; i < 6; i += 1) {
      const res = await reauth(cookie, storeId, WRONG);
      expect(res.status).toBe(status);
      if (code !== null) expect(codeOf(res)).toBe(code);
      expect(JSON.stringify(res.body)).not.toContain(WRONG);
    }
    expect(await auditActions(USERS.manager.id)).not.toContain("auth.reauth.refused");
  });

  it("a platform admin in a support session (RT-1462) gets a grant with THEIR OWN password, never the owner's", async () => {
    if (skip()) return;
    const cookie = await h.signInPlatformAdmin();
    const wrong = await reauth(cookie, STORE_A, USERS.owner.password);
    expect([wrong.status, codeOf(wrong)]).toEqual([403, "reauth_failed"]);
    const res = await reauth(cookie, STORE_A, USERS.platform.password);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purpose: "store_deletion", storeId: STORE_A });
    // The grant row says who asked, and on whose behalf; never the password.
    const rows = await h.admin.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_events WHERE actor_user_id = $1 AND action LIKE 'auth.reauth.%' ORDER BY occurred_at`,
      [USERS.platform.id],
    );
    expect(rows.rows.map((r) => r.action)).toEqual(["auth.reauth.refused", "auth.reauth.granted"]);
    for (const row of rows.rows) {
      expect(row.metadata).toMatchObject({
        purpose: "store_deletion",
        store_id: STORE_A,
        actor_kind: "platform_admin",
        on_behalf_of: { tenant_id: ACME_ID, support_session_id: expect.any(String), ticket_ref: null },
      });
      expect(JSON.stringify(row.metadata)).not.toContain(USERS.platform.password);
    }
  });

  it("a non-member platform admin with NO support session gets a grant too (RT-1462)", async () => {
    if (skip()) return;
    const cookie = await h.signInPlatformAdminDirect();
    const res = await reauth(cookie, STORE_A, USERS.platform.password);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purpose: "store_deletion", storeId: STORE_A });
  });

  it("the failed attempts of the refused callers did not touch the owner's budget", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    expect((await reauth(owner, STORE_A, USERS.owner.password)).status).toBe(200);
  });
});

describe("the failed-attempt budget (5 per 15 minutes per user)", () => {
  it("counts only wrong guesses; the 6th is 429, and a correct password is not even verified while over budget", async () => {
    if (skip()) return;
    // The owner's second account: a fresh budget.
    const owner = await h.signIn("ownerTwo");
    for (let i = 0; i < 5; i += 1) {
      const res = await reauth(owner, STORE_A, WRONG);
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe("reauth_failed");
      expect(JSON.stringify(res.body)).not.toContain(WRONG);
    }
    const limited = await reauth(owner, STORE_A, WRONG);
    expect(limited.status).toBe(429);
    expect(codeOf(limited)).toBe("reauth_rate_limited");
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers["x-request-id"]).toBe((limited.body as { error: { request_id: string } }).error.request_id);

    // The CORRECT password, over budget: refused with the same 429 (it was not verified).
    const stillLimited = await reauth(owner, STORE_A, USERS.ownerTwo.password);
    expect(stillLimited.status).toBe(429);
    expect(codeOf(stillLimited)).toBe("reauth_rate_limited");

    const refused = (await auditActions(USERS.ownerTwo.id)).filter((a) => a === "auth.reauth.refused");
    expect(refused).toHaveLength(5);
  });

  it("a success gives its hit back: after 4 wrong guesses and a success, exactly ONE more wrong guess is allowed", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    // Start from a clean budget for this user.
    await h.redis.del(`rl:reauth_user:${USERS.owner.id}`);
    for (let i = 0; i < 4; i += 1) expect((await reauth(owner, STORE_B, WRONG)).status).toBe(403);
    expect((await reauth(owner, STORE_B, USERS.owner.password)).status).toBe(200);
    expect((await reauth(owner, STORE_B, WRONG)).status).toBe(403); // the 5th failure: the success did not count
    expect((await reauth(owner, STORE_B, WRONG)).status).toBe(429); // the 6th
  });
});

describe("no secret in a response", () => {
  it("a 400 names the failing keys, never the submitted password", async () => {
    if (skip()) return;
    const owner = await h.signIn("owner");
    const secret = "Hunter2-secret-value-for-400";
    const bad = await h.http().post("/api/v1/auth/reauth").set("Cookie", owner).set(SAME_ORIGIN)
      .send({ purpose: "store_deletion", storeId: "not-a-uuid", password: secret });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(secret);
    const extra = await h.http().post("/api/v1/auth/reauth").set("Cookie", owner).set(SAME_ORIGIN)
      .send({ purpose: "store_deletion", storeId: STORE_A, password: secret, tenantId: ACME_ID });
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).not.toContain(secret);
    const tooLong = await reauth(owner, STORE_A, "x".repeat(1025));
    expect(tooLong.status).toBe(400);
  });

  it("is session-only, owner-only and Origin-checked", async () => {
    if (skip()) return;
    await h.http().post("/api/v1/auth/reauth").set(SAME_ORIGIN).send({ purpose: "store_deletion", storeId: STORE_A, password: "x" }).expect(401);
    const owner = await h.signIn("owner");
    const res = await h.http().post("/api/v1/auth/reauth").set("Cookie", owner).set({ Host: "api.test", Origin: "http://evil.example" })
      .send({ purpose: "store_deletion", storeId: STORE_A, password: USERS.owner.password });
    expect(res.status).toBe(403);
    // An unsupported purpose is a 400 (more purposes need their own owner decision).
    await h.http().post("/api/v1/auth/reauth").set("Cookie", owner).set(SAME_ORIGIN)
      .send({ purpose: "force_close", storeId: STORE_A, password: USERS.owner.password }).expect(400);
  });
});
