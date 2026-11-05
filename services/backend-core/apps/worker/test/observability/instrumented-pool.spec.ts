/**
 * Unit tests for InstrumentedPool — the pg.Pool subclass that emits
 * `db_slow_query_total` when a query exceeds the 500 ms threshold.
 *
 * Mirrors apps/api/test/observability/instrumented-pool.spec.ts but
 * imports from the worker's own observability module so the metric is
 * registered on the worker's OTel Meter (port 9091).
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { EventEmitter } from "node:events";

import { Logger } from "@nestjs/common";
import { Pool } from "pg";

import {
  InstrumentedPool,
  hashQueryTemplate,
  SLOW_QUERY_THRESHOLD_SECONDS,
} from "../../src/observability/instrumented-pool";
import { recordDbSlowQuery } from "../../src/observability/metrics/worker.metrics";

jest.mock("../../src/observability/metrics/worker.metrics", () => ({
  recordDbSlowQuery: jest.fn(),
  registerDbPoolGauges: jest.fn().mockReturnValue({ stop: jest.fn() }),
  registerDbMigrationStatusGauge: jest.fn().mockReturnValue({ stop: jest.fn() }),
  recordDbRlsContextFailure: jest.fn(),
  recordWorkerJobDuration: jest.fn(),
  recordWorkerJobFailure: jest.fn(),
  recordRedisCommandDuration: jest.fn(),
  registerQueueLagGauge: jest.fn().mockReturnValue({ stop: jest.fn() }),
  DB_METRIC_NAMES: [],
  WORKER_METRIC_NAMES: [],
  createDbMigrationStatusCallback: jest.fn(),
}));

const mockedRecord = recordDbSlowQuery as jest.MockedFunction<typeof recordDbSlowQuery>;

// ---------------------------------------------------------------------------
// 1. hashQueryTemplate
// ---------------------------------------------------------------------------


// pg.Pool#query is heavily overloaded; spy on it through a single loose
// signature so mockResolvedValue / mockRejectedValue type-check.
const queryTarget = (): { query: (...args: unknown[]) => Promise<unknown> } =>
  Pool.prototype as unknown as { query: (...args: unknown[]) => Promise<unknown> };

describe("hashQueryTemplate", () => {
  it("returns an 8-character hex string", () => {
    const hash = hashQueryTemplate("SELECT 1");
    expect(hash).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(hash)).toBe(true);
  });

  it("is deterministic — same SQL always produces the same hash", () => {
    const sql = "SELECT * FROM users WHERE id = $1";
    expect(hashQueryTemplate(sql)).toBe(hashQueryTemplate(sql));
  });

  it("produces different hashes for different SQL templates", () => {
    expect(hashQueryTemplate("SELECT 1")).not.toBe(hashQueryTemplate("SELECT 2"));
  });

  it("handles an empty string without throwing", () => {
    expect(() => hashQueryTemplate("")).not.toThrow();
    expect(hashQueryTemplate("")).toHaveLength(8);
  });

  it("hashes the template text, not values — two queries differing only in values share the same hash", () => {
    const template = "SELECT * FROM users WHERE id = $1";
    expect(hashQueryTemplate(template)).toBe(hashQueryTemplate(template));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(): InstrumentedPool {
  return new InstrumentedPool({ connectionString: "postgres://localhost/test" });
}

// ---------------------------------------------------------------------------
// 2–5. Promise-form instrumentation
// ---------------------------------------------------------------------------

describe("InstrumentedPool.query (Promise form) — threshold gate", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy?.mockRestore();
  });

  it("does NOT emit when the query resolves below the threshold", async () => {
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await pool.query("SELECT 1");

    expect(mockedRecord).not.toHaveBeenCalled();
  });

  it("emits once when the query resolves at exactly the threshold", async () => {
    let resolveQuery!: () => void;
    superSpy = jest.spyOn(Pool.prototype, "query").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = () => resolve({ rows: [], rowCount: 0 } as any);
        }),
    );

    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000);

    const p = pool.query("SELECT 1");
    resolveQuery();
    await p;

    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("emits once when the query resolves above the threshold", async () => {
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);

    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);

    await pool.query("SELECT slow");

    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("emits and rethrows when the query rejects above the threshold", async () => {
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);

    const originalErr = new Error("connection reset");
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockRejectedValue(originalErr);

    await expect(pool.query("SELECT slow")).rejects.toBe(originalErr);
    expect(mockedRecord).toHaveBeenCalledTimes(1);

    (performance.now as jest.Mock).mockRestore();
  });

  it("does NOT emit when the query rejects below the threshold", async () => {
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockRejectedValue(new Error("fast error"));

    await expect(pool.query("SELECT 1")).rejects.toThrow("fast error");
    expect(mockedRecord).not.toHaveBeenCalled();
  });
});

describe("InstrumentedPool.query (Promise form) — query_class label", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
    jest
      .spyOn(global.performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_QUERY_THRESHOLD_SECONDS * 1000 + 1);
    superSpy = jest
      .spyOn(queryTarget(), "query")
      .mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  afterEach(() => {
    superSpy.mockRestore();
    (performance.now as jest.Mock).mockRestore();
  });

  it("records the correct hash of the SQL template string", async () => {
    const sql = "SELECT * FROM users WHERE id = $1";
    await pool.query(sql, ["abc"]);
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(sql),
    });
  });

  it("uses QueryConfig.text when a config object is passed", async () => {
    const sql = "SELECT * FROM sessions WHERE token = $1";
    await pool.query({ text: sql, values: ["tok"] });
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(sql),
    });
  });

  it("falls back to an empty-string hash when QueryConfig has no .text", async () => {
    await pool.query({ text: "" });
    expect(mockedRecord).toHaveBeenCalledWith({
      query_class: hashQueryTemplate(""),
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Callback-form passthrough
// ---------------------------------------------------------------------------

describe("InstrumentedPool.query (callback form) — passthrough", () => {
  let pool: InstrumentedPool;
  let superSpy: jest.SpyInstance;

  beforeEach(() => {
    pool = makePool();
    mockedRecord.mockClear();
  });

  afterEach(() => {
    superSpy?.mockRestore();
  });

  it("does not call recordDbSlowQuery when the callback form is used", (done) => {
    superSpy = jest
      .spyOn(Pool.prototype, "query")
      .mockImplementation((_sql: any, cb: any) => {
        cb(null, { rows: [], rowCount: 0 });
      });

    pool.query("SELECT 1", (err) => {
      expect(err).toBeNull();
      expect(mockedRecord).not.toHaveBeenCalled();
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// RT-1246 — a dropped connection does not crash the process (Sentry BACKEND-CORE-7)
// ---------------------------------------------------------------------------

/**
 * A socket-less pg client, so pg-pool's real checkout/release path runs: pg-pool
 * builds it through the `Client` option, listens on it while idle and removes
 * that listener at checkout.
 */
