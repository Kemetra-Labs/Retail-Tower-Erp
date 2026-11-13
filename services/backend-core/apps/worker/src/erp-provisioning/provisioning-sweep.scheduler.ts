/**
 * RT-1358 — registers the repeatable ERP provisioning sweep. The cadence is
 * `ERP_PROVISIONING_SWEEP_INTERVAL_MS` (default every minute, see
 * provisioning-sweep.config.ts). A sweep is idempotent, so the shared retry
 * options (5 attempts, exponential backoff) are safe. Registration and the
 * REDIS_URL policy live in the shared `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveProvisioningSweepIntervalMs } from "./provisioning-sweep.config";
import { PROVISIONING_SWEEP_JOB_NAME } from "./provisioning-sweep.processor";
import { PROVISIONING_SWEEP_QUEUE_NAME } from "./provisioning-sweep.worker";

@Injectable()
export class ProvisioningSweepScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "ProvisioningSweepScheduler",
      description: "the ERP provisioning sweep",
      queueName: PROVISIONING_SWEEP_QUEUE_NAME,
      jobName: PROVISIONING_SWEEP_JOB_NAME,
      resolveEveryMs: resolveProvisioningSweepIntervalMs,
      retries: true,
    });
  }
}
