/**
 * RT-209 — registers the repeatable cashier-admission replay purge.
 *
 * The cadence is `CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS` (default hourly,
 * see replay-purge.config.ts); changing it and restarting the worker updates
 * the existing schedule in place.
 *
 * Retries: the processor fails the job with `ReplayPurgeIncompleteError` when a
 * tenant fails, so the queue and the job template carry the shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff). A purge is
 * idempotent, so a retry that overlaps the next tick is harmless.
 *
 * Registration and the REDIS_URL policy live in the shared
 * `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveReplayPurgeIntervalMs } from "./replay-purge.config";
import { REPLAY_PURGE_JOB_NAME } from "./replay-purge.processor";
import { REPLAY_PURGE_QUEUE_NAME } from "./replay-purge.worker";

@Injectable()
export class ReplayPurgeScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "ReplayPurgeScheduler",
      description: "the cashier-admission replay purge",
      queueName: REPLAY_PURGE_QUEUE_NAME,
      jobName: REPLAY_PURGE_JOB_NAME,
      resolveEveryMs: resolveReplayPurgeIntervalMs,
      retries: true,
    });
  }
}
