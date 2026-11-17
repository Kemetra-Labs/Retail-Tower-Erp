/**
 * RT-1439 — the Lua scripts behind the window-aware refund and the re-authentication grant, run on a
 * REAL Redis (the in-process `TestRedis` cannot run Lua).
 *
 * OPT-IN: the repo's Jest CI has no Redis service, so this spec runs only when `REDIS_TEST_URL` is set,
 * for example:
 *
 *   docker run -d --name rl-test -p 6399:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://localhost:6399 npx jest test/auth/rate-limit.redis-scripts.integration.spec.ts
 *
 * What it pins (CodeRabbit review of #642): the window's identity is its end on the REDIS SERVER
 * clock, taken at reservation and compared at refund by one script on the same clock. A refund that
 * arrives late, after the window rolled and ANOTHER request started the next one, must not decrement
 * that request's hit, however long the command was delayed and whatever the application clock says.
 */
import Redis from "ioredis";

import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";
import { RateLimiter } from "../../src/auth/rate-limit";

const URL = process.env["REDIS_TEST_URL"];
const maybe = URL ? describe : describe.skip;

maybe("window-aware refund on a real Redis", () => {
  let client: Redis;
  let limiter: RateLimiter;
  const SHORT = { limit: 5, windowMs: 1_500 };
  const id = (): string => `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  beforeAll(() => {
    client = new Redis(URL as string);
    limiter = new RateLimiter(new IoredisIdempotencyAdapter(client));
  });
  afterAll(async () => {
    await client.quit();
  });

  it("returns the window end on the server clock, and refunds within the live window", async () => {
    const user = id();
    const hit = await limiter.check("rt1439", user, { limit: 5, windowMs: 60_000 });
    expect(hit.windowEndsAtMs).toBeGreaterThan(Date.now() - 5_000);
    await limiter.releaseIfSameWindow("rt1439", user, hit.windowEndsAtMs);
    expect((await limiter.check("rt1439", user, { limit: 5, windowMs: 60_000 })).count).toBe(1);
  });

  it("a late refund across a rollover does NOT decrement the other request's hit in the new window", async () => {
    const user = id();
    const a = await limiter.check("rt1439", user, SHORT); // request A, window 1
    await new Promise((r) => setTimeout(r, SHORT.windowMs + 300)); // window 1 expires while A is still verifying
    const b = await limiter.check("rt1439", user, SHORT); // request B, window 2
    expect(b.count).toBe(1);
    // A's refund arrives now. Short tolerance: the two windows end ~1.8 s apart on the server clock.
    await limiter.releaseIfSameWindow("rt1439", user, a.windowEndsAtMs, 200);
    expect((await limiter.check("rt1439", user, SHORT)).count).toBe(2); // B's hit is still counted
  });

  it("a missing key is left alone and a counter that would go below zero is deleted", async () => {
    const user = id();
    await limiter.releaseIfSameWindow("rt1439", user, Date.now() + 1_000);
    expect(await client.exists(`rl:rt1439:${user}`)).toBe(0);
    const hit = await limiter.check("rt1439", user, { limit: 5, windowMs: 60_000 });
    await limiter.release("rt1439", user); // 1 -> 0
    await limiter.releaseIfSameWindow("rt1439", user, hit.windowEndsAtMs); // 0 -> -1 -> deleted
    expect(await client.exists(`rl:rt1439:${user}`)).toBe(0);
  });

  it("the grant compare-and-delete spends exactly once", async () => {
    const adapter = new IoredisIdempotencyAdapter(client);
    const key = `reauth:grant:test-${id()}`;
    await adapter.set(key, "v1", { px: 60_000 });
    expect(await adapter.compareAndDelete(key, "other")).toBe(false);
    const wins = await Promise.all([adapter.compareAndDelete(key, "v1"), adapter.compareAndDelete(key, "v1"), adapter.compareAndDelete(key, "v1")]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