class FakeClient extends EventEmitter {
  /** pg-pool returns a released client to the idle list only when it is queryable. */
  _queryable = true;
  connect(cb: (err?: Error) => void): void {
    cb();
  }
  end(cb?: () => void): Promise<void> {
    cb?.();
    return Promise.resolve();
  }
  query(): Promise<{ rows: never[] }> {
    return Promise.resolve({ rows: [] });
  }
}

const terminated = (): Error =>
  Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });

describe("InstrumentedPool — dropped connection (RT-1246, Sentry BACKEND-CORE-7)", () => {
  let warn: jest.SpyInstance;
  let pool: InstrumentedPool;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    pool = new InstrumentedPool({ Client: FakeClient as never, max: 1 });
  });

  afterEach(async () => {
    await pool.end();
    jest.restoreAllMocks();
  });

  it("a checked-out client's error (a restart mid-transaction) does not throw", async () => {
    const client = await pool.connect();

    expect(() => client.emit("error", terminated())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SQLSTATE 57P01");
    client.release(true);
  });

  it("an idle client's error, re-emitted on the pool by pg-pool, does not throw and logs once", async () => {
    const client = await pool.connect();
    client.release();
    expect(pool.idleCount).toBe(1); // back in the idle list, under pg-pool's idle listener

    expect(() => client.emit("error", terminated())).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(pool.totalCount).toBe(0); // pg-pool dropped the dead client
  });
});
