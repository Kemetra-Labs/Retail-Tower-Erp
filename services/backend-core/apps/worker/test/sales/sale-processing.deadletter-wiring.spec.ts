/**
 * RT-1233 — the sale-processing failure branch feeds the dead-letter producer.
 *
 * Docker-free half (the real-Postgres half, incl. the Console read model, is
 * `apps/api/test/catalog/sale-sync-ops/sale-processing-deadletter.integration.spec.ts`):
 *   - a caught processing error maps to a §8 condition: a deterministic data
 *     error (SQLSTATE class 22 / 23, not 23505) is VALIDATION_FAILURE, anything
 *     else is TRANSIENT;
 *   - the processor hands that condition to the producer, rethrows the ORIGINAL
 *     error for a retryable failure (BullMQ backs off) and a
 *     SaleProcessingQuarantinedError for a quarantined one; a failed recording
 *     never masks the original error;
 *   - the producer's `recordProcessingFailure`: needs-repair → one dead-letter
 *     row + status; transient → a status-only `failed-retryable` write guarded
 *     against `synced` / `failed-needs-repair`, and NO dead-letter row; a synced
 *     or absent sale is left alone;
 *   - SaleWorker turns a quarantined failure into BullMQ's UnrecoverableError;
 *   - WorkerModule wires the producer into the processor.
 */
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  ...jest.requireActual("@data-pulse-2/db"),
  runWithTenantContext: (
    _pool: unknown,
    _ctx: unknown,
    fn: (c: { query: jest.Mock }) => unknown,
  ) => fn({ query: clientQuery }),
}));

import { Test } from "@nestjs/testing";
import { UnrecoverableError } from "bullmq";
import type { Pool } from "pg";

import {
  SaleProcessingQuarantinedError,
  syncFailureConditionOf,
} from "../../src/sales/sale-processing-failure";
import {
  SaleProcessingNotFoundError,
  SaleProcessingProcessor,
  type SaleProcessingJob,
} from "../../src/sales/sale-processing.processor";
import { SaleSyncDeadletterProducer } from "../../src/sales/sale-sync-deadletter.producer";
import { SYNC_FAILURE_CONDITION } from "../../src/sales/sale-sync-failure-classifier";
import { SaleWorker, type JobLike, type WorkerFactory, type WorkerLike } from "../../src/sales/sale.worker";
import { WorkerModule } from "../../src/worker.module";

const JOB: SaleProcessingJob = {
  saleId: "5a1e0000-0000-7000-8000-0000000123d1",
  tenantId: "5a1e0000-0000-7000-8000-0000000123a1",
  storeId: "5a1e0000-0000-7000-8000-0000000123b1",
  correlationId: "free-text-corr",
};

/** A pg-style error carrying a SQLSTATE, like `pg`'s DatabaseError. */
function pgError(code: string): Error {
  return Object.assign(new Error(`forced ${code}`), { code });
}

/**
 * A pool for a processor whose first query fails with `err`, so `process()`
 * reaches its catch (`runWithTenantContext` is mocked onto `clientQuery`).
 */
function failingPool(err: Error): Pool {
  clientQuery = jest.fn().mockRejectedValue(err);
  return {} as Pool;
}

describe("RT-1233 syncFailureConditionOf — error → §8 condition", () => {
  it.each(["22023", "22P02", "22003", "23514", "23502", "23503"])(
    "a deterministic data error (%s) is VALIDATION_FAILURE",
    (code) => {
      expect(syncFailureConditionOf(pgError(code))).toBe(SYNC_FAILURE_CONDITION.VALIDATION_FAILURE);
    },
  );

  it.each(["23505", "40001", "40P01", "57P01", "08006", "53300", "42P01"])(
    "anything else (%s) is TRANSIENT",
    (code) => {
      expect(syncFailureConditionOf(pgError(code))).toBe(SYNC_FAILURE_CONDITION.TRANSIENT);
    },
  );

  it("a non-pg error, a lost claim and a non-Error are TRANSIENT", () => {
    expect(syncFailureConditionOf(new Error("connect ECONNREFUSED"))).toBe(SYNC_FAILURE_CONDITION.TRANSIENT);
    expect(syncFailureConditionOf(new SaleProcessingNotFoundError())).toBe(SYNC_FAILURE_CONDITION.TRANSIENT);
    expect(syncFailureConditionOf("boom")).toBe(SYNC_FAILURE_CONDITION.TRANSIENT);
    expect(syncFailureConditionOf(Object.assign(new Error("x"), { code: 42 }))).toBe(
      SYNC_FAILURE_CONDITION.TRANSIENT,
    );
  });
});

