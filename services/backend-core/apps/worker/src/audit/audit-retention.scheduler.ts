/**
 * AuditRetentionScheduler — T311 Layer B.
 *
 * Registers a daily BullMQ repeatable job so `AuditRetentionWorker` fires
 * once every 24 hours to mark eligible audit_events rows. The registration and
 * the REDIS_URL policy live in the shared `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";
import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { AUDIT_RETENTION_JOB_NAME } from "./audit-retention.processor";
import { AUDIT_RETENTION_QUEUE_NAME } from "./audit-retention.worker";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuditRetentionScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "AuditRetentionScheduler",
      description: "audit retention sweep",
      queueName: AUDIT_RETENTION_QUEUE_NAME,
      jobName: AUDIT_RETENTION_JOB_NAME,
      resolveEveryMs: () => TWENTY_FOUR_HOURS_MS,
      retries: false,
    });
  }
}
