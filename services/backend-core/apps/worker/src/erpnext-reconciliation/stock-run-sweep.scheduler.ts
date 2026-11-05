/**
 * RT-179 — registers the repeatable stock reconciliation run sweep.
 *
 * The cadence is `ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS` (default
 * daily, see stock-run-sweep.config.ts); changing it and restarting the worker
 * updates the existing schedule in place. Registration and the REDIS_URL
 * policy live in the shared `RepeatableScheduler` (RT-1210).
 *
 * Retries: the processor fails the job with StockRunSweepIncompleteError when
 * a tenant fails, so BullMQ must retry it. Without attempts/backoff the job
 * runs once and the failed tenants wait a whole period. The shared
 * DEFAULT_JOB_OPTIONS (5 attempts, exponential from 1 s, ~15 s in total) go on
 * the queue AND on the scheduler's job template, so every generated job
 * carries them. The whole retry window is far shorter than the 5-minute
 * minimum interval, and each store's advisory lock plus the running /
 * same-period checks make a retry that overlaps the next tick a no-op.
 */
import { Injectable } from "@nestjs/common";

import { RepeatableScheduler } from "../common/repeatable-scheduler";
import { resolveStockRunSweepIntervalMs, sweepPeriodStart } from "./stock-run-sweep.config";
import { STOCK_RUN_SWEEP_JOB_NAME } from "./stock-run-sweep.processor";
import { STOCK_RUN_SWEEP_QUEUE_NAME } from "./stock-run-sweep.worker";

/**
 * First tick of a NEW schedule: the next period boundary (epoch-aligned, the
 * same alignment the sweep's period check uses; for the daily default, the
 * next UTC midnight).
 *
 * Why: BullMQ 5's `every` scheduler fires its first job at registration time
 * and then every `every` ms from there (offset = registration time mod
 * `every`). Registered at 23:59:59 UTC, every tick would land a second before
 * midnight, and a little queue delay pushes it into the next day, giving one
 * day two ticks and the next none. With `startDate` on a boundary, BullMQ's
 * offset is 0 and every tick is scheduled exactly at a period start; the
 * processor also takes the period from the tick's scheduled time (its job id),
 * so a late or early-processed tick still counts for its own period.
 *
 * BullMQ applies `startDate` only when the scheduler has no previous
 * iteration (first registration, or a changed interval). Re-registering an
 * existing schedule on boot keeps its slots. The first sweep after a fresh
 * deploy therefore runs at the next boundary.
 */
export function firstTickAt(now: Date, every: number): Date {
  return new Date(sweepPeriodStart(now, every).getTime() + every);
}

@Injectable()
export class StockRunSweepScheduler extends RepeatableScheduler {
  constructor() {
    super({
      label: "StockRunSweepScheduler",
      description: "the stock reconciliation sweep",
      queueName: STOCK_RUN_SWEEP_QUEUE_NAME,
      jobName: STOCK_RUN_SWEEP_JOB_NAME,
      resolveEveryMs: resolveStockRunSweepIntervalMs,
      retries: true,
      firstTickAt,
    });
  }
}
