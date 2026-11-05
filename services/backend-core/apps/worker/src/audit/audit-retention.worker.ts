/**
 * AuditRetentionWorker — T311 Layer B.
 *
 * Thin BullMQ glue for the audit retention sweep queue (shared
 * `RepeatableWorker` base, RT-1210).
 *
 * Queue name (`"audit-retention"`) is the transport channel. The only job
 * name carried by this queue is `"audit-retention-sweep"`, validated
 * downstream by `AuditRetentionProcessor.process`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { AuditRetentionProcessor } from "./audit-retention.processor";
import { RepeatableWorker } from "../common/repeatable-worker";
import {
  type JobLike,
  type WorkerFactory,
  WORKER_FACTORY,
} from "../email/email.worker";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

export const AUDIT_RETENTION_QUEUE_NAME = QUEUE_NAMES.auditRetention;

export type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
export { WORKER_FACTORY } from "../email/email.worker";
export type AuditRetentionJobHandler = (job: JobLike) => Promise<void>;

@Injectable()
export class AuditRetentionWorker extends RepeatableWorker {
  constructor(
    private readonly processor: AuditRetentionProcessor,
    @Inject(WORKER_FACTORY)
    workerFactory: WorkerFactory,
  ) {
    super(AUDIT_RETENTION_QUEUE_NAME, workerFactory);
  }

  protected async handleJob(job: JobLike): Promise<void> {
    try {
      await this.processor.process(job.name, job.data);
    } catch (err) {
      // RT-353: a rejected sweep is a BullMQ job failure, not a worker
      // `error` event, so the listener below never sees it. Log it here
      // and rethrow so BullMQ still records the failure and retries.
      logJobFailure(job, err);
      throw err;
    }
  }

  protected onWorkerError(err: Error): void {
    const line = JSON.stringify({
      level: "error",
      component: "audit-retention.worker",
      message: err.message,
      name: err.name,
    });
    process.stderr.write(line + "\n");
  }
}

/** One structured stderr line per failed sweep; `undefined` fields are omitted. */
function logJobFailure(job: JobLike, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const code = (err as { code?: unknown } | null)?.code;
  const line = JSON.stringify({
    level: "error",
    component: "audit-retention.worker",
    event: "job_failed",
    job_name: job.name,
    job_id: job.id,
    name: e.name,
    code: typeof code === "string" ? code : undefined,
    message: e.message,
  });
  process.stderr.write(line + "\n");
}
