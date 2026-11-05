/**
 * RT-664 — registers the repeatable AI usage reservation sweep (T17).
 *
 * The cadence is `AI_RESERVATION_SWEEP_INTERVAL_MS` (default every 5 minutes,
 * see reservation-sweep.config.ts); changing it and restarting the worker
 * updates the existing schedule in place.
 *
 * Retries: the processor fails the job with `ReservationSweepIncompleteError`
 * when a tenant fails, so the queue and the job template carry the shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential backoff). A release is
 * idempotent, so a retry that overlaps the next tick is harmless.
 *
 * Registration and the REDIS_URL policy live in the shared
 * `RepeatableScheduler` (RT-1210).
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveReservationSweepIntervalMs } from "./reservation-sweep.config";
import { RESERVATION_SWEEP_JOB_NAME } from "./reservation-sweep.processor";
import { RESERVATION_SWEEP_QUEUE_NAME } from "./reservation-sweep.worker";

@Injectable()
export class ReservationSweepScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "ReservationSweepScheduler",
      description: "the AI usage reservation sweep",
      queueName: RESERVATION_SWEEP_QUEUE_NAME,
      jobName: RESERVATION_SWEEP_JOB_NAME,
      resolveEveryMs: resolveReservationSweepIntervalMs,
      retries: true,
    });
  }
}
