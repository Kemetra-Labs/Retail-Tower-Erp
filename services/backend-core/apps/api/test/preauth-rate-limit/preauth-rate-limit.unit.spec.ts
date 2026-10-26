/**
 * RT-630 — report-only per-IP pre-auth counter: config parsing and
 * PreAuthRateLimitReporter behaviour (RT-574 R1, owner O5).
 *
 * Docker-free: the limiter is a stub whose decision the test controls. The
 * HTTP shape (a 401 stays a 401, never a 429) is in preauth-rate-limit.http.spec.ts.
 */
import type { RateLimitBucket, RateLimitDecision, RateLimiter } from "../../src/auth/rate-limit";
import type { AuthedRequest } from "../../src/auth/auth.guard";
import * as metrics from "../../src/observability/metrics/preauth-rate-limit.metrics";
import {
  DEFAULT_PREAUTH_RATE_LIMIT_BUCKET,
  DEFAULT_PREAUTH_RATE_LIMIT_TIMEOUT_MS,
  readPreAuthRateLimitConfig,
  type PreAuthRateLimitConfig,
} from "../../src/preauth-rate-limit/preauth-rate-limit.config";
import {
  PreAuthRateLimitReporter,
  preAuthFailureCause,
} from "../../src/preauth-rate-limit/preauth-rate-limit.reporter";

const IP = "203.0.113.77";

describe("readPreAuthRateLimitConfig", () => {
  it("defaults to off with the documented ceiling and timeout", () => {
    expect(readPreAuthRateLimitConfig({})).toEqual({
      mode: "off",
      bucket: { limit: 300, windowMs: 300_000 },
      timeoutMs: 250,
    });
  });

  it("accepts report (case and whitespace insensitive)", () => {
    expect(readPreAuthRateLimitConfig({ PREAUTH_RATE_LIMIT_MODE: " Report " }).mode).toBe("report");
  });

  it.each(["enforce", "on", "true", "reprot", ""])("treats %p as off: there is no enforce mode", (raw) => {
    expect(readPreAuthRateLimitConfig({ PREAUTH_RATE_LIMIT_MODE: raw }).mode).toBe("off");
  });

  it("reads a valid limit, window and timeout", () => {
    const cfg = readPreAuthRateLimitConfig({
      PREAUTH_RATE_LIMIT_LIMIT: "1000",
      PREAUTH_RATE_LIMIT_WINDOW_MS: "60000",
      PREAUTH_RATE_LIMIT_TIMEOUT_MS: "100",
    });
    expect(cfg.bucket).toEqual({ limit: 1000, windowMs: 60_000 });
    expect(cfg.timeoutMs).toBe(100);
  });

  it.each([
    ["PREAUTH_RATE_LIMIT_LIMIT", "0"],
    ["PREAUTH_RATE_LIMIT_LIMIT", "-5"],
    ["PREAUTH_RATE_LIMIT_LIMIT", "1e3"],
    ["PREAUTH_RATE_LIMIT_WINDOW_MS", "999"],
    ["PREAUTH_RATE_LIMIT_WINDOW_MS", "3600001"],
    ["PREAUTH_RATE_LIMIT_TIMEOUT_MS", "0"],
    ["PREAUTH_RATE_LIMIT_TIMEOUT_MS", "10001"],
  ])("falls back to the default for %s=%p", (name, raw) => {
    const cfg = readPreAuthRateLimitConfig({ [name]: raw });
    expect(cfg.bucket).toEqual(DEFAULT_PREAUTH_RATE_LIMIT_BUCKET);
    expect(cfg.timeoutMs).toBe(DEFAULT_PREAUTH_RATE_LIMIT_TIMEOUT_MS);
  });
});

describe("preAuthFailureCause", () => {
  const req = (headers: Record<string, string>, cookies?: Record<string, string>) =>
    ({ headers, cookies }) as unknown as AuthedRequest;

  it("is missing with no credential at all", () => {
    expect(preAuthFailureCause(req({}))).toBe("missing");
    expect(preAuthFailureCause(req({ authorization: "Basic abc" }))).toBe("missing");
  });

  it("is bad_token when a session cookie or bearer was presented", () => {
    expect(preAuthFailureCause(req({}, { dp2_session: "garbage" }))).toBe("bad_token");
    expect(preAuthFailureCause(req({ cookie: "dp2_session=garbage" }))).toBe("bad_token");
    expect(preAuthFailureCause(req({ authorization: "Bearer garbage" }))).toBe("bad_token");
  });
});

interface StubLimiter {
  limiter: RateLimiter;
  check: jest.Mock;
  setCount(count: number): void;
}

function stubLimiter(): StubLimiter {
  let count = 1;
  const check = jest.fn(
    async (_bucket: string, _id: string, bucket: RateLimitBucket): Promise<RateLimitDecision> => ({
      allowed: count <= bucket.limit,
      count,
      remaining: Math.max(0, bucket.limit - count),
      resetMs: 30_000,
    }),
  );
  return {
    limiter: { check } as unknown as RateLimiter,
    check,
    setCount(next: number) {
      count = next;
    },
  };
}

function config(mode: PreAuthRateLimitConfig["mode"], limit = 10, timeoutMs = 250): PreAuthRateLimitConfig {
  return { mode, bucket: { limit, windowMs: 60_000 }, timeoutMs };
}

