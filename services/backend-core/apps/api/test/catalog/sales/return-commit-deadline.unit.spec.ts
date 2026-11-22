/**
 * return-commit-deadline.unit.spec.ts — RT-1548 slice 2, BR-7: the 60-second
 * bound on issuing the COMMIT of a `recordReturn` request, from request
 * receipt. Docker-free, with a fake clock: the deadline arithmetic, the
 * per-statement timeout arming, the serialization of statements, the receipt
 * stamp and the mapping of Postgres timeouts. The database behaviour (a lock
 * wait that outlives the budget never commits) is the db-integration spec.
 */
import type { PoolClient } from "pg";

import {
  CommitDeadline,
  commitDeadlineOf,
  GuardedClientClosedError,
  isDeadlineTimeoutError,
  RETURN_COMMIT_BUDGET_MS,
  ReturnCommitDeadlineMiddleware,
  ReturnDeadlineExceededError,
  type DeadlineClock,
} from "../../../src/catalog/sales/return-commit-deadline";

class FakeClock implements DeadlineClock {
  constructor(private t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A client whose `query` records every statement in order. */
function fakeClient(impl?: (sql: string) => Promise<unknown>) {
  const log: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    log.push({ sql, values });
    return impl ? impl(sql) : { rows: [], rowCount: 0 };
  });
  const release = jest.fn();
  const client = { query, release, marker: "pg-client" } as unknown as PoolClient;
  return { client, log, query, release };
}

const ARM = /set_config\('statement_timeout', \$1, true\), set_config\('lock_timeout', \$1, true\)/;

describe("RETURN_COMMIT_BUDGET_MS", () => {
  it("is the 60 seconds the contract states, in one named constant", () => {
    expect(RETURN_COMMIT_BUDGET_MS).toBe(60_000);
  });
});

describe("CommitDeadline — arithmetic from receipt", () => {
  it("counts down from the receipt, not from construction (time spent before the handler is charged)", () => {
    const clock = new FakeClock();
    const receivedAt = clock.now();
    clock.advance(12_000); // guards, idempotency claim, pool wait
    const d = new CommitDeadline(receivedAt, clock);
    expect(d.remainingMs()).toBe(48_000);
    clock.advance(30_000);
    expect(d.remainingMs()).toBe(18_000);
  });

  it("startingNow gives the full budget at the moment of the call", () => {
    const clock = new FakeClock();
    expect(CommitDeadline.startingNow(clock).remainingMs()).toBe(RETURN_COMMIT_BUDGET_MS);
  });

  it("takes an explicit budget (tests use a short one with the real clock)", () => {
    const clock = new FakeClock();
    expect(new CommitDeadline(clock.now(), clock, 500).remainingMs()).toBe(500);
  });

  it("assertOpen passes with time left and throws ReturnDeadlineExceededError at exactly zero", () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    d.assertOpen();
    clock.advance(RETURN_COMMIT_BUDGET_MS - 1);
    d.assertOpen(); // 1 ms left
    clock.advance(1);
    expect(d.remainingMs()).toBe(0);
    expect(() => d.assertOpen()).toThrow(ReturnDeadlineExceededError);
  });

  it("a remainder below one whole millisecond counts as expired (a 0 timeout would DISABLE the Postgres timeout)", () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    clock.advance(RETURN_COMMIT_BUDGET_MS - 0.5);
    expect(() => d.assertOpen()).toThrow(ReturnDeadlineExceededError);
  });

  it("an already-late request (clock far past the budget) throws", () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    clock.advance(10 * RETURN_COMMIT_BUDGET_MS);
    expect(() => d.assertOpen()).toThrow(ReturnDeadlineExceededError);
  });
});

