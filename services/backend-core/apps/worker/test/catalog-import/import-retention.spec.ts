/**
 * RT-1503 (spec 049 S2) — catalogue import expiry and retention job:
 * Docker-free unit tier.
 *
 * Covers the interval config, the processor's orchestration over a fake
 * repository (every tenant, expiry before purge, bounded passes, per-tenant
 * failure isolation, count-only logging, job validation), the BullMQ worker
 * glue and scheduler, and the WorkerModule provider factory / DI graph.
 *
 * The SQL (the §8.1 conditional expiry and its audit row, the OD-6 windows,
 * the count assertion, RLS and grants) is proven against real Postgres in
 * import-retention.integration.spec.ts; the policy in
 * import-retention.policy.spec.ts.
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Test } from "@nestjs/testing";
import { Queue } from "bullmq";
import type { Pool } from "pg";
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

import {
  DEFAULT_EXPIRY_BATCH_LIMIT,
  DEFAULT_IMPORT_RETENTION_INTERVAL_MS,
  DEFAULT_PURGE_BATCH_LIMIT,
  IMPORT_RETENTION_INTERVAL_ENV,
  MIN_IMPORT_RETENTION_INTERVAL_MS,
  resolveImportRetentionIntervalMs,
} from "../../src/catalog-import/import-retention.config";
import {
  IMPORT_RETENTION_JOB_NAME,
  ImportRetentionIncompleteError,
  ImportRetentionProcessor,
  MalformedImportRetentionJobError,
  UnknownImportRetentionJobError,
  type ImportRetentionLogLine,
} from "../../src/catalog-import/import-retention.processor";
import {
  ImportPurgeCountMismatchError,
  NoOpImportRetentionRepository,
  PgImportRetentionRepository,
  type ExpiryPass,
  type ImportRetentionRepository,
  type PurgePass,
} from "../../src/catalog-import/import-retention.repository";
import { ImportRetentionScheduler } from "../../src/catalog-import/import-retention.scheduler";
import {
  IMPORT_RETENTION_QUEUE_NAME,
  ImportRetentionWorker,
} from "../../src/catalog-import/import-retention.worker";
import type { JobLike, WorkerFactory, WorkerLike } from "../../src/email/email.worker";
import { AuditDbPool, WorkerModule, importRetentionProcessorProviderFactory } from "../../src/worker.module";

const HOUR = 60 * 60 * 1000;
const TENANT_A = "01240000-0000-7000-8000-00000015030a";
const TENANT_B = "01240000-0000-7000-8000-00000015030b";
const TENANT_C = "01240000-0000-7000-8000-00000015030c";

const SAVED_ENV = Object.fromEntries(
  [IMPORT_RETENTION_INTERVAL_ENV, "NODE_ENV", "REDIS_URL", "DATABASE_URL"].map((k) => [k, process.env[k]]),
);

afterEach(() => {
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("RT-1503 import retention config", () => {
  it("defaults to hourly when unset or blank", () => {
    expect(DEFAULT_IMPORT_RETENTION_INTERVAL_MS).toBe(HOUR);
    expect(resolveImportRetentionIntervalMs({})).toBe(HOUR);
    expect(resolveImportRetentionIntervalMs({ [IMPORT_RETENTION_INTERVAL_ENV]: "   " })).toBe(HOUR);
  });

  it("accepts a whole number of milliseconds at or above one minute", () => {
    expect(MIN_IMPORT_RETENTION_INTERVAL_MS).toBe(60_000);
    expect(resolveImportRetentionIntervalMs({ [IMPORT_RETENTION_INTERVAL_ENV]: "60000" })).toBe(60_000);
    expect(resolveImportRetentionIntervalMs({ [IMPORT_RETENTION_INTERVAL_ENV]: " 1800000 " })).toBe(1_800_000);
  });

  it.each(["59999", "0", "-1", "1h", "3600000.5", "1e7", "later"])("refuses %p and names the variable", (raw) => {
    expect(() => resolveImportRetentionIntervalMs({ [IMPORT_RETENTION_INTERVAL_ENV]: raw })).toThrow(
      IMPORT_RETENTION_INTERVAL_ENV,
    );
  });

  it("reads process.env by default", () => {
    process.env[IMPORT_RETENTION_INTERVAL_ENV] = "120000";
    expect(resolveImportRetentionIntervalMs()).toBe(120_000);
  });

  it("bounds each transaction: 100 expiries or 10 purged batches", () => {
    expect(DEFAULT_EXPIRY_BATCH_LIMIT).toBe(100);
    expect(DEFAULT_PURGE_BATCH_LIMIT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

interface TenantState {
  due: number;
  purgeable: number[];
}

type Call = { kind: "expire" | "purge"; tenantId: string; limit: number };

/** In-memory stand-in: per tenant, N batches due to expire and the row counts of batches due for the purge. */
class FakeRepo implements ImportRetentionRepository {
  readonly calls: Call[] = [];
  constructor(
    readonly tenants: Map<string, TenantState>,
    private readonly failing: ReadonlySet<string> = new Set(),
    private readonly failingPurge: ReadonlySet<string> = new Set(),
  ) {}

