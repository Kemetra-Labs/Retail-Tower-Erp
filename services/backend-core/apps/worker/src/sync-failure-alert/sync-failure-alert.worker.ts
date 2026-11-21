/**
 * RT-1034 — BullMQ glue for the sync-failure alert sweep: consumes the `sync-failure-alert-sweep`
 * queue (shared `RepeatableWorker`, RT-1210) and hands each job to `SyncFailureAlertProcessor`.
 * Worker-level errors log the error CLASS only (a BullMQ / Redis message can embed a credential).
 */
import { Inject, Injectable } from "@nestjs/common";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

import {
  defaultWorkerLogger,
  logWorkerErrorClass,
  RepeatableWorker,
} from "../common/repeatable-worker";
import type { JobLike, WORKER_FACTORY, WorkerFactory } from "../email/email.worker";
import { SyncFailureAlertProcessor } from "./sync-failure-alert.processor";

export const SYNC_FAILURE_ALERT_QUEUE_NAME = QUEUE_NAMES.syncFailureAlertSweep;

const COMPONENT = "sync-failure-alert.worker";

// The DI token's value, restated as a type-only import of the constant so this module has no
// runtime edge to `email/` (the import-cycle ratchet, RT-1454); the sibling catalog-import does the same.
const WORKER_FACTORY_TOKEN: typeof WORKER_FACTORY = "WORKER_FACTORY";

@Injectable()
export class SyncFailureAlertWorker extends RepeatableWorker {
  constructor(
    private readonly processor: SyncFailureAlertProcessor,
    @Inject(WORKER_FACTORY_TOKEN) workerFactory: WorkerFactory,
  ) {
    super(SYNC_FAILURE_ALERT_QUEUE_NAME, workerFactory);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.process(job.name, job.data);
  }

  protected onWorkerError(err: Error): void {
    // The class name only: a BullMQ / Redis message can embed a connection string.
    logWorkerErrorClass(defaultWorkerLogger(COMPONENT), COMPONENT, err);
  }
}
