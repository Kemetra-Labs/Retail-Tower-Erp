/**
 * RT-1210 — RepeatableWorker base unit tests. No BullMQ runtime, no Redis.
 */
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import type { JobLike, WorkerFactory, WorkerLike } from "../../src/email/email.worker";
import { RepeatableWorker } from "../../src/common/repeatable-worker";
import { errorClassName } from "../../src/common/error-class-name";

class FakeWorker implements WorkerLike {
  listeners: Array<(err: Error) => void> = [];
  closed = 0;
  on(_event: "error", l: (err: Error) => void): unknown {
    this.listeners.push(l);
    return this;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeFactory implements WorkerFactory {
  calls: Array<{ queueName: string; handler: (j: JobLike) => Promise<void>; options: unknown }> = [];
  workers: FakeWorker[] = [];
  create(queueName: string, handler: (j: JobLike) => Promise<void>, options: unknown): WorkerLike {
    const w = new FakeWorker();
    this.calls.push({ queueName, handler, options });
    this.workers.push(w);
    return w;
  }
}

class Probe extends RepeatableWorker {
  handled: JobLike[] = [];
  errors: Error[] = [];
  constructor(factory: WorkerFactory) {
    super("probe-queue", factory);
  }
  protected async handleJob(job: JobLike): Promise<void> {
    this.handled.push(job);
  }
  protected onWorkerError(err: Error): void {
    this.errors.push(err);
  }
}

describe("RepeatableWorker (RT-1210)", () => {
  it("creates the worker on the queue with DEFAULT_WORKER_OPTIONS and delegates jobs", async () => {
    const f = new FakeFactory();
    const w = new Probe(f);
    w.start();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.queueName).toBe("probe-queue");
    expect(f.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
    const job = { name: "j", data: { a: 1 }, id: "1" } as JobLike;
    await f.calls[0]!.handler(job);
    expect(w.handled).toEqual([job]);
  });

  it("routes worker error events to onWorkerError", () => {
    const f = new FakeFactory();
    const w = new Probe(f);
    w.start();
    const err = new Error("boom");
    f.workers[0]!.listeners.forEach((l) => l(err));
    expect(w.errors).toEqual([err]);
  });

  it("start() is idempotent", () => {
    const f = new FakeFactory();
    const w = new Probe(f);
    w.start();
    w.start();
    expect(f.calls).toHaveLength(1);
  });

  it("close() before start() is a no-op, and close() is idempotent", async () => {
    const f = new FakeFactory();
    const w = new Probe(f);
    await w.close();
    w.start();
    await w.close();
    await w.close();
    expect(f.workers[0]!.closed).toBe(1);
  });

  it("onModuleDestroy() closes the worker", async () => {
    const f = new FakeFactory();
    const w = new Probe(f);
    w.start();
    await w.onModuleDestroy();
    expect(f.workers[0]!.closed).toBe(1);
  });
});

describe("errorClassName (RT-1210 shared util)", () => {
  it("returns the class name, never the message", () => {
    class Boom extends Error {
      override name = "Boom";
    }
    expect(errorClassName(new Boom("redis://user:pw@host"))).toBe("Boom");
  });
  it("falls back for non-errors and empty names", () => {
    expect(errorClassName("x")).toBe("UnknownError");
    const e = new Error("m");
    e.name = "";
    expect(errorClassName(e)).toBe("Error");
  });
});
