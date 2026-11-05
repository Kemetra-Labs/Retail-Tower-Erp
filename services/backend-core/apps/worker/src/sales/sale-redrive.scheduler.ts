/**
 * RT-457 — registers the repeatable sale re-drive sweep.
 *
 * Each tick is a single job handled by one worker. The cadence is
 * `SALE_REDRIVE_INTERVAL_MS` (default 5 minutes). The processor fails the job
 * with SaleRedriveIncompleteError when a sale or tenant fails, so the shared
 * retry options go on the queue and on the job template; a retry is a no-op
 * for what already succeeded. Registration and the REDIS_URL policy live in
 * the shared `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveSaleRedriveIntervalMs } from "./sale-redrive.config";
import { SALE_REDRIVE_JOB_NAME } from "./sale-redrive.processor";
import { SALE_REDRIVE_QUEUE_NAME } from "./sale-redrive.worker";

@Injectable()
export class SaleRedriveScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "SaleRedriveScheduler",
      description: "the sale re-drive sweep",
      queueName: SALE_REDRIVE_QUEUE_NAME,
      jobName: SALE_REDRIVE_JOB_NAME,
      resolveEveryMs: resolveSaleRedriveIntervalMs,
      retries: true,
    });
  }
}