  private fail(tenantId: string): never {
    const err = new Error(`batch of ${tenantId} broke`);
    (err as Error & { code?: string }).code = "40P01";
    throw err;
  }

  async listTenantIds(): Promise<string[]> {
    return [...this.tenants.keys()];
  }

  async expireDueBatches(tenantId: string, limit: number): Promise<ExpiryPass> {
    this.calls.push({ kind: "expire", tenantId, limit });
    if (this.failing.has(tenantId)) this.fail(tenantId);
    const t = this.tenants.get(tenantId)!;
    const n = Math.min(t.due, limit);
    t.due -= n;
    // An expired batch starts its 30 days now: it is not purgeable in this run.
    return { picked: n, expired: n };
  }

  async purgeDueRows(tenantId: string, limit: number): Promise<PurgePass> {
    this.calls.push({ kind: "purge", tenantId, limit });
    if (this.failingPurge.has(tenantId)) this.fail(tenantId);
    const t = this.tenants.get(tenantId)!;
    const taken = t.purgeable.splice(0, limit);
    return { batches: taken.length, rows: taken.reduce((a, b) => a + b, 0) };
  }
}

function tenants(entries: Array<[string, number, number[]]>): Map<string, TenantState> {
  return new Map(entries.map(([id, due, purgeable]) => [id, { due, purgeable: [...purgeable] }]));
}

function processor(
  repo: ImportRetentionRepository,
  lines: ImportRetentionLogLine[] = [],
  limits = { expiryBatchLimit: 2, purgeBatchLimit: 2 },
): ImportRetentionProcessor {
  return new ImportRetentionProcessor(repo, limits, (line) => lines.push(line));
}

