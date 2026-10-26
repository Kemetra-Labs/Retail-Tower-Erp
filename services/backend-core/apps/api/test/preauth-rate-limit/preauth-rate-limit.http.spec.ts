/**
 * RT-630 — the report-only pre-auth counter over a real Nest HTTP stack.
 *
 * The real FailClosedAuthGuard and AuthGuard run as the global guard (with
 * in-memory session / token repositories), the real GlobalExceptionFilter
 * renders the 401, and the reporter counts into a stateful in-memory Redis
 * fake. Asserts the acceptance: no request is ever refused by the counter
 * (a garbage cookie or bearer stays a 401, never a 429, under and over the
 * ceiling), a valid credential is not counted, `off` makes no Redis call, and
 * no log carries the IP or the credential.
 */
import "reflect-metadata";

import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthGuard } from "../../src/auth/auth.guard";
import { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { RateLimiter, type RedisLike, type WindowHit } from "../../src/auth/rate-limit";
import { Public } from "../../src/auth/route-auth";
import { SessionRepository } from "../../src/auth/session.repository";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import * as metrics from "../../src/observability/metrics/preauth-rate-limit.metrics";
import {
  PREAUTH_RATE_LIMIT_CONFIG,
  type PreAuthRateLimitConfig,
} from "../../src/preauth-rate-limit/preauth-rate-limit.config";
import {
  PREAUTH_RATE_LIMIT_CLOCK,
  PreAuthRateLimitReporter,
} from "../../src/preauth-rate-limit/preauth-rate-limit.reporter";
import { fixedWindowHit, type FixedWindowEntry } from "../_helpers/fixed-window-hit";

const VALID_TOKEN = "valid-dashboard-token";
const LIMIT = 3;

@Controller("api/v1/probe")
class ProbeController {
  @Get("items")
  list(): { ok: true } {
    return { ok: true };
  }

  @Get("open")
  @Public()
  open(): { ok: true } {
    return { ok: true };
  }
}

class ClockedRedisFake implements RedisLike {
  readonly store = new Map<string, FixedWindowEntry>();
  calls = 0;
  constructor(private readonly clock: () => number) {}
  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    this.calls += 1;
    return fixedWindowHit(this.store, key, ttlMs, this.clock());
  }
  async pttl(): Promise<number> {
    return -2;
  }
  async decr(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
}

const sessions = {
  findActiveByCredential: async () => null,
  recordActivity: async () => undefined,
};

const authTokens = {
  findActiveByRawToken: async (raw: string) =>
    raw === VALID_TOKEN
      ? { id: "tok-1", tenantId: "t-1", userId: "u-1", storeId: null, scope: "dashboard_api" }
      : null,
};

async function boot(mode: PreAuthRateLimitConfig["mode"]) {
  const now = 1_700_000_000_000;
  const clock = (): number => now;
  const redis = new ClockedRedisFake(clock);
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const config: PreAuthRateLimitConfig = { mode, bucket: { limit: LIMIT, windowMs: 60_000 }, timeoutMs: 250 };
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      Reflector,
      AuthGuard,
      { provide: SessionRepository, useValue: sessions },
      { provide: AuthTokenRepository, useValue: authTokens },
      { provide: RateLimiter, useValue: new RateLimiter(redis) },
      { provide: PREAUTH_RATE_LIMIT_CONFIG, useValue: config },
      { provide: PREAUTH_RATE_LIMIT_CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: log },
      PreAuthRateLimitReporter,
      { provide: APP_GUARD, useClass: FailClosedAuthGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { app, redis, log };
}

let recordTotal: jest.SpyInstance;

beforeEach(() => {
  recordTotal = jest.spyOn(metrics, "recordPreAuthRateLimit");
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("report mode over HTTP", () => {
  let h: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    h = await boot("report");
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("a garbage cookie flood stays 401 under and over the ceiling (never refused by the counter)", async () => {
    for (let i = 0; i < LIMIT + 3; i++) {
      const res = await request(h.app.getHttpServer())
        .get("/api/v1/probe/items")
        .set("Cookie", "dp2_session=garbage-cookie-value");
      expect(res.status).toBe(401);
    }
    const outcomes = recordTotal.mock.calls.map(([attrs]) => (attrs as metrics.PreAuthRateLimitAttrs).outcome);
    expect(outcomes).toEqual(["allowed", "near_limit", "near_limit", "would_limit", "would_limit", "would_limit"]);
    expect(recordTotal.mock.calls.every(([a]) => (a as metrics.PreAuthRateLimitAttrs).cause === "bad_token")).toBe(true);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });

  it("a garbage bearer and a missing credential are counted with their cause and stay 401", async () => {
    const server = h.app.getHttpServer();
    expect((await request(server).get("/api/v1/probe/items").set("Authorization", "Bearer garbage")).status).toBe(401);
    expect((await request(server).get("/api/v1/probe/items")).status).toBe(401);
    expect(recordTotal.mock.calls.map(([a]) => (a as metrics.PreAuthRateLimitAttrs).cause)).toEqual([
      "bad_token",
      "missing",
    ]);
  });

  it("does not count a valid credential or a public route", async () => {
    const server = h.app.getHttpServer();
    const ok = await request(server).get("/api/v1/probe/items").set("Authorization", `Bearer ${VALID_TOKEN}`);
    expect(ok.status).toBe(200);
    expect((await request(server).get("/api/v1/probe/open")).status).toBe(200);
    expect(h.redis.calls).toBe(0);
    expect(recordTotal).not.toHaveBeenCalled();
  });

  it("keys the window by client IP only in Redis, and no log carries the IP or the cookie", async () => {
    for (let i = 0; i < LIMIT + 1; i++) {
      await request(h.app.getHttpServer()).get("/api/v1/probe/items").set("Cookie", "dp2_session=garbage-cookie-value");
    }
    const keys = [...h.redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^rl:preauth_ip:/);
    const logged = JSON.stringify(h.log.warn.mock.calls);
    expect(logged).not.toContain("127.0.0.1");
    expect(logged).not.toContain("::1");
    expect(logged).not.toContain("garbage-cookie-value");
  });
});

describe("off mode over HTTP (disabled)", () => {
  it("answers 401 exactly as before with no Redis call and no metric", async () => {
    const h = await boot("off");
    try {
      for (let i = 0; i < LIMIT + 2; i++) {
        const res = await request(h.app.getHttpServer())
          .get("/api/v1/probe/items")
          .set("Cookie", "dp2_session=garbage-cookie-value");
        expect(res.status).toBe(401);
      }
      expect(h.redis.calls).toBe(0);
      expect(recordTotal).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
});
