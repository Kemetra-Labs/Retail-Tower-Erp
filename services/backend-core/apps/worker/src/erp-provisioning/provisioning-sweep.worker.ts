/**
 * RT-1358 — BullMQ glue for the ERP provisioning sweep: consumes the
 * `erp-provisioning-sweep` queue and hands each job to
 * `ProvisioningSweepProcessor` (shared `RepeatableWorker` base, RT-1210). Worker
 * errors are logged by class only: a BullMQ / Redis message can embed a
 * connection string (§VII / §XIV).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

import { defaultWorkerLogger, logWorkerErrorClass, RepeatableWorker, type WorkerErrorLogger } from "../common/repeatable-worker";
import { type JobLike, type WorkerFactory, WORKER_FACTORY } from "../email/email.worker";
import { ProvisioningSweepProcessor } from "./provisioning-sweep.processor";

export const PROVISIONING_SWEEP_QUEUE_NAME = QUEUE_NAMES.erpProvisioningSweep;

const COMPONENT = "erp-provisioning.sweep.worker";

/** DI token for an injected logger (tests); production uses the shared pino logger. */
const PROVISIONING_SWEEP_WORKER_LOGGER = "PROVISIONING_SWEEP_WORKER_LOGGER";

@Injectable()
export class ProvisioningSweepWorker extends RepeatableWorker {
  private readonly logger: WorkerErrorLogger;

  constructor(
    private readonly processor: ProvisioningSweepProcessor,
    @Inject(WORKER_FACTORY) workerFactory: WorkerFactory,
    @Optional() @Inject(PROVISIONING_SWEEP_WORKER_LOGGER) logger?: WorkerErrorLogger,
  ) {
    super(PROVISIONING_SWEEP_QUEUE_NAME, workerFactory);
    this.logger = logger ?? defaultWorkerLogger(COMPONENT);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    await this.processor.process(job.name, job.data);
  }

  protected onWorkerError(err: Error): void {
    logWorkerErrorClass(this.logger, COMPONENT, err);
  }
}