describe("RT-1503 ImportRetentionProcessor", () => {
  it("expires and purges for EVERY tenant, expiry before purge", async () => {
    const repo = new FakeRepo(tenants([[TENANT_A, 1, [3]], [TENANT_B, 0, [5, 7]], [TENANT_C, 2, []]]));
    const result = await processor(repo).process(IMPORT_RETENTION_JOB_NAME, {});

    expect(result).toMatchObject({ tenants: 3, expired: 3, purgedBatches: 3, purgedRows: 15, failedTenants: 0 });
    for (const id of [TENANT_A, TENANT_B, TENANT_C]) {
      const kinds = repo.calls.filter((c) => c.tenantId === id).map((c) => c.kind);
      expect(kinds[0]).toBe("expire");
      expect(kinds).toContain("purge");
      expect(kinds.lastIndexOf("expire")).toBeLessThan(kinds.indexOf("purge"));
    }
  });

  it("drains in bounded passes: a full pass asks again, a short pass ends the step", async () => {
    const repo = new FakeRepo(tenants([[TENANT_A, 5, [1, 1, 1, 1]]]));
    const result = await processor(repo).process(IMPORT_RETENTION_JOB_NAME, {});

    expect(repo.calls.every((c) => c.limit === 2)).toBe(true);
    // expiry 2 + 2 + 1; purge 2 + 2 + 0.
    expect(repo.calls.map((c) => c.kind)).toEqual(["expire", "expire", "expire", "purge", "purge", "purge"]);
    expect(result).toMatchObject({ expired: 5, purgedBatches: 4, purgedRows: 4, passes: 6 });
  });

  it("stops the expiry step when a full pass expires nothing (never spins)", async () => {
    const stuck: ImportRetentionRepository = {
      listTenantIds: async () => [TENANT_A],
      expireDueBatches: jest.fn(async () => ({ picked: 2, expired: 0 })),
      purgeDueRows: async () => ({ batches: 0, rows: 0 }),
    };
    const result = await processor(stuck).process(IMPORT_RETENTION_JOB_NAME, {});
    expect(stuck.expireDueBatches).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ expired: 0, passes: 2 });
  });

  it("uses the configured limits by default", async () => {
    const repo = new FakeRepo(tenants([[TENANT_A, 0, []]]));
    await new ImportRetentionProcessor(repo, undefined, () => undefined).process(IMPORT_RETENTION_JOB_NAME, {});
    expect(repo.calls).toEqual([
      { kind: "expire", tenantId: TENANT_A, limit: DEFAULT_EXPIRY_BATCH_LIMIT },
      { kind: "purge", tenantId: TENANT_A, limit: DEFAULT_PURGE_BATCH_LIMIT },
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a limit of %p", (limit) => {
    const repo = new NoOpImportRetentionRepository();
    expect(() => processor(repo, [], { expiryBatchLimit: limit, purgeBatchLimit: 1 })).toThrow(/expiry batch limit/);
    expect(() => processor(repo, [], { expiryBatchLimit: 1, purgeBatchLimit: limit })).toThrow(/purge batch limit/);
  });

  it("no tenants is an empty, successful run", async () => {
    const result = await processor(new NoOpImportRetentionRepository()).process(IMPORT_RETENTION_JOB_NAME, {});
    expect(result).toMatchObject({ tenants: 0, expired: 0, purgedBatches: 0, purgedRows: 0, passes: 0 });
  });

  it("a failing tenant does not stop the others; the job then fails so BullMQ retries", async () => {
    const lines: ImportRetentionLogLine[] = [];
    const repo = new FakeRepo(
      tenants([[TENANT_A, 1, [2]], [TENANT_B, 1, [2]], [TENANT_C, 1, [2]]]),
      new Set([TENANT_B]),
    );
    const err = await processor(repo, lines).process(IMPORT_RETENTION_JOB_NAME, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportRetentionIncompleteError);
    expect((err as ImportRetentionIncompleteError).result).toMatchObject({
      tenants: 3,
      expired: 2,
      // B's expiry failed, but its purge still ran.
      purgedBatches: 3,
      failedTenants: 1,
    });
    expect(lines.find((l) => l["message"] === "tenant_retention_failed")).toMatchObject({
      level: "error",
      step: "expiry",
      errorName: "Error",
      errorCode: "40P01",
    });
  });

  it("an expiry failure does not skip that tenant's purge; the job still fails so BullMQ retries", async () => {
    const lines: ImportRetentionLogLine[] = [];
    const repo = new FakeRepo(tenants([[TENANT_A, 1, [4]]]), new Set([TENANT_A]));
    const err = await processor(repo, lines).process(IMPORT_RETENTION_JOB_NAME, {}).catch((e: unknown) => e);

    expect(repo.calls.map((c) => c.kind)).toEqual(["expire", "purge"]);
    expect(err).toBeInstanceOf(ImportRetentionIncompleteError);
    expect((err as ImportRetentionIncompleteError).result).toMatchObject({
      tenants: 1,
      expired: 0,
      purgedBatches: 1,
      purgedRows: 4,
      failedTenants: 1,
    });
    expect(lines.filter((l) => l["message"] === "tenant_retention_failed")).toEqual([
      expect.objectContaining({ level: "error", step: "expiry" }),
    ]);
  });

  it("a purge failure is logged with its step and fails the job; both steps failing counts the tenant once", async () => {
    const lines: ImportRetentionLogLine[] = [];
    const repo = new FakeRepo(
      tenants([[TENANT_A, 1, [4]], [TENANT_B, 1, [2]]]),
      new Set([TENANT_B]),
      new Set([TENANT_A, TENANT_B]),
    );
    const err = await processor(repo, lines).process(IMPORT_RETENTION_JOB_NAME, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ImportRetentionIncompleteError);
    expect((err as ImportRetentionIncompleteError).result).toMatchObject({
      tenants: 2,
      expired: 1,
      purgedBatches: 0,
      failedTenants: 2,
    });
    expect(lines.filter((l) => l["message"] === "tenant_retention_failed").map((l) => l["step"])).toEqual([
      "purge",
      "expiry",
      "purge",
    ]);
  });

  it("a failing tenant listing fails the job", async () => {
    const repo: ImportRetentionRepository = {
      listTenantIds: async () => {
        throw new Error("boom");
      },
      expireDueBatches: async () => ({ picked: 0, expired: 0 }),
      purgeDueRows: async () => ({ batches: 0, rows: 0 }),
    };
    await expect(processor(repo).process(IMPORT_RETENTION_JOB_NAME, {})).rejects.toThrow("boom");
  });

  it("logs counts only: no tenant id, no error message", async () => {
    const lines: ImportRetentionLogLine[] = [];
    const repo = new FakeRepo(tenants([[TENANT_A, 1, [4]], [TENANT_B, 1, []]]), new Set([TENANT_B]));
    await processor(repo, lines).process(IMPORT_RETENTION_JOB_NAME, {}).catch(() => undefined);

    expect(lines.find((l) => l["message"] === "retention_complete")).toEqual({
      level: "warn",
      component: "catalog-import.retention",
      message: "retention_complete",
      tenants: 2,
      expired: 1,
      purged_batches: 1,
      purged_rows: 4,
      // A: expiry + purge; B: its failed expiry, then its (empty) purge still runs.
      passes: 3,
      failed_tenants: 1,
      duration_ms: expect.any(Number),
    });
    const rendered = JSON.stringify(lines);
    expect(rendered).not.toContain(TENANT_A);
    expect(rendered).not.toContain(TENANT_B);
    expect(rendered).not.toContain("broke");
  });

  it("a clean run logs its summary at info, to stderr by default", async () => {
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    await new ImportRetentionProcessor(new NoOpImportRetentionRepository()).process(IMPORT_RETENTION_JOB_NAME, {});
    expect(write).toHaveBeenCalledWith(expect.stringContaining("\"retention_complete\""));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("\"level\":\"info\""));
    write.mockRestore();
  });

  it("rejects another job name and a non-object payload, and tolerates BullMQ metadata", async () => {
    const p = processor(new NoOpImportRetentionRepository());
    await expect(p.process("cashier-admission-replay-purge", {})).rejects.toBeInstanceOf(
      UnknownImportRetentionJobError,
    );
    await expect(p.process(IMPORT_RETENTION_JOB_NAME, null)).rejects.toBeInstanceOf(MalformedImportRetentionJobError);
    await expect(p.process(IMPORT_RETENTION_JOB_NAME, 7)).rejects.toBeInstanceOf(MalformedImportRetentionJobError);
    await expect(p.process(IMPORT_RETENTION_JOB_NAME, { repeatJobKey: "k" })).resolves.toMatchObject({ tenants: 0 });
  });

  it("pins the job name", () => {
    expect(IMPORT_RETENTION_JOB_NAME).toBe("catalog-import-retention");
  });
});