describe("CommitDeadline.guardClient — arm the timeouts before every statement", () => {
  it("issues one arming statement, then the statement, with the remaining budget floored to whole ms", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    clock.advance(1_500.7);
    const { client, log } = fakeClient();
    await d.guardClient(client).query("SELECT 1", ["x"]);
    expect(log).toHaveLength(2);
    expect(log[0]!.sql).toMatch(ARM);
    expect(log[0]!.values).toEqual([String(Math.floor(RETURN_COMMIT_BUDGET_MS - 1_500.7))]);
    expect(log[1]).toEqual({ sql: "SELECT 1", values: ["x"] });
  });

  it("re-arms with the NEW remaining budget before each later statement", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient();
    const guarded = d.guardClient(client);
    await guarded.query("SELECT 1");
    clock.advance(20_000);
    await guarded.query("SELECT 2");
    clock.advance(20_000);
    await guarded.query("SELECT 3");
    const arms = log.filter((l) => ARM.test(l.sql)).map((l) => (l.values as string[])[0]);
    expect(arms).toEqual(["60000", "40000", "20000"]);
    expect(log.filter((l) => !ARM.test(l.sql)).map((l) => l.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("a statement started after the budget is gone is never sent: ReturnDeadlineExceededError", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, query } = fakeClient();
    const guarded = d.guardClient(client);
    clock.advance(RETURN_COMMIT_BUDGET_MS);
    await expect(guarded.query("INSERT INTO sale_returns DEFAULT VALUES")).rejects.toBeInstanceOf(
      ReturnDeadlineExceededError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("serializes concurrent calls: each arming statement is immediately followed by its own statement", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient(async () => {
      await new Promise((r) => setImmediate(r));
      return { rows: [] };
    });
    const guarded = d.guardClient(client);
    await Promise.all([guarded.query("SELECT A"), guarded.query("SELECT B"), guarded.query("SELECT C")]);
    const kinds = log.map((l) => (ARM.test(l.sql) ? "arm" : l.sql));
    expect(kinds).toEqual(["arm", "SELECT A", "arm", "SELECT B", "arm", "SELECT C"]);
  });

  it("computes each arm when the statement's turn arrives, not when it was queued", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient(async (sql) => {
      if (sql === "SELECT SLOW") clock.advance(30_000); // the first statement holds the connection for 30 s
      return { rows: [] };
    });
    const guarded = d.guardClient(client);
    await Promise.all([guarded.query("SELECT SLOW"), guarded.query("SELECT NEXT")]);
    const arms = log.filter((l) => ARM.test(l.sql)).map((l) => (l.values as string[])[0]);
    expect(arms).toEqual(["60000", "30000"]);
  });

  it("a failing statement rejects its caller and does not poison the queue", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client } = fakeClient(async (sql) => {
      if (sql === "SELECT BAD") throw new Error("boom");
      return { rows: [{ ok: 1 }] };
    });
    const guarded = d.guardClient(client);
    const bad = guarded.query("SELECT BAD");
    const good = guarded.query("SELECT GOOD");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("passes every other member through to the real client (release, fields)", () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, release } = fakeClient();
    const guarded = d.guardClient(client) as unknown as { marker: string; release: () => void };
    expect(guarded.marker).toBe("pg-client");
    guarded.release();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("CommitDeadline.runGuarded — no statement after the work has settled (LOW-1)", () => {
  it("passes the guarded client to the work and returns the work's value", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient();
    const out = await d.runGuarded(client, async (c) => {
      await c.query("SELECT 1");
      return 42;
    });
    expect(out).toBe(42);
    expect(log.map((l) => l.sql).filter((s) => !ARM.test(s))).toEqual(["SELECT 1"]);
  });

  it("a statement started after the work resolved (so after COMMIT is next) is refused and never sent", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient();
    let captured!: PoolClient;
    await d.runGuarded(client, async (c) => {
      captured = c;
    });
    const before = log.length;
    await expect(captured.query("SELECT LATE")).rejects.toBeInstanceOf(GuardedClientClosedError);
    expect(log).toHaveLength(before);
  });

  it("the same after the work threw (a ROLLBACK is next): the rejection propagates and a late statement is refused", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client, log } = fakeClient();
    let captured!: PoolClient;
    const boom = new Error("work failed");
    await expect(
      d.runGuarded(client, async (c) => {
        captured = c;
        throw boom;
      }),
    ).rejects.toBe(boom);
    const before = log.length;
    await expect(captured.query("SELECT LATE")).rejects.toBeInstanceOf(GuardedClientClosedError);
    expect(log).toHaveLength(before);
  });

  it("an orphaned statement still queued behind a slow one when the work fails never runs", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const { client, log } = fakeClient(async (sql) => {
      if (sql === "SELECT SLOW") await slow;
      return { rows: [] };
    });
    let orphan!: Promise<unknown>;
    const work = d.runGuarded(client, async (c) => {
      void c.query("SELECT SLOW").catch(() => undefined);
      orphan = c.query("SELECT ORPHAN"); // queued behind SELECT SLOW, never awaited by the work
      orphan.catch(() => undefined);
      throw new Error("another branch failed");
    });
    await expect(work).rejects.toThrow("another branch failed");
    releaseSlow();
    await expect(orphan).rejects.toBeInstanceOf(GuardedClientClosedError);
    expect(log.map((l) => l.sql)).not.toContain("SELECT ORPHAN");
  });

  it("a closed guard is not a deadline refusal: the service does not rewrite it", () => {
    expect(isDeadlineTimeoutError(new GuardedClientClosedError())).toBe(false);
  });

  it("each runGuarded call gets its own guard (a later use of the same deadline object starts open)", async () => {
    const clock = new FakeClock();
    const d = new CommitDeadline(clock.now(), clock);
    const { client } = fakeClient();
    await d.runGuarded(client, async () => undefined);
    await expect(d.runGuarded(client, async (c) => c.query("SELECT 2"))).resolves.toBeDefined();
  });
});

