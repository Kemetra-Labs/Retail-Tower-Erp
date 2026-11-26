/**
 * RT-1439 — `RateLimiter.releaseIfSameWindow`: a hit reserved before a slow call is given back only
 * while its window is still the live one. Released after the window rolled, it would decrement a
 * DIFFERENT request's hit in the new window and let extra failures through.
 */
import { RateLimiter } from "../../src/common/rate-limit/rate-limit";
import { TestRedis } from "../_helpers/store-deletion-app";

const BUCKET = { limit: 5, windowMs: 15 * 60 * 1000 };

function build() {
  const redis = new TestRedis();
  return { redis, limiter: new RateLimiter(redis) };
}

describe("RateLimiter.releaseIfSameWindow", () => {
  it("gives the hit back while its window is live", async () => {
    const { limiter } = build();
    const first = await limiter.check("b", "u", BUCKET);
    await limiter.releaseIfSameWindow("b", "u", first.windowEndsAtMs);
    expect((await limiter.check("b", "u", BUCKET)).count).toBe(1);
  });

  it("does NOT decrement another request's hit after the window rolled", async () => {
    const { limiter } = build();
    // One clock for the limiter, the fake Redis and the service: the test moves it forward.
    const realNow = Date.now.bind(Date);
    let shift = 0;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + shift);
    const reserved = await limiter.check("b", "u", BUCKET); // request A, old window
    const windowEndsAt = reserved.windowEndsAtMs;
    shift += BUCKET.windowMs + 1_000; // the window expires while A verifies the password
    expect((await limiter.check("b", "u", BUCKET)).count).toBe(1); // request B fails in the NEW window
    await limiter.releaseIfSameWindow("b", "u", windowEndsAt); // A succeeds and refunds
    expect((await limiter.check("b", "u", BUCKET)).count).toBe(2); // B's hit is still counted
  });

  it("leaves a missing key alone", async () => {
    const { redis, limiter } = build();
    await limiter.releaseIfSameWindow("b", "never-hit", Date.now() + 1_000);
    expect(await redis.pttl("rl:b:never-hit")).toBe(-2);
  });

  it("with no window identity (a stub Redis) it releases the hit, as `release` does", async () => {
    const { limiter } = build();
    await limiter.check("b", "u", BUCKET);
    await limiter.releaseIfSameWindow("b", "u", undefined);
    expect((await limiter.check("b", "u", BUCKET)).count).toBe(1);
  });
});
