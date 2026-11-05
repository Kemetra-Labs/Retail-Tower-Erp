/**
 * OutboxRetentionScheduler -- T590 Layer B.
 *
 * Registers a daily BullMQ repeatable job so `OutboxRetentionWorker` fires
 * once every 24 hours to purge eligible outbox_events rows. 24h matches the
 * audit-retention parallel and the policy doc (docs/outbox/lifecycle.md
 * section 5 -- "daily retention worker"). The registration and the REDIS_URL
 * policy live in the shared `RepeatableScheduler` (RT-1210).
 *
 * Tests do NOT wait 24h: they mock BullMQ's Queue and assert
 * `upsertJobScheduler` was called with the expected cadence and job name.
 */
import { Injectable } from "@nestjs/common";
import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { OUTBOX_RETENTION_JOB_NAME } from "./retention.processor";
import { OUTBOX_RETENTION_QUEUE_NAME } from "./retention.worker";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OutboxRetentionScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "OutboxRetentionScheduler",
      description: "outbox retention sweep",
      queueName: OUTBOX_RETENTION_QUEUE_NAME,
      jobName: OUTBOX_RETENTION_JOB_NAME,
      resolveEveryMs: () => TWENTY_FOUR_HOURS_MS,
      retries: false,
    });
  }
}
