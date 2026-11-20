/**
 * RT-1503 (spec 049 S2) — BullMQ glue for the catalogue import expiry and
 * retention job.
 *
 * Consumes the `catalog-import-retention` queue, whose only job is the
 * repeatable run registered by `ImportRetentionScheduler`, and hands each job
 * to `ImportRetentionProcessor` (shared `RepeatableWorker` base, RT-1210).
 *
 * Worker-level errors go through the shared pino logger carrying the error
 * CLASS only: a BullMQ / Redis message can embed a connection string (§VII /
 * §XIV).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

import {
  defaultWorkerLogger,
  logWorkerErrorClass,
  RepeatableWorker,
  type WorkerErrorLogger,
} from "../common/repeatable-worker";
// Type-only: a runtime import of email/ would put this module on the worker's import cycle (RT-1454).
import type { JobLike, WORKER_FACTORY, WorkerFactory } from "../email/email.worker";
import { ImportRetentionProcessor } from "./import-retention.processor";

export const IMPORT_RETENTION_QUEUE_NAME = QUEUE_NAMES.catalogImportRetention;

const COMPONENT = "catalog-import.retention.worker";

/** The email module's worker-factory DI token, pinned to it by type. */
const WORKER_FACTORY_TOKEN: typeof WORKER_FACTORY = "WORKER_FACTORY";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
const IMPORT_RETENTION_WORKER_LOGGER = "IMPORT_RETENTION_WORKER_LOGGER";

@Injectable()
export class ImportRetentionWorker extends RepeatableWorker {
  constructor(
    private readonly processor: ImportRetentionProcessor,
    @Inject(WORKER_FACTORY_TOKEN) workerFactory: WorkerFactory,
    @Optional() @Inject(IMPORT_RETENTION_WORKER_LOGGER) private errorLogger?: WorkerErrorLogger,
  ) {
    super(IMPORT_RETENTION_QUEUE_NAME, workerFactory);
  }

  /** The run's result is logged by the processor; the job only needs to settle. */
  protected handleJob({ name, data }: JobLike): Promise<void> {
    return this.processor.process(name, data).then(() => undefined);
  }

  protected onWorkerError(err: Error): void {
    this.errorLogger ??= defaultWorkerLogger(COMPONENT);
    logWorkerErrorClass(this.errorLogger, COMPONENT, err);
  }
}