function failedRequest(credential: "cookie" | "none" = "cookie"): AuthedRequest {
  const headers: Record<string, string> = credential === "cookie" ? { cookie: "dp2_session=garbage-cookie-value" } : {};
  return { ip: IP, headers } as unknown as AuthedRequest;
}

let recordTotal: jest.SpyInstance;
let recordUtilisation: jest.SpyInstance;

beforeEach(() => {
  recordTotal = jest.spyOn(metrics, "recordPreAuthRateLimit");
  recordUtilisation = jest.spyOn(metrics, "recordPreAuthRateLimitUtilisation");
});

afterEach(() => {
  jest.restoreAllMocks();
});

function reporter(mode: PreAuthRateLimitConfig["mode"], stub: StubLimiter, clock: () => number = Date.now, timeoutMs = 250) {
  const log = { warn: jest.fn() };
  return { reporter: new PreAuthRateLimitReporter(config(mode, 10, timeoutMs), stub.limiter, log, clock), log };
}

describe("PreAuthRateLimitReporter — off (disabled)", () => {
  it("makes no limiter call, records nothing and logs nothing", async () => {
    const stub = stubLimiter();
    const { reporter: r, log } = reporter("off", stub);
    await r.report(failedRequest());
    expect(stub.check).not.toHaveBeenCalled();
    expect(recordTotal).not.toHaveBeenCalled();
    expect(recordUtilisation).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("PreAuthRateLimitReporter — report", () => {
  it("counts the failure per client IP in the preauth_ip bucket", async () => {
    const stub = stubLimiter();
    const { reporter: r } = reporter("report", stub);
    await r.report(failedRequest());
    expect(stub.check).toHaveBeenCalledWith("preauth_ip", IP, { limit: 10, windowMs: 60_000 });
  });

  it("under the ceiling: allowed, utilisation recorded, no log", async () => {
    const stub = stubLimiter();
    stub.setCount(2);
    const { reporter: r, log } = reporter("report", stub);
    await r.report(failedRequest());
    expect(recordTotal).toHaveBeenCalledWith({ cause: "bad_token", outcome: "allowed" });
    expect(recordUtilisation).toHaveBeenCalledWith({ cause: "bad_token" }, 0.2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("at half the ceiling: near_limit", async () => {
    const stub = stubLimiter();
    stub.setCount(5);
    const { reporter: r } = reporter("report", stub);
    await r.report(failedRequest("none"));
    expect(recordTotal).toHaveBeenCalledWith({ cause: "missing", outcome: "near_limit" });
  });

  it("over the ceiling: would_limit, logged once per interval, never throws", async () => {
    let now = 1_000;
    const stub = stubLimiter();
    stub.setCount(11);
    const { reporter: r, log } = reporter("report", stub, () => now);
    await expect(r.report(failedRequest())).resolves.toBeUndefined();
    await r.report(failedRequest());
    expect(recordTotal).toHaveBeenCalledTimes(2);
    expect(recordTotal).toHaveBeenLastCalledWith({ cause: "bad_token", outcome: "would_limit" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    now += 60_000;
    await r.report(failedRequest());
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("never puts the IP, cookie or token in a log or a metric", async () => {
    const stub = stubLimiter();
    stub.setCount(11);
    const { reporter: r, log } = reporter("report", stub);
    await r.report(failedRequest());
    const emitted = JSON.stringify([log.warn.mock.calls, recordTotal.mock.calls, recordUtilisation.mock.calls]);
    expect(emitted).not.toContain(IP);
    expect(emitted).not.toContain("203.0.113");
    expect(emitted).not.toContain("garbage-cookie-value");
  });

  it("a limiter error fails open: fail_open counted, nothing thrown", async () => {
    const stub = stubLimiter();
    stub.check.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { reporter: r, log } = reporter("report", stub);
    await expect(r.report(failedRequest())).resolves.toBeUndefined();
    expect(recordTotal).toHaveBeenCalledWith({ cause: "bad_token", outcome: "fail_open" });
    expect(recordUtilisation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ cause: "bad_token", err_class: "Error" }, expect.any(String));
  });

  it("a limiter slower than the timeout fails open within the bound", async () => {
    const stub = stubLimiter();
    stub.check.mockReturnValueOnce(new Promise(() => undefined));
    const { reporter: r } = reporter("report", stub, Date.now, 20);
    const started = Date.now();
    await r.report(failedRequest());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(recordTotal).toHaveBeenCalledWith({ cause: "bad_token", outcome: "fail_open" });
  });

  it("opens the breaker after 5 consecutive failures and stops calling the limiter", async () => {
    const now = 1_000;
    const stub = stubLimiter();
    stub.check.mockRejectedValue(new Error("down"));
    const { reporter: r } = reporter("report", stub, () => now);
    for (let i = 0; i < 8; i++) await r.report(failedRequest());
    expect(stub.check).toHaveBeenCalledTimes(5);
    expect(recordTotal).toHaveBeenCalledTimes(8);
  });

  it("swallows an unexpected internal error", async () => {
    const stub = stubLimiter();
    recordTotal.mockImplementation(() => {
      throw new Error("metric sdk broke");
    });
    const { reporter: r } = reporter("report", stub);
    await expect(r.report(failedRequest())).resolves.toBeUndefined();
  });
});
