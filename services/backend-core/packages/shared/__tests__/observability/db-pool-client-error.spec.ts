/**
 * RT-1246 — onPoolClientError: when Postgres restarts (SQLSTATE 57P01) every
 * connection errors. pg-pool re-emits an idle client's error on the pool, and a
 * checked-out client (e.g. inside runWithTenantContext) emits it on the client,
 * whose pool listener was removed at checkout. Without a listener Node throws
 * and the process exits (Sentry BACKEND-CORE-7).
 */
import { EventEmitter } from "node:events";

import { onPoolClientError } from "../../src/observability/db-pool";

/** A pool whose one client has been opened (pg-pool emits "connect"). */
function poolWithClient(warn: (message: string) => void): { pool: EventEmitter; client: EventEmitter } {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  onPoolClientError(pool, warn);
  pool.emit("connect", client);
  return { pool, client };
}

function pgError(message: string, code?: unknown): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("onPoolClientError", () => {
  it("guards the pool: pg-pool's re-emit of an idle client's error no longer throws", () => {
    const pool = new EventEmitter();
    const warn = jest.fn();
    onPoolClientError(pool, warn);

    expect(pool.listenerCount("error")).toBe(1);
    expect(() =>
      pool.emit("error", pgError("terminating connection due to administrator command", "57P01")),
    ).not.toThrow();
    // The client's own listener already logged it; the pool guard stays quiet.
    expect(warn).not.toHaveBeenCalled();
  });

  it("guards a checked-out client: its error no longer throws", () => {
    const { client } = poolWithClient(jest.fn());
    // pg-pool removes its idle listener at checkout; only ours is left.
    expect(client.listenerCount("error")).toBe(1);
    expect(() =>
      client.emit("error", new Error("Connection terminated unexpectedly")),
    ).not.toThrow();
  });

  it("a client error warns once with the SQLSTATE", () => {
    const warn = jest.fn();
    const { client } = poolWithClient(warn);

    client.emit("error", pgError("terminating connection due to administrator command", "57P01"));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("SQLSTATE 57P01");
  });

  it("never logs the error message (it can name hosts, roles or databases)", () => {
    const warn = jest.fn();
    const { client } = poolWithClient(warn);

    client.emit("error", pgError('password authentication failed for user "app" at db.internal', "28P01"));

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
    const warn = jest.fn();
    const { client } = poolWithClient(warn);

    client.emit("error", pgError("read ECONNRESET", code));

    expect(warn.mock.calls[0][0]).toContain("SQLSTATE unknown");
  });

  it("does not throw when the value emitted is not an Error", () => {
    const warn = jest.fn();
    const { client } = poolWithClient(warn);

    expect(() => client.emit("error", null)).not.toThrow();
    expect(warn.mock.calls[0][0]).toContain("SQLSTATE unknown");
  });
});
