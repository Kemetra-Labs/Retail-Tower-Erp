/**
 * RT-1210 — RepeatableScheduler base unit tests. BullMQ's Queue is mocked; no
 * Redis connection is attempted. Covers both REDIS_URL policy branches and the
 * option shapes the six sweep schedulers rely on.
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
  RepeatableScheduler,
  type RepeatableSchedulerConfig,
} from "../../src/common/repeatable-scheduler";

const MockQueue = Queue as unknown as jest.Mock;
const URL = "redis://localhost:6379";
const SAVED = { REDIS_URL: process.env["REDIS_URL"], NODE_ENV: process.env["NODE_ENV"] };

afterEach(() => {
  jest.clearAllMocks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function make(over: Partial<RepeatableSchedulerConfig> = {}): RepeatableScheduler {
  class Probe extends RepeatableScheduler {
    constructor() {
      super({
        label: "ProbeScheduler",
        description: "the probe sweep",
        queueName: "probe-queue",
        jobName: "probe-job",
        resolveEveryMs: () => 1234,
        retries: false,
        ...over,
      });
    }
  }
  return new Probe();
}

function lastQueue(): { upsertJobScheduler: jest.Mock; close: jest.Mock } {
  const r = MockQueue.mock.results[MockQueue.mock.results.length - 1];
  if (!r) throw new Error("Queue constructor was not called");
  return r.value as { upsertJobScheduler: jest.Mock; close: jest.Mock };
}

describe("RepeatableScheduler (RT-1210)", () => {
  it("REDIS_URL present: registers the scheduler under the job name, no retry options", async () => {
    process.env["REDIS_URL"] = URL;
    await make().onModuleInit();
    expect(MockQueue).toHaveBeenCalledWith("probe-queue", { connection: { url: URL } });
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      "probe-job",
      { every: 1234 },
      { name: "probe-job", data: {} },
    );
  });

  it("retries: true puts DEFAULT_JOB_OPTIONS on the queue and the job template", async () => {
    process.env["REDIS_URL"] = URL;
    await make({ retries: true }).onModuleInit();
    expect(MockQueue).toHaveBeenCalledWith("probe-queue", {
      connection: { url: URL },
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      "probe-job",
      { every: 1234 },
      { name: "probe-job", data: {}, opts: DEFAULT_JOB_OPTIONS },
    );
  });

  it("firstTickAt adds a startDate computed from the resolved interval", async () => {
    process.env["REDIS_URL"] = URL;
    const start = new Date("2026-11-05T00:00:00.000Z");
    const firstTickAt = jest.fn().mockReturnValue(start);
    await make({ firstTickAt }).onModuleInit();
    expect(firstTickAt).toHaveBeenCalledWith(expect.any(Date), 1234);
    expect(lastQueue().upsertJobScheduler).toHaveBeenCalledWith(
      "probe-job",
      { every: 1234, startDate: start },
      expect.anything(),
    );
  });

  it("no REDIS_URL outside production: no-op, nothing to close", async () => {
    delete process.env["REDIS_URL"];
    delete process.env["NODE_ENV"];
    const s = make();
    await s.onModuleInit();
    expect(MockQueue).not.toHaveBeenCalled();
    await s.onModuleDestroy();
  });

  it("no REDIS_URL in production: throws with the label-prefixed message", async () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "production";
    await expect(make().onModuleInit()).rejects.toThrow(
      "ProbeScheduler: REDIS_URL is required in production " +
        "(cannot schedule the probe sweep without Redis).",
    );
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("resolves the interval first: an invalid interval refuses boot even without Redis", async () => {
    delete process.env["REDIS_URL"];
    const resolveEveryMs = jest.fn(() => {
      throw new Error("bad interval");
    });
    await expect(make({ resolveEveryMs }).onModuleInit()).rejects.toThrow("bad interval");
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("onModuleDestroy closes the queue exactly once", async () => {
    process.env["REDIS_URL"] = URL;
    const s = make();
    await s.onModuleInit();
    const q = lastQueue();
    await s.onModuleDestroy();
    await s.onModuleDestroy();
    expect(q.close).toHaveBeenCalledTimes(1);
  });
});
