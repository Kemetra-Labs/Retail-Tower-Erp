/**
 * RT-1246 — onIdleClientError: a pg.Pool re-emits an idle client's error
 * (e.g. SQLSTATE 57P01 when Postgres restarts) on the pool. Without a
 * listener Node throws and the process exits (Sentry BACKEND-CORE-7).
 */
import { EventEmitter } from "node:events";

import { onIdleClientError } from "../../src/observability/db-pool";

function pgError(message: string, code?: unknown): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("onIdleClientError", () => {
  it("adds one error listener, so an emitted error no longer throws", () => {
    const pool = new EventEmitter();
    onIdleClientError(pool, jest.fn());

    expect(pool.listenerCount("error")).toBe(1);
    expect(() =>
      pool.emit("error", pgError("terminating connection due to administrator command", "57P01")),
    ).not.toThrow();
  });

  it("warns once with the SQLSTATE", () => {
    const pool = new EventEmitter();
    const warn = jest.fn();
    onIdleClientError(pool, warn);

    pool.emit("error", pgError("terminating connection due to administrator command", "57P01"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("SQLSTATE 57P01");
  });

  it("never logs the error message (it can name hosts, roles or databases)", () => {
    const pool = new EventEmitter();
    const warn = jest.fn();
    onIdleClientError(pool, warn);

    pool.emit("error", pgError('password authentication failed for user "app" at db.internal', "28P01"));

    const logged = String(warn.mock.calls[0][0]);
    expect(logged).not.toContain("password authentication failed");
    expect(logged).not.toContain("db.internal");
    expect(logged).toContain("SQLSTATE 28P01");
  });

  it.each([
    ["no code (socket error)", undefined],
    ["a non-SQLSTATE code", "ECONNRESET"],
    ["a non-string code", 57],
  ])("reports %s as SQLSTATE unknown", (_label, code) => {
    const pool = new EventEmitter();
    const warn = jest.fn();
    onIdleClientError(pool, warn);

    pool.emit("error", pgError("read ECONNRESET", code));

    expect(warn.mock.calls[0][0]).toContain("SQLSTATE unknown");
  });

  it("does not throw when the value emitted is not an Error", () => {
    const pool = new EventEmitter();
    const warn = jest.fn();
    onIdleClientError(pool, warn);

    expect(() => pool.emit("error", null)).not.toThrow();
    expect(warn.mock.calls[0][0]).toContain("SQLSTATE unknown");
  });
});
