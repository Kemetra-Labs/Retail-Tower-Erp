/**
 * RT-179 — BullMQ glue for the scheduled stock reconciliation run sweep.
 *
 * Consumes the `erpnext-stock-reconciliation-sweep` queue, whose only job is
 * the repeatable sweep registered by `StockRunSweepScheduler`, and hands each
 * job to `StockRunSweepProcessor` (shared `RepeatableWorker` base, RT-1210).
 *
 * Worker-level errors go through the shared pino logger (`createLogger`, with
 * the repo redaction paths) carrying the error CLASS only. A BullMQ / Redis
 * error message can embed a connection string or credential, so it is never
 * logged (§VII / §XIV, the outbox drainer's rule).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

import {
  defaultWorkerLogger,
  logWorkerErrorClass,
  RepeatableWorker,
  type WorkerErrorLogger,
} from "../common/repeatable-worker";
import { type JobLike, type WorkerFactory, WORKER_FACTORY } from "../email/email.worker";
import { scheduledAtFromJobId, StockRunSweepProcessor } from "./stock-run-sweep.processor";

export const STOCK_RUN_SWEEP_QUEUE_NAME = QUEUE_NAMES.erpnextStockReconciliationSweep;

const COMPONENT = "erpnext-reconciliation.stock-run-sweep.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const STOCK_RUN_SWEEP_WORKER_LOGGER = "STOCK_RUN_SWEEP_WORKER_LOGGER";

export type StockRunSweepWorkerLogger = WorkerErrorLogger;

@Injectable()
export class StockRunSweepWorker extends RepeatableWorker {
  private readonly logger: StockRunSweepWorkerLogger;

  constructor(
    private readonly processor: StockRunSweepProcessor,
    @Inject(WORKER_FACTORY)
    workerFactory: WorkerFactory,
    @Optional()
    @Inject(STOCK_RUN_SWEEP_WORKER_LOGGER)
    logger?: StockRunSweepWorkerLogger,
  ) {
    super(STOCK_RUN_SWEEP_QUEUE_NAME, workerFactory);
    this.logger = logger ?? defaultWorkerLogger(COMPONENT);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.processJob({
      name: job.name,
      data: job.data,
      scheduledAt: scheduledAtFromJobId(job.id),
    });
  }

  protected onWorkerError(err: Error): void {
    logWorkerErrorClass(this.logger, COMPONENT, err);
  }
}
