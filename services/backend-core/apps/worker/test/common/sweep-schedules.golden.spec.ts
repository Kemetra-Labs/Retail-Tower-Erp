/**
 * RT-1210 — golden record of the six sweep registrations, written from the
 * pre-refactor schedulers. Pins queue names, job names, `upsertJobScheduler`
 * ids/intervals/templates and the queue options, so the shared base cannot
 * drift from what the per-queue schedulers registered. BullMQ's Queue is
 * mocked; no Redis connection is attempted.
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import { ReservationSweepScheduler } from "../../src/ai-usage/reservation-sweep.scheduler";
import { ProvisioningSweepScheduler } from "../../src/erp-provisioning/provisioning-sweep.scheduler";
import { AuditRetentionScheduler } from "../../src/audit/audit-retention.scheduler";
import { ReplayPurgeScheduler } from "../../src/cashier-admissions/replay-purge.scheduler";
import { StockRunSweepScheduler } from "../../src/erpnext-reconciliation/stock-run-sweep.scheduler";
import { OutboxRetentionScheduler } from "../../src/outbox/retention.scheduler";
import { SaleRedriveScheduler } from "../../src/sales/sale-redrive.scheduler";

const MockQueue = Queue as unknown as jest.Mock;
const URL = "redis://localhost:6379";
const DAY = 24 * 60 * 60 * 1000;
const INTERVAL_ENVS = [
  "CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS",
  "SALE_REDRIVE_INTERVAL_MS",
  "AI_RESERVATION_SWEEP_INTERVAL_MS",
  "ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS",
];
const SAVED = Object.fromEntries(
  ["REDIS_URL", "NODE_ENV", ...INTERVAL_ENVS].map((k) => [k, process.env[k]]),
);

beforeEach(() => {
  process.env["REDIS_URL"] = URL;
  for (const k of INTERVAL_ENVS) delete process.env[k];
  jest.useFakeTimers().setSystemTime(new Date("2026-11-05T13:30:00.000Z"));
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const RETRY_QUEUE_OPTS = { connection: { url: URL }, defaultJobOptions: DEFAULT_JOB_OPTIONS };
const PLAIN_QUEUE_OPTS = { connection: { url: URL } };

const CASES: Array<{
  name: string;
  errorMessage: string;
  make: () => { onModuleInit(): Promise<void> };
  queue: string;
  job: string;
  queueOpts: unknown;
  repeat: unknown;
  template: unknown;
}> = [
  {
    name: "audit retention",
    errorMessage:
      "AuditRetentionScheduler: REDIS_URL is required in production " +
        "(cannot schedule audit retention sweep without Redis).",
    make: () => new AuditRetentionScheduler(),
    queue: "audit-retention",
    job: "audit-retention-sweep",
    queueOpts: PLAIN_QUEUE_OPTS,
    repeat: { every: DAY },
    template: { name: "audit-retention-sweep", data: {} },
  },
  {
    name: "outbox retention",
    errorMessage:
      "OutboxRetentionScheduler: REDIS_URL is required in production " +
        "(cannot schedule outbox retention sweep without Redis).",
    make: () => new OutboxRetentionScheduler(),
    queue: "outbox-retention",
    job: "outbox-retention-sweep",
    queueOpts: PLAIN_QUEUE_OPTS,
    repeat: { every: DAY },
    template: { name: "outbox-retention-sweep", data: {} },
  },
  {
    name: "stock run sweep",
    errorMessage:
      "StockRunSweepScheduler: REDIS_URL is required in production " +
        "(cannot schedule the stock reconciliation sweep without Redis).",
    make: () => new StockRunSweepScheduler(),
    queue: "erpnext-stock-reconciliation-sweep",
    job: "erpnext-stock-reconciliation-sweep",
    queueOpts: RETRY_QUEUE_OPTS,
    // Next UTC midnight after 2026-11-05T13:30Z for the daily default.
    repeat: { every: DAY, startDate: new Date("2026-11-06T00:00:00.000Z") },
    template: {
      name: "erpnext-stock-reconciliation-sweep",
      data: {},
      opts: DEFAULT_JOB_OPTIONS,
    },
  },
  {
    name: "replay purge",
    errorMessage:
      "ReplayPurgeScheduler: REDIS_URL is required in production " +
        "(cannot schedule the cashier-admission replay purge without Redis).",
    make: () => new ReplayPurgeScheduler(),
    queue: "cashier-admission-replay-purge",
    job: "cashier-admission-replay-purge",
    queueOpts: RETRY_QUEUE_OPTS,
    repeat: { every: 60 * 60 * 1000 },
    template: { name: "cashier-admission-replay-purge", data: {}, opts: DEFAULT_JOB_OPTIONS },
  },
  {
    name: "sale re-drive",
    errorMessage:
      "SaleRedriveScheduler: REDIS_URL is required in production " +
        "(cannot schedule the sale re-drive sweep without Redis).",
    make: () => new SaleRedriveScheduler(),
    queue: "sale-redrive",
    job: "sale-redrive",
    queueOpts: RETRY_QUEUE_OPTS,
    repeat: { every: 5 * 60 * 1000 },
    template: { name: "sale-redrive", data: {}, opts: DEFAULT_JOB_OPTIONS },
  },
  {
    name: "reservation sweep",
    errorMessage:
      "ReservationSweepScheduler: REDIS_URL is required in production " +
        "(cannot schedule the AI usage reservation sweep without Redis).",
    make: () => new ReservationSweepScheduler(),
    queue: "ai-usage-reservation-sweep",
    job: "ai-usage-reservation-sweep",
    queueOpts: RETRY_QUEUE_OPTS,
    repeat: { every: 5 * 60 * 1000 },
    template: { name: "ai-usage-reservation-sweep", data: {}, opts: DEFAULT_JOB_OPTIONS },
  },
  {
    name: "ERP provisioning sweep",
    errorMessage:
      "ProvisioningSweepScheduler: REDIS_URL is required in production " +
        "(cannot schedule the ERP provisioning sweep without Redis).",
    make: () => new ProvisioningSweepScheduler(),
    queue: "erp-provisioning-sweep",
    job: "erp-provisioning-sweep",
    queueOpts: RETRY_QUEUE_OPTS,
    repeat: { every: 60 * 1000 },
    template: { name: "erp-provisioning-sweep", data: {}, opts: DEFAULT_JOB_OPTIONS },
  },
];

describe("RT-1210 sweep schedule golden record", () => {
  it.each(CASES)("$name registers exactly the pre-refactor schedule", async (c) => {
    await c.make().onModuleInit();
    expect(MockQueue).toHaveBeenCalledTimes(1);
    expect(MockQueue.mock.calls[0]).toEqual([c.queue, c.queueOpts]);
    const upsert = MockQueue.mock.results[0]!.value.upsertJobScheduler as jest.Mock;
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]).toEqual([c.job, c.repeat, c.template]);
  });

  it.each(CASES)("$name production without REDIS_URL throws its own prefix", async (c) => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(c.make().onModuleInit()).rejects.toThrow(c.errorMessage);
  });
});
