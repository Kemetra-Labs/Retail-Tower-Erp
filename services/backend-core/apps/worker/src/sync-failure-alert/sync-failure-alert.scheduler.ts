/**
 * RT-1034 — registers the repeatable sync-failure alert sweep (BullMQ `upsertJobScheduler`, via
 * the shared `RepeatableScheduler`, RT-1210). The cadence is `SYNC_FAILURE_ALERT_SWEEP_INTERVAL_MS`
 * (default 5 minutes). The shared DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff) go on the
 * queue and the job template, so a failed delivery retries and the failed set is the DLQ.
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveSyncFailureAlertIntervalMs } from "./sync-failure-alert.config";
import { SYNC_FAILURE_ALERT_JOB_NAME } from "./sync-failure-alert.processor";
import { SYNC_FAILURE_ALERT_QUEUE_NAME } from "./sync-failure-alert.worker";

@Injectable()
export class SyncFailureAlertScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "SyncFailureAlertScheduler",
      description: "the sync-failure alert sweep",
      queueName: SYNC_FAILURE_ALERT_QUEUE_NAME,
      jobName: SYNC_FAILURE_ALERT_JOB_NAME,
      resolveEveryMs: resolveSyncFailureAlertIntervalMs,
      retries: true,
    });
  }
}