describe("RT-1233 SaleProcessingProcessor failure branch", () => {
  it("quarantined → rejects with SaleProcessingQuarantinedError carrying the original cause", async () => {
    const original = pgError("23514");
    const record = jest.fn().mockResolvedValue("quarantined");
    const processor = new SaleProcessingProcessor(failingPool(original), undefined, {
      recordProcessingFailure: record,
    });

    const err = await processor.process(JOB).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SaleProcessingQuarantinedError);
    expect((err as SaleProcessingQuarantinedError).cause).toBe(original);
    expect(record).toHaveBeenCalledWith({
      saleId: JOB.saleId,
      tenantId: JOB.tenantId,
      storeId: JOB.storeId,
      condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
      correlationId: JOB.correlationId,
    });
  });

  it("retryable → rethrows the ORIGINAL error so BullMQ backs off", async () => {
    const original = pgError("40001");
    const record = jest.fn().mockResolvedValue("retryable");
    const processor = new SaleProcessingProcessor(failingPool(original), undefined, {
      recordProcessingFailure: record,
    });

    await expect(processor.process(JOB)).rejects.toBe(original);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ condition: SYNC_FAILURE_CONDITION.TRANSIENT }));
  });

  it("skipped (synced / absent sale) → rethrows the original error", async () => {
    const original = pgError("23514");
    const processor = new SaleProcessingProcessor(failingPool(original), undefined, {
      recordProcessingFailure: jest.fn().mockResolvedValue("skipped"),
    });
    await expect(processor.process(JOB)).rejects.toBe(original);
  });

  it("a failed recording is logged (ids + class only) and never masks the original error", async () => {
    const original = pgError("23514");
    const error = jest.fn();
    const processor = new SaleProcessingProcessor(failingPool(original), { error }, {
      recordProcessingFailure: jest.fn().mockRejectedValue(new Error("db down password=secret")),
    });

    await expect(processor.process(JOB)).rejects.toBe(original);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1]![0]).toMatchObject({
      job_name: "sale-processing",
      sale_id: JOB.saleId,
      tenant_id: JOB.tenantId,
      store_id: JOB.storeId,
      error_class: "Error",
    });
    expect(error.mock.calls[1]![1]).toBe("sale sync failure not recorded");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });

  it("a malformed job is rejected before the failure branch (nothing recorded)", async () => {
    const record = jest.fn();
    const processor = new SaleProcessingProcessor(failingPool(new Error("x")), undefined, {
      recordProcessingFailure: record,
    });
    await expect(processor.process({ ...JOB, saleId: "not-a-uuid" })).rejects.toThrow(/saleId/);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("RT-1233 SaleSyncDeadletterProducer.recordProcessingFailure", () => {
  const SALE_ROW = { source_system: "pos-x", external_id: "ext-1233", sync_status: "captured" };
  const input = {
    saleId: JOB.saleId,
    tenantId: JOB.tenantId,
    storeId: JOB.storeId,
    correlationId: null,
  };

  beforeEach(() => {
    clientQuery = jest.fn();
  });

  it("needs-repair: locks the sale, writes one dead-letter row with its provenance, advances status", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [SALE_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] })
      .mockResolvedValueOnce({ rows: [{ id: JOB.saleId }] });

    const outcome = await new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
      ...input,
      condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
    });

    expect(outcome).toBe("quarantined");
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0]![0]).toMatch(/FROM sales[\s\S]*FOR UPDATE/);
    expect(clientQuery.mock.calls[1]![0]).toMatch(/INSERT INTO sale_sync_deadletters/);
    expect(clientQuery.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(["needs-repair", "validation_failure", "pos-x", "ext-1233"]),
    );
    expect(clientQuery.mock.calls[2]![0]).toMatch(/UPDATE sales/);
    expect(clientQuery.mock.calls[2]![1]).toContain("failed-needs-repair");
  });

  it("needs-repair re-delivery: an open row exists → no second row, no status rewrite, still quarantined", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ ...SALE_ROW, sync_status: "failed-needs-repair" }] })
      .mockResolvedValueOnce({ rows: [] });

    const outcome = await new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
      ...input,
      condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
    });

    expect(outcome).toBe("quarantined");
    expect(clientQuery).toHaveBeenCalledTimes(2);
  });

  it("transient: a status-only failed-retryable write, guarded against synced and failed-needs-repair; no row", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [SALE_ROW] }).mockResolvedValueOnce({ rows: [{ id: JOB.saleId }] });

    const outcome = await new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
      ...input,
      condition: SYNC_FAILURE_CONDITION.TRANSIENT,
    });

    expect(outcome).toBe("retryable");
    expect(clientQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = clientQuery.mock.calls[1]! as [string, unknown[]];
    expect(sql).toMatch(/UPDATE sales/);
    expect(sql).not.toMatch(/sale_sync_deadletters/);
    expect(sql).toMatch(/sync_status_version = sync_status_version \+ 1/);
    expect(params).toEqual(
      expect.arrayContaining(["failed-retryable", "synced", "failed-needs-repair"]),
    );
    expect(clientQuery.mock.calls.some(([s]) => /INSERT INTO sale_sync_deadletters/.test(String(s)))).toBe(false);
  });

  it.each([
    ["a synced sale", [{ ...SALE_ROW, sync_status: "synced" }]],
    ["an absent / out-of-scope sale", []],
  ])("%s is left alone (only the locking read runs)", async (_label, rows) => {
    for (const condition of [SYNC_FAILURE_CONDITION.VALIDATION_FAILURE, SYNC_FAILURE_CONDITION.TRANSIENT]) {
      clientQuery = jest.fn().mockResolvedValueOnce({ rows });
      const outcome = await new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
        ...input,
        condition,
      });
      expect(outcome).toBe("skipped");
      expect(clientQuery).toHaveBeenCalledTimes(1);
    }
  });

  it("a free-text correlation id is written as null; a UUID one is kept", async () => {
    const uuid = "5a1e0000-0000-7000-8000-0000000123c1";
    for (const [given, stored] of [
      ["free-text-corr", null],
      [uuid, uuid],
    ] as const) {
      clientQuery = jest
        .fn()
        .mockResolvedValueOnce({ rows: [SALE_ROW] })
        .mockResolvedValueOnce({ rows: [{ id: "dl" }] })
        .mockResolvedValueOnce({ rows: [{ id: JOB.saleId }] });
      await new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
        ...input,
        correlationId: given,
        condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
      });
      const params = clientQuery.mock.calls[1]![1] as unknown[];
      expect(params[params.length - 1]).toBe(stored);
    }
  });

  it("rejects a malformed id before any query", async () => {
    clientQuery = jest.fn();
    await expect(
      new SaleSyncDeadletterProducer({} as Pool).recordProcessingFailure({
        ...input,
        saleId: "nope",
        condition: SYNC_FAILURE_CONDITION.TRANSIENT,
      }),
    ).rejects.toThrow(/saleId/);
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe("RT-1233 SaleWorker — a quarantined sale is not retried", () => {
  function startWith(reject: Error): (job: JobLike) => Promise<void> {
    let handler: ((job: JobLike) => Promise<void>) | undefined;
    const factory: WorkerFactory = {
      create: (_queue, h) => {
        handler = h;
        return { on: () => undefined, close: async () => undefined } as unknown as WorkerLike;
      },
    };
    const processor = {
      process: async () => {
        throw reject;
      },
    } as unknown as SaleProcessingProcessor;
    new SaleWorker(processor, factory).start();
    return handler!;
  }

  it("maps SaleProcessingQuarantinedError to BullMQ's UnrecoverableError", async () => {
    const handler = startWith(new SaleProcessingQuarantinedError(pgError("23514")));
    const err = await handler({ name: "sale-processing", data: JOB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).name).toBe("UnrecoverableError");
  });

  it("passes any other error through unchanged, so BullMQ retries it", async () => {
    const original = pgError("40001");
    const handler = startWith(original);
    await expect(handler({ name: "sale-processing", data: JOB })).rejects.toBe(original);
  });
});

describe("RT-1233 WorkerModule — the producer is registered and wired into the processor", () => {
  it("resolves SaleSyncDeadletterProducer and injects it into SaleProcessingProcessor", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];

    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const producer = moduleRef.get(SaleSyncDeadletterProducer);
    expect(producer).toBeInstanceOf(SaleSyncDeadletterProducer);
    const processor = moduleRef.get(SaleProcessingProcessor);
    expect((processor as unknown as { deadletters?: unknown }).deadletters).toBe(producer);
    await moduleRef.close();
  });
});
