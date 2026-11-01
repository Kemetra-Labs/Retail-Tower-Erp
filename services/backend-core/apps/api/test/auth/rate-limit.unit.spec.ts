/**
 * rate-limit.unit.spec.ts
 *
 * Docker-free unit coverage for RateLimiter.
 *
 * Strategy: jest.fn()-based mocks for the RedisLike interface.
 * No real Redis, no Testcontainers, no ioredis.
 *
 * The integration spec (rate-limit.spec.ts) covers the full fixed-window
 * logic with a VirtualClock fake. This spec pins the RateLimiter class's
 * own responsibilities using jest mocks:
 *   - RT-618: `check` is ONE port call (`incrWindow`) with the correct key
 *     (`rl:<bucketName>:<identifier>`) and the bucket's windowMs. The
 *     INCR / TTL seed / PTTL sequence lives inside that one atomic call
 *     (a Lua script in the ioredis adapter), so the old per-command
 *     assertions (INCR, then PEXPIRE NX only on the first hit, then PTTL)
 *     are replaced by single-call assertions.
 *   - resetMs maps to the returned ttlMs when ttlMs >= 0
 *   - resetMs is -1 when the port reports a negative ttlMs (a stub such as
 *     AlwaysAllowRedis; a real Redis always seeds the TTL)
 *   - allowed is true when count <= bucket.limit
 *   - allowed is false when count > bucket.limit
 *   - remaining is max(0, limit - count) — never negative
 *   - different bucket names produce different key namespaces
 */