// ---------------------------------------------------------------------------
// Repository: the purge count assertion (rolled back on a mismatch)
// ---------------------------------------------------------------------------

/** A pool whose one client answers the purge statements from a script and records every statement. */
function scriptedPool(answers: { picked: string[]; counted: number; deleted: number; stamped: number }): {
  pool: Pool;
  statements: string[];
} {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      const text = sql.trim();
      statements.push(text.split(/\s+/).slice(0, 2).join(" "));
      if (text.startsWith("SELECT id")) return { rows: answers.picked.map((id) => ({ id })), rowCount: answers.picked.length };
      if (text.startsWith("SELECT count")) return { rows: [{ n: answers.counted }], rowCount: 1 };
      if (text.startsWith("DELETE")) return { rows: [], rowCount: answers.deleted };
      if (text.startsWith("UPDATE")) return { rows: [], rowCount: answers.stamped };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

describe("RT-1503 PgImportRetentionRepository purge counts", () => {
  const two = ["b1", "b2"];

  it("returns the stamped batches and deleted rows when the counts agree", async () => {
    const { pool, statements } = scriptedPool({ picked: two, counted: 7, deleted: 7, stamped: 2 });
    await expect(new PgImportRetentionRepository(pool).purgeDueRows(TENANT_A, 10)).resolves.toEqual({ batches: 2, rows: 7 });
    expect(statements[statements.length - 1]).toBe("COMMIT");
  });

  it("rolls back when the DELETE removes another number of rows than were counted", async () => {
    const { pool, statements } = scriptedPool({ picked: two, counted: 7, deleted: 6, stamped: 2 });
    await expect(new PgImportRetentionRepository(pool).purgeDueRows(TENANT_A, 10)).rejects.toThrow(
      ImportPurgeCountMismatchError,
    );
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("rolls back when the stamp does not cover every picked batch", async () => {
    const { pool, statements } = scriptedPool({ picked: two, counted: 7, deleted: 7, stamped: 1 });
    await expect(new PgImportRetentionRepository(pool).purgeDueRows(TENANT_A, 10)).rejects.toThrow(/batches mismatch/);
    expect(statements).toContain("ROLLBACK");
  });

  it("a pass that picks nothing deletes and stamps nothing", async () => {
    const { pool, statements } = scriptedPool({ picked: [], counted: 0, deleted: 0, stamped: 0 });
    await expect(new PgImportRetentionRepository(pool).purgeDueRows(TENANT_A, 10)).resolves.toEqual({ batches: 0, rows: 0 });
    expect(statements.some((s) => s.startsWith("DELETE") || s.startsWith("UPDATE"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker glue and scheduler
// ---------------------------------------------------------------------------

class FakeWorker implements WorkerLike {
  readonly errorListeners: Array<(err: Error) => void> = [];
  closed = 0;
  on(_event: "error", listener: (err: Error) => void): unknown {
    this.errorListeners.push(listener);
    return this;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeWorkerFactory implements WorkerFactory {
  readonly calls: Array<{ queueName: string; handler: (job: JobLike) => Promise<void>; options: DefaultWorkerOptionsShape }> = [];
  readonly workers: FakeWorker[] = [];
  create(queueName: string, handler: (job: JobLike) => Promise<void>, options: DefaultWorkerOptionsShape): WorkerLike {
    this.calls.push({ queueName, handler, options });
    const w = new FakeWorker();
    this.workers.push(w);
    return w;
  }
}

describe("RT-1503 ImportRetentionWorker and scheduler", () => {
  it("consumes the shared catalog-import-retention queue with the default worker options", () => {
    expect(IMPORT_RETENTION_QUEUE_NAME).toBe(QUEUE_NAMES.catalogImportRetention);
    expect(IMPORT_RETENTION_QUEUE_NAME).toBe("catalog-import-retention");
    const factory = new FakeWorkerFactory();
    const worker = new ImportRetentionWorker(processor(new NoOpImportRetentionRepository()), factory);
    worker.start();
    worker.start();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
  });

  it("delegates each job to the processor and logs worker errors by class only", async () => {
    const factory = new FakeWorkerFactory();
    const p = processor(new NoOpImportRetentionRepository());
    const spy = jest.spyOn(p, "process");
    const logged: unknown[] = [];
    const logger = { error: (obj: unknown) => void logged.push(obj) };
    new ImportRetentionWorker(p, factory, logger as never).start();
    await factory.calls[0]!.handler({ name: IMPORT_RETENTION_JOB_NAME, data: {} });
    expect(spy).toHaveBeenCalledWith(IMPORT_RETENTION_JOB_NAME, {});

    const err = new Error("connect ECONNREFUSED redis://:s3cret@redis:6379");
    err.name = "RedisConnectionError";
    factory.workers[0]!.errorListeners[0]!(err);
    expect(JSON.stringify(logged)).toContain("RedisConnectionError");
    expect(JSON.stringify(logged)).not.toContain("s3cret");
  });

  it("registers one hourly job scheduler with retries", async () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env[IMPORT_RETENTION_INTERVAL_ENV];
    await new ImportRetentionScheduler().onModuleInit();
    const MockQueue = Queue as unknown as jest.Mock;
    expect(MockQueue).toHaveBeenCalledWith("catalog-import-retention", {
      connection: { url: "redis://localhost:6379" },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    const upsert = MockQueue.mock.results[0]!.value.upsertJobScheduler as jest.Mock;
    expect(upsert).toHaveBeenCalledWith(
      "catalog-import-retention",
      { every: HOUR },
      { name: "catalog-import-retention", data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
  });

  it("refuses to schedule in production without Redis", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(new ImportRetentionScheduler().onModuleInit()).rejects.toThrow(
      "ImportRetentionScheduler: REDIS_URL is required in production",
    );
  });
});

// ---------------------------------------------------------------------------
// WorkerModule wiring
// ---------------------------------------------------------------------------

describe("RT-1503 WorkerModule wiring", () => {
  it("the provider factory picks the NoOp repo without a pool and the Pg repo with one", () => {
    const noDb = importRetentionProcessorProviderFactory(new AuditDbPool(null));
    expect((noDb as unknown as { repo: unknown }).repo).toBeInstanceOf(NoOpImportRetentionRepository);
    const fakePool = { end: async (): Promise<void> => undefined } as unknown as Pool;
    const withDb = importRetentionProcessorProviderFactory(new AuditDbPool(fakePool));
    expect((withDb as unknown as { repo: unknown }).repo).toBeInstanceOf(PgImportRetentionRepository);
  });

  it("resolves the processor and worker in the dev / no-Redis / no-DB path", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    delete process.env["DATABASE_URL"];
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(ImportRetentionProcessor)).toBeInstanceOf(ImportRetentionProcessor);
    const worker = moduleRef.get(ImportRetentionWorker);
    expect(() => worker.start()).not.toThrow();
    await worker.close();
    await moduleRef.close();
  });
});
