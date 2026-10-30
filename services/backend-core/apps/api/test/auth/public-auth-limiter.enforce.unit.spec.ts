/**
 * public-auth-limiter.enforce.unit.spec.ts — RT-937 (review nitpick on PR 152).
 *
 * `enforcePublicLimit` answers a refusal with 429 and a limiter outage with 503, both
 * with `Retry-After`. On an outage it also logs the PII-free limiter context (the
 * bucket name and whether it timed out or errored) so an operator can tell a Redis
 * stall from a code path. The identifier (an IP address) is never logged.
 *
 * Docker-free: a fake limiter, a fake response, and a captured logger.
 */
import { HttpException } from "@nestjs/common";
import type { Response } from "express";

const warn = jest.fn();

jest.mock("@data-pulse-2/shared", () => ({
  ...jest.requireActual("@data-pulse-2/shared"),
  createLogger: jest.fn(() => ({ warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

import { enforcePublicLimit } from "../../src/auth/public-auth-limiter";
import type { RateLimiter } from "../../src/auth/rate-limit";

const HIT = {
  bucketName: "invitation_accept_ip",
  identifier: "203.0.113.7",
  bucket: { limit: 20, windowMs: 900_000 },
};

function fakeRes() {
  const headers: Record<string, string> = {};
  return { res: { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response, headers };
}

function limiter(check: () => Promise<unknown>): RateLimiter {
  return { check, release: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimiter;
}

beforeEach(() => warn.mockClear());

describe("enforcePublicLimit", () => {
  it("allows a hit within budget without logging or headers", async () => {
    const { res, headers } = fakeRes();
    const l = limiter(() => Promise.resolve({ allowed: true, count: 1, remaining: 19, resetMs: 1000 }));

    await expect(enforcePublicLimit(l, HIT, 1000, res)).resolves.toBeUndefined();
    expect(headers).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After and does not log (a refusal is not an outage)", async () => {
    const { res, headers } = fakeRes();
    const l = limiter(() => Promise.resolve({ allowed: false, count: 21, remaining: 0, resetMs: 90_000 }));

    const error = await enforcePublicLimit(l, HIT, 1000, res).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(headers["Retry-After"]).toBe("90");
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers 503 with Retry-After on a limiter error, logging the bucket and reason but not the identifier", async () => {
    const { res, headers } = fakeRes();
    const l = limiter(() => Promise.reject(new Error("redis down")));

    const error = await enforcePublicLimit(l, HIT, 1000, res).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(503);
    expect(headers["Retry-After"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ bucket: "invitation_accept_ip", reason: "error" });
    expect(message).toMatch(/failing closed/);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("203.0.113.7");
  });

  it("answers 503 and logs reason=timeout when the limiter does not answer in time", async () => {
    const { res } = fakeRes();
    const l = limiter(() => new Promise(() => undefined));

    const error = await enforcePublicLimit(l, HIT, 10, res).catch((e: unknown) => e);

    expect((error as HttpException).getStatus()).toBe(503);
    expect(warn).toHaveBeenCalledWith(
      { bucket: "invitation_accept_ip", reason: "timeout" },
      expect.stringMatching(/failing closed/),
    );
  });
});
