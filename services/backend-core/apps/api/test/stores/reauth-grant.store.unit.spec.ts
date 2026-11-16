/**
 * RT-1439 — the re-authentication grant store: opaque, single use, bound to the session, user,
 * tenant, purpose and store, and kept only as the SHA-256 of the token.
 */
import { REAUTH_GRANT_TTL_MS, ReauthGrantStore, type ReauthBinding } from "../../src/stores/deletion/reauth-grant.store";
import { TestRedis } from "../_helpers/store-deletion-app";

const BINDING: ReauthBinding = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  storeId: "44444444-4444-4444-8444-444444444444",
  purpose: "store_deletion",
};

function build() {
  const redis = new TestRedis();
  return { redis, store: new ReauthGrantStore(redis) };
}

describe("ReauthGrantStore", () => {
  it("issues a 43-character URL-safe token that expires 5 minutes later, stored only as a hash", async () => {
    const { redis, store } = build();
    const now = new Date("2026-11-16T22:00:00Z");
    const grant = await store.issue(BINDING, now);
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(REAUTH_GRANT_TTL_MS);
    expect(REAUTH_GRANT_TTL_MS).toBe(300_000);
    expect(redis.everWritten.join("|")).not.toContain(grant.token);
    expect(redis.grantKeys()).toHaveLength(1);
  });

  it("two grants are different tokens", async () => {
    const { store } = build();
    const [a, b] = [await store.issue(BINDING), await store.issue(BINDING)];
    expect(a.token).not.toBe(b.token);
  });

  it("peek does not consume; consume is single use", async () => {
    const { store } = build();
    const { token } = await store.issue(BINDING);
    expect(await store.peek(token, BINDING)).toBe(true);
    expect(await store.peek(token, BINDING)).toBe(true);
    expect(await store.consume(token, BINDING)).toBe(true);
    expect(await store.consume(token, BINDING)).toBe(false);
    expect(await store.peek(token, BINDING)).toBe(false);
  });

  it("three concurrent consumes: exactly one wins", async () => {
    const { store } = build();
    const { token } = await store.issue(BINDING);
    const results = await Promise.all([store.consume(token, BINDING), store.consume(token, BINDING), store.consume(token, BINDING)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each<[string, Partial<ReauthBinding>]>([
    ["another session", { sessionId: "99999999-9999-4999-8999-999999999999" }],
    ["another user", { userId: "99999999-9999-4999-8999-999999999999" }],
    ["another tenant", { tenantId: "99999999-9999-4999-8999-999999999999" }],
    ["another store", { storeId: "99999999-9999-4999-8999-999999999999" }],
  ])("a token presented for %s is refused, and is NOT spent by the attempt", async (_name, over) => {
    const { store } = build();
    const { token } = await store.issue(BINDING);
    const other = { ...BINDING, ...over };
    expect(await store.peek(token, other)).toBe(false);
    expect(await store.consume(token, other)).toBe(false);
    expect(await store.consume(token, BINDING)).toBe(true); // still the owner's
  });

  it("is refused after its 5 minutes, and an unknown token is refused", async () => {
    const { redis, store } = build();
    const { token } = await store.issue(BINDING);
    expect(await store.peek("A".repeat(43), BINDING)).toBe(false);
    redis.offsetMs = REAUTH_GRANT_TTL_MS + 1;
    expect(await store.peek(token, BINDING)).toBe(false);
    expect(await store.consume(token, BINDING)).toBe(false);
  });
});
