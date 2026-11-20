/**
 * RT-1503 (spec 049 S2) — registers the repeatable catalogue import expiry and
 * retention job.
 *
 * The cadence is `CATALOG_IMPORT_RETENTION_INTERVAL_MS` (default hourly, see
 * import-retention.config.ts); changing it and restarting the worker updates
 * the existing schedule in place.
 *
 * Retries: the processor fails the job with `ImportRetentionIncompleteError`
 * when a tenant fails, so the queue and the job template carry the shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff). A rerun is
 * idempotent, so a retry that overlaps the next tick is harmless.
 *
 * Registration and the REDIS_URL policy live in the shared
 * `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveImportRetentionIntervalMs } from "./import-retention.config";
import { IMPORT_RETENTION_JOB_NAME } from "./import-retention.processor";
import { IMPORT_RETENTION_QUEUE_NAME } from "./import-retention.worker";

@Injectable()
export class ImportRetentionScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "ImportRetentionScheduler",
      description: "the catalog import retention job",
      queueName: IMPORT_RETENTION_QUEUE_NAME,
      jobName: IMPORT_RETENTION_JOB_NAME,
      resolveEveryMs: resolveImportRetentionIntervalMs,
      retries: true,
    });
  }
}