describe("isDeadlineTimeoutError — the Postgres signals of an expired budget", () => {
  it("is true for 57014 (statement_timeout) and 55P03 (lock_timeout), also behind a cause", () => {
    expect(isDeadlineTimeoutError(Object.assign(new Error("x"), { code: "57014" }))).toBe(true);
    expect(isDeadlineTimeoutError(Object.assign(new Error("x"), { code: "55P03" }))).toBe(true);
    expect(isDeadlineTimeoutError(new Error("wrapped", { cause: { code: "55P03" } }))).toBe(true);
  });

  it("is true for our own ReturnDeadlineExceededError", () => {
    expect(isDeadlineTimeoutError(new ReturnDeadlineExceededError())).toBe(true);
  });

  it("is false for other errors, other codes and non-errors", () => {
    expect(isDeadlineTimeoutError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isDeadlineTimeoutError(new Error("plain"))).toBe(false);
    expect(isDeadlineTimeoutError(null)).toBe(false);
    expect(isDeadlineTimeoutError("57014")).toBe(false);
  });
});

describe("the receipt stamp", () => {
  it("the middleware stamps a deadline whose clock starts at receipt, before any guard runs", () => {
    const clock = new FakeClock();
    const mw = new ReturnCommitDeadlineMiddleware(clock);
    const req: Record<string, unknown> = {};
    const next = jest.fn();
    mw.use(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    clock.advance(9_000);
    const d = commitDeadlineOf(req);
    expect(d.remainingMs()).toBe(RETURN_COMMIT_BUDGET_MS - 9_000);
  });

  it("commitDeadlineOf returns the stamped deadline itself", () => {
    const clock = new FakeClock();
    const mw = new ReturnCommitDeadlineMiddleware(clock);
    const req: Record<string, unknown> = {};
    mw.use(req, {}, jest.fn());
    expect(commitDeadlineOf(req)).toBe(commitDeadlineOf(req));
  });

  it("a request nobody stamped (a direct call) gets a fresh, full budget: fail closed, never unbounded", () => {
    const d = commitDeadlineOf({});
    expect(d.remainingMs()).toBeGreaterThan(RETURN_COMMIT_BUDGET_MS - 1_000);
    expect(d.remainingMs()).toBeLessThanOrEqual(RETURN_COMMIT_BUDGET_MS);
  });

  it("the default clock is monotonic: a wall-clock step does not move the deadline", () => {
    const d = CommitDeadline.startingNow();
    const spy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    expect(d.remainingMs()).toBeGreaterThan(RETURN_COMMIT_BUDGET_MS - 1_000);
    spy.mockRestore();
  });
});
