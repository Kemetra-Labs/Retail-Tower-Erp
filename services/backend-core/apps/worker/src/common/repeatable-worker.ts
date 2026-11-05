/**
 * RT-1210 — one base for the BullMQ glue of the repeatable sweep queues.
 *
 * A subclass supplies the queue name, the job handler and the worker-level
 * error handler (the error label / log shape differs per queue, and a BullMQ /
 * Redis message can embed a connection string, so each handler decides what it
 * may log). Started imperatively by `bootstrap()` in main.ts; closed by Nest's
 * `onModuleDestroy` on shutdown.
 */
import type { OnModuleDestroy } from "@nestjs/common";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";
import { createLogger, type Logger } from "@data-pulse-2/shared";

import type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
import { errorClassName } from "./error-class-name";

export abstract class RepeatableWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  protected constructor(
    private readonly queueName: string,
    private readonly workerFactory: WorkerFactory,
  ) {}

  protected abstract handleJob(job: JobLike): Promise<void>;
  protected abstract onWorkerError(err: Error): void;

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      this.queueName,
      (job: JobLike) => this.handleJob(job),
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => this.onWorkerError(err));
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      await w.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export type WorkerErrorLogger = Pick<Logger, "error">;

/** The shared pino logger for a sweep worker (repo redaction paths). */
export function defaultWorkerLogger(component: string): WorkerErrorLogger {
  return createLogger({ service: "backend-worker", bindings: { component } });
}

/** Worker error line carrying the error CLASS only, never the message. */
export function logWorkerErrorClass(
  logger: WorkerErrorLogger,
  component: string,
  err: unknown,
): void {
  logger.error({ component, errorName: errorClassName(err) }, "worker_error");
}
