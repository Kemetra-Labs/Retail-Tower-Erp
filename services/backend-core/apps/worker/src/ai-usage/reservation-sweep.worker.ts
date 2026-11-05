/**
 * RT-664 — BullMQ glue for the AI usage reservation sweep (T17).
 *
 * Consumes the `ai-usage-reservation-sweep` queue, whose only job is the
 * repeatable sweep registered by `ReservationSweepScheduler`, and hands each
 * job to `ReservationSweepProcessor` (shared `RepeatableWorker` base, RT-1210).
 *
 * Worker-level errors go through the shared pino logger (`createLogger`, with
 * the repo redaction paths) carrying the error CLASS only. A BullMQ / Redis
 * error message can embed a connection string or credential, so it is never
 * logged (§VII / §XIV).
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
import { ReservationSweepProcessor } from "./reservation-sweep.processor";

export const RESERVATION_SWEEP_QUEUE_NAME = QUEUE_NAMES.aiUsageReservationSweep;

const COMPONENT = "ai-usage.reservation-sweep.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const RESERVATION_SWEEP_WORKER_LOGGER = "RESERVATION_SWEEP_WORKER_LOGGER";

export type ReservationSweepWorkerLogger = WorkerErrorLogger;

@Injectable()
export class ReservationSweepWorker extends RepeatableWorker {
  private readonly logger: ReservationSweepWorkerLogger;

  constructor(
    private readonly processor: ReservationSweepProcessor,
    @Inject(WORKER_FACTORY)
    workerFactory: WorkerFactory,
    @Optional()
    @Inject(RESERVATION_SWEEP_WORKER_LOGGER)
    logger?: ReservationSweepWorkerLogger,
  ) {
    super(RESERVATION_SWEEP_QUEUE_NAME, workerFactory);
    this.logger = logger ?? defaultWorkerLogger(COMPONENT);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.process(job.name, job.data);
  }

  protected onWorkerError(err: Error): void {
    logWorkerErrorClass(this.logger, COMPONENT, err);
  }
}
