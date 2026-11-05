/**
 * RT-209 — BullMQ glue for the cashier-admission replay purge.
 *
 * Consumes the `cashier-admission-replay-purge` queue, whose only job is the
 * repeatable purge registered by `ReplayPurgeScheduler`, and hands each job to
 * `ReplayPurgeProcessor` (shared `RepeatableWorker` base, RT-1210).
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
import { ReplayPurgeProcessor } from "./replay-purge.processor";

export const REPLAY_PURGE_QUEUE_NAME = QUEUE_NAMES.cashierAdmissionReplayPurge;

const COMPONENT = "cashier-admissions.replay-purge.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
export const REPLAY_PURGE_WORKER_LOGGER = "REPLAY_PURGE_WORKER_LOGGER";

export type ReplayPurgeWorkerLogger = WorkerErrorLogger;

@Injectable()
export class ReplayPurgeWorker extends RepeatableWorker {
  private readonly logger: ReplayPurgeWorkerLogger;

  constructor(
    private readonly processor: ReplayPurgeProcessor,
    @Inject(WORKER_FACTORY)
    workerFactory: WorkerFactory,
    @Optional()
    @Inject(REPLAY_PURGE_WORKER_LOGGER)
    logger?: ReplayPurgeWorkerLogger,
  ) {
    super(REPLAY_PURGE_QUEUE_NAME, workerFactory);
    this.logger = logger ?? defaultWorkerLogger(COMPONENT);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.process(job.name, job.data);
  }

  protected onWorkerError(err: Error): void {
    logWorkerErrorClass(this.logger, COMPONENT, err);
  }
}
