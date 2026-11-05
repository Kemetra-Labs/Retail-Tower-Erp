/**
 * RT-457 — BullMQ glue for the scheduled sale re-drive sweep.
 *
 * Consumes the `sale-redrive` queue, whose only job is the repeatable sweep
 * registered by `SaleRedriveScheduler`, and hands each job to
 * `SaleRedriveProcessor` (shared `RepeatableWorker` base, RT-1210).
 *
 * Worker-level errors are logged with the error CLASS only: a BullMQ / Redis
 * message can embed a connection string or credential (§VII / §XIV).
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
import { SaleRedriveProcessor } from "./sale-redrive.processor";

export const SALE_REDRIVE_QUEUE_NAME = QUEUE_NAMES.saleRedrive;

const COMPONENT = "sales.sale-redrive.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const SALE_REDRIVE_WORKER_LOGGER = "SALE_REDRIVE_WORKER_LOGGER";

export type SaleRedriveWorkerLogger = WorkerErrorLogger;

@Injectable()
export class SaleRedriveWorker extends RepeatableWorker {
  private readonly logger: SaleRedriveWorkerLogger;

  constructor(
    private readonly processor: SaleRedriveProcessor,
    @Inject(WORKER_FACTORY)
    workerFactory: WorkerFactory,
    @Optional()
    @Inject(SALE_REDRIVE_WORKER_LOGGER)
    logger?: SaleRedriveWorkerLogger,
  ) {
    super(SALE_REDRIVE_QUEUE_NAME, workerFactory);
    this.logger = logger ?? defaultWorkerLogger(COMPONENT);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.process(job.name, job.data);
  }

  protected onWorkerError(err: Error): void {
    logWorkerErrorClass(this.logger, COMPONENT, err);
  }
}
