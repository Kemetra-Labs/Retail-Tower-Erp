/**
 * RT-1034 — SyncFailureAlertScheduler and config unit tests. BullMQ's Queue is mocked; no Redis.
 * Retry policy (S5): every scheduled job carries the shared attempts/backoff, so a failed delivery
 * is retried with backoff and an exhausted job stays in the failed set (the DLQ), where the worker's
 * `failed` listener reports it to Sentry.
 */
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS,
  MAX_SYNC_FAILURE_ALERT_INTERVAL_MS,
  resolveSyncFailureAlertEnabled,
  resolveSyncFailureAlertIntervalMs,
  SYNC_FAILURE_ALERT_INTERVAL_ENV,
} from "../../src/sync-failure-alert/sync-failure-alert.config";
import { SYNC_FAILURE_ALERT_JOB_NAME } from "../../src/sync-failure-alert/sync-failure-alert.processor";
import { SyncFailureAlertScheduler } from "../../src/sync-failure-alert/sync-failure-alert.scheduler";
import { SYNC_FAILURE_ALERT_QUEUE_NAME } from "../../src/sync-failure-alert/sync-failure-alert.worker";

const MockQueue = Queue as unknown as jest.Mock;
const SAVED = {
  REDIS_URL: process.env["REDIS_URL"],
  [SYNC_FAILURE_ALERT_INTERVAL_ENV]: process.env[SYNC_FAILURE_ALERT_INTERVAL_ENV],
};

afterEach(() => {
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function lastQueue(): { upsertJobScheduler: jest.Mock } {
  const r = MockQueue.mock.results[MockQueue.mock.results.length - 1];
  if (!r) throw new Error("Queue constructor was not called");
  return r.value as { upsertJobScheduler: jest.Mock };
}

describe("RT-1034 SyncFailureAlertScheduler", () => {
  it("registers one job scheduler on the alert queue every 5 minutes by default", async () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    delete process.env[SYNC_FAILURE_ALERT_INTERVAL_ENV];
    await new SyncFailureAlertScheduler().onModuleInit();
    expect(SYNC_FAILURE_ALERT_JOB_NAME).toBe(SYNC_FAILURE_ALERT_QUEUE_NAME);
    expect(MockQueue).toHaveBeenCalledWith(SYNC_FAILURE_ALERT_QUEUE_NAME, {
      connection: { url: "redis://localhost:6379" },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      SYNC_FAILURE_ALERT_JOB_NAME,
      { every: 5 * 60 * 1000 },
      { name: SYNC_FAILURE_ALERT_JOB_NAME, data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
  });

  it("S5: the job template retries with exponential backoff", async () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    await new SyncFailureAlertScheduler().onModuleInit();
    const template = lastQueue().upsertJobScheduler.mock.calls[0]![2] as {
      opts: { attempts: number; backoff: { type: string; delay: number } };
    };
    expect(template.opts.attempts).toBe(5);
    expect(template.opts.backoff).toEqual({ type: "exponential", delay: 1_000 });
  });

  it("S5: interval plus the whole BullMQ retry window stays inside the 10-minute AC3 target", () => {
    let retryWindowMs = 0;
    for (let n = 0; n < DEFAULT_JOB_OPTIONS.attempts - 1; n += 1) retryWindowMs += 1_000 * 2 ** n;
    expect(retryWindowMs).toBe(15_000);
    // The configurable maximum, not only the default, keeps the alert inside the 10-minute target.
    expect(MAX_SYNC_FAILURE_ALERT_INTERVAL_MS + retryWindowMs).toBeLessThan(10 * 60 * 1000);
    expect(DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS).toBeLessThanOrEqual(MAX_SYNC_FAILURE_ALERT_INTERVAL_MS);
  });

  it("refuses boot on an invalid interval and accepts a valid one", () => {
    expect(resolveSyncFailureAlertIntervalMs({})).toBe(DEFAULT_SYNC_FAILURE_ALERT_INTERVAL_MS);
    expect(resolveSyncFailureAlertIntervalMs({ [SYNC_FAILURE_ALERT_INTERVAL_ENV]: "120000" })).toBe(120_000);
    expect(resolveSyncFailureAlertIntervalMs({ [SYNC_FAILURE_ALERT_INTERVAL_ENV]: String(MAX_SYNC_FAILURE_ALERT_INTERVAL_MS) })).toBe(
      MAX_SYNC_FAILURE_ALERT_INTERVAL_MS,
    );
    for (const bad of ["59999", String(MAX_SYNC_FAILURE_ALERT_INTERVAL_MS + 1), "3600000", "abc", "1.5", "-1"]) {
      expect(() => resolveSyncFailureAlertIntervalMs({ [SYNC_FAILURE_ALERT_INTERVAL_ENV]: bad })).toThrow(
        SYNC_FAILURE_ALERT_INTERVAL_ENV,
      );
    }
  });

  it("is enabled only by the exact string true", () => {
    expect(resolveSyncFailureAlertEnabled({})).toBe(false);
    expect(resolveSyncFailureAlertEnabled({ SYNC_FAILURE_ALERT_ENABLED: "1" })).toBe(false);
    expect(resolveSyncFailureAlertEnabled({ SYNC_FAILURE_ALERT_ENABLED: "true" })).toBe(true);
  });
});