import {
  RATE_LIMIT_BUCKETS,
  RateLimiter,
  type RedisLike,
  type RateLimitDecision,
  type WindowHit,
} from "../../src/auth/rate-limit";
import { accountKey, clientIpKey, emailIpPairKey } from "../../src/auth/public-auth-keys";

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<{
  incrResult: number;
  pttlResult: number;
}> = {}): jest.Mocked<RedisLike> {
  return {
    incrWindow: jest
      .fn<Promise<WindowHit>, [string, number]>()
      .mockResolvedValue({ count: overrides.incrResult ?? 1, ttlMs: overrides.pttlResult ?? 900_000 }),
    pttl: jest.fn<Promise<number>, [string]>().mockResolvedValue(900_000),
    decr: jest.fn<Promise<number>, [string]>().mockResolvedValue(0),
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUCKET_ACCOUNT = RATE_LIMIT_BUCKETS.signInPerAccount; // limit: 20, windowMs: 900_000
const BUCKET_IP      = RATE_LIMIT_BUCKETS.signInPerIp;       // limit: 30, windowMs: 3_600_000
const BUCKET_RESET   = RATE_LIMIT_BUCKETS.passwordResetPerIp; // limit: 100, windowMs: 86_400_000

// ===========================================================================
// Key construction
// ===========================================================================

describe("RateLimiter — key construction", () => {
  it("RL-U1: builds key as `rl:<bucketName>:<identifier>` and calls incrWindow with it", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledWith("rl:signin_account:user-alice", BUCKET_ACCOUNT.windowMs);
  });

  it("RL-U2: different bucket names produce different keys for the same identifier", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);
    await limiter.check("signin_ip", "user-alice", BUCKET_IP);

    const keys = (redis.incrWindow as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:user-alice");
    expect(keys[1]).toBe("rl:signin_ip:user-alice");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("RL-U3: same bucket + different identifiers produce different keys", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);
    await limiter.check("signin_account", "bob", BUCKET_ACCOUNT);

    const keys = (redis.incrWindow as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toBe("rl:signin_account:alice");
    expect(keys[1]).toBe("rl:signin_account:bob");
  });
});

// ===========================================================================
// RT-618 — one atomic round trip per check
// ===========================================================================

describe("RateLimiter — one atomic round trip (RT-618)", () => {
  it("RL-U4: check makes exactly one port call and no other Redis command", async () => {
    const redis = makeMockRedis({ incrResult: 1 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledTimes(1);
    expect(redis.pttl).not.toHaveBeenCalled();
    expect(redis.decr).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("RL-U5: the window is passed on every hit, not only the first (TTL self-heal lives in the atomic call)", async () => {
    const redis = makeMockRedis({ incrResult: 2 });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledWith("rl:signin_account:user-alice", BUCKET_ACCOUNT.windowMs);
  });

  it("RL-U6: a hit at the limit is still one call", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit });
    const limiter = new RateLimiter(redis);

    await limiter.check("signin_account", "user-alice", BUCKET_ACCOUNT);

    expect(redis.incrWindow).toHaveBeenCalledTimes(1);
  });

  it("RL-U7: incrWindow receives correct windowMs for each bucket type", async () => {
    async function checkWindowMs(bucketName: string, bucket: typeof BUCKET_ACCOUNT | typeof BUCKET_IP | typeof BUCKET_RESET): Promise<void> {
      const redis = makeMockRedis({ incrResult: 1 });
      const limiter = new RateLimiter(redis);
      await limiter.check(bucketName, "192.0.2.1", bucket);
      expect(redis.incrWindow).toHaveBeenCalledWith(
        `rl:${bucketName}:192.0.2.1`,
        bucket.windowMs,
      );
    }

    await checkWindowMs("signin_account", BUCKET_ACCOUNT);
    await checkWindowMs("signin_ip", BUCKET_IP);
    await checkWindowMs("pwreset_ip", BUCKET_RESET);
  });

  it("RL-U7b: a port error propagates unchanged (callers own the fail posture)", async () => {
    const redis = makeMockRedis();
    redis.incrWindow.mockRejectedValueOnce(new Error("redis down"));
    const limiter = new RateLimiter(redis);

    await expect(limiter.check("signin_account", "alice", BUCKET_ACCOUNT)).rejects.toThrow("redis down");
  });
});

// ===========================================================================
// Decision — allowed / count / remaining / resetMs
// ===========================================================================

describe("RateLimiter — decision fields (allowed path)", () => {
  it("RL-U8: first hit is allowed, count=1, remaining=limit-1", async () => {
    const redis = makeMockRedis({ incrResult: 1, pttlResult: BUCKET_ACCOUNT.windowMs });
    const limiter = new RateLimiter(redis);

    const decision: RateLimitDecision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(1);
    expect(decision.remaining).toBe(BUCKET_ACCOUNT.limit - 1);
  });

  it("RL-U9: hit at exactly limit is allowed, remaining=0", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit, pttlResult: 60_000 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(BUCKET_ACCOUNT.limit);
    expect(decision.remaining).toBe(0);
  });

  it("RL-U10: resetMs equals the returned ttlMs when ttlMs >= 0", async () => {
    const redis = makeMockRedis({ incrResult: 1, pttlResult: 543_210 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(543_210);
  });
});

describe("RateLimiter — decision fields (blocked path)", () => {
  it("RL-U11: hit at limit+1 is blocked, allowed=false, remaining=0, count=limit+1", async () => {
    const redis = makeMockRedis({ incrResult: BUCKET_ACCOUNT.limit + 1, pttlResult: 300_000 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.allowed).toBe(false);
    expect(decision.count).toBe(BUCKET_ACCOUNT.limit + 1);
    expect(decision.remaining).toBe(0);
  });

  it("RL-U12: remaining is never negative — clamped at 0 when count far exceeds limit", async () => {
    const redis = makeMockRedis({ incrResult: 999, pttlResult: 100 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.remaining).toBe(0);
    expect(decision.allowed).toBe(false);
  });
});

// ===========================================================================
// Negative ttlMs from the port (stubs only; a real Redis always seeds the TTL)
// ===========================================================================

describe("RateLimiter — resetMs from negative pttl values", () => {
  it("RL-U13: resetMs is -1 when the port reports ttlMs -1 (stub such as AlwaysAllowRedis)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -1 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U14: resetMs is -1 when the port reports ttlMs -2", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: -2 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(-1);
  });

  it("RL-U15: resetMs is 0 when ttlMs is 0 (key is expiring now)", async () => {
    const redis = makeMockRedis({ incrResult: 2, pttlResult: 0 });
    const limiter = new RateLimiter(redis);

    const decision = await limiter.check("signin_account", "alice", BUCKET_ACCOUNT);

    expect(decision.resetMs).toBe(0);
  });
});

// ===========================================================================
// RATE_LIMIT_BUCKETS constants
// ===========================================================================

describe("RATE_LIMIT_BUCKETS constants", () => {
  it("RL-U16 (RT-625 D1): signInPerAccount has limit=20 and windowMs=15min", () => {
    expect(BUCKET_ACCOUNT.limit).toBe(20);
    expect(BUCKET_ACCOUNT.windowMs).toBe(15 * 60 * 1000);
  });

  it("RL-U16b (RT-625 D1): signInPerPair has limit=5 and windowMs=15min", () => {
    expect(RATE_LIMIT_BUCKETS.signInPerPair).toEqual({ limit: 5, windowMs: 15 * 60 * 1000 });
  });

  it("RL-U17: signInPerIp has limit=30 and windowMs=1hour", () => {
    expect(BUCKET_IP.limit).toBe(30);
    expect(BUCKET_IP.windowMs).toBe(60 * 60 * 1000);
  });

  it("RL-U18: passwordResetPerIp has limit=100 and windowMs=24hours", () => {
    expect(BUCKET_RESET.limit).toBe(100);
    expect(BUCKET_RESET.windowMs).toBe(24 * 60 * 60 * 1000);
  });

  it("RL-U19 (RT-625 reset two-tier): passwordResetPerEmail has limit=20 and windowMs=1hour", () => {
    expect(RATE_LIMIT_BUCKETS.passwordResetPerEmail).toEqual({ limit: 20, windowMs: 60 * 60 * 1000 });
  });

  it("RL-U19b (RT-625 reset two-tier): passwordResetPerPair has limit=5 and windowMs=1hour", () => {
    expect(RATE_LIMIT_BUCKETS.passwordResetPerPair).toEqual({ limit: 5, windowMs: 60 * 60 * 1000 });
  });

  it("RL-U20 (RT-626): emailVerifyConfirmPerIp has limit=20 and windowMs=15min", () => {
    expect(RATE_LIMIT_BUCKETS.emailVerifyConfirmPerIp).toEqual({ limit: 20, windowMs: 15 * 60 * 1000 });
  });
});

// ===========================================================================
// RT-625 D2 — clear drops the whole window
// ===========================================================================

describe("RateLimiter.clear (RT-625 D2)", () => {
  it("RL-U21: deletes the bucket key and nothing else", async () => {
    const redis = makeMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.clear("signin_account", "alice@example.com");

    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith("rl:signin_account:alice@example.com");
    expect(redis.decr).not.toHaveBeenCalled();
    expect(redis.incrWindow).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// RT-625 P2 — client-IP and (email, IP) identifiers
// ===========================================================================

describe("RT-625 P2 keying (public-auth-keys)", () => {
  it("test 12: two IPv6 addresses in one /64 share a key; different /64s do not", () => {
    const a = clientIpKey("2001:db8:1:2:aaaa::1");
    const b = clientIpKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff");
    const other = clientIpKey("2001:db8:1:3::1");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(other).not.toBe(a);
    expect(emailIpPairKey("e@x.test", "2001:db8:1:2::9")).toBe(emailIpPairKey("e@x.test", "2001:db8:1:2::1"));
    expect(emailIpPairKey("e@x.test", "2001:db8:1:3::1")).not.toBe(emailIpPairKey("e@x.test", "2001:db8:1:2::1"));
  });

  it.each([
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["2001:DB8::", "2001:db8:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
  ])("test 12: %p is keyed by its /64 (%p)", (ip, key) => {
    expect(clientIpKey(ip)).toBe(key);
  });

  it("test 13: an IPv4-mapped IPv6 address and its IPv4 form share one key", () => {
    expect(clientIpKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(clientIpKey("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(clientIpKey("203.0.113.5")).toBe("203.0.113.5");
    expect(emailIpPairKey("e@x.test", "::ffff:203.0.113.5")).toBe(emailIpPairKey("e@x.test", "203.0.113.5"));
  });

  it("a value that is not an IP is passed through, never thrown on", () => {
    expect(clientIpKey("unknown")).toBe("unknown");
  });

  it("test 14: an email differing only in case or outer whitespace maps to one key", () => {
    expect(accountKey("  User@Example.COM ")).toBe("user@example.com");
    expect(emailIpPairKey("  User@Example.COM ", "203.0.113.5")).toBe(emailIpPairKey("user@example.com", "203.0.113.5"));
  });

  it("test 15: no two (email, IP) pairs share a key, even where a raw `email:ip` join would", () => {
    // A raw join collides: "a@x:1" + "2::1" and "a@x:1:2" + ":1" (and the like).
    const pairs: Array<[string, string]> = [
      ["a@x.test", "2001:db8::1"],
      ["a@x.test:2001", "db8::1"],
      ["a@x.test|2001:db8::/64", ""],
      ["a@x.test", "2001:db8:0:1::1"],
      ["a@x.testa", "203.0.113.5"],
      ["a@x.test", "a203.0.113.5"],
      ["1:a@x.test", "203.0.113.5"],
    ];
    const keys = pairs.map(([email, ip]) => emailIpPairKey(email, ip));
    expect(new Set(keys).size).toBe(keys.length);
    // The identifier is length-prefixed, never a raw concatenation.
    expect(emailIpPairKey("a@x.test", "203.0.113.5")).toBe("8:a@x.test|203.0.113.5");
  });
});
