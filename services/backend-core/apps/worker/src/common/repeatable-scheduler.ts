/**
 * RT-1210 — one parameterized base for the repeatable sweep schedulers
 * (audit retention, outbox retention, stock run sweep, replay purge, sale
 * re-drive, AI usage reservation sweep).
 *
 * `Queue.upsertJobScheduler` is idempotent per scheduler id (the job name), so
 * every worker boot (and every replica) converges on ONE schedule in Redis.
 *
 * Boot order is part of the contract:
 *   1. resolve the interval first, so an invalid interval refuses boot even
 *      without Redis;
 *   2. REDIS_URL policy: production + no REDIS_URL -> throw; non-production +
 *      no REDIS_URL -> no-op; REDIS_URL present -> register the scheduler.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { requireRedisUrl } from "@data-pulse-2/shared";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

export interface RepeatableSchedulerConfig {
  /** Class name; prefixes the production REDIS_URL error (specs pin it). */
  readonly label: string;
  /** Completes "cannot schedule <description> without Redis" in that error. */
  readonly description: string;
  readonly queueName: string;
  /** Job name; also the scheduler id. */
  readonly jobName: string;
  /** Resolved before the REDIS_URL check; may throw on an invalid interval. */
  readonly resolveEveryMs: () => number;
  /** True: the shared DEFAULT_JOB_OPTIONS (retries) go on the queue and the job template. */
  readonly retries: boolean;
  /** Optional `startDate` for a NEW schedule, from the clock and the interval. */
  readonly firstTickAt?: (now: Date, every: number) => Date;
}

@Injectable()
export abstract class RepeatableScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  protected constructor(private readonly config: RepeatableSchedulerConfig) {}

  async onModuleInit(): Promise<void> {
    const c = this.config;
    const every = c.resolveEveryMs();
    const url = requireRedisUrl({
      component: c.label,
      reason: `cannot schedule ${c.description} without Redis`,
    });
    if (url === null) {
      return;
    }
    const jobOptions = c.retries ? (DEFAULT_JOB_OPTIONS as JobsOptions) : undefined;
    this.queue = new Queue(
      c.queueName,
      jobOptions
        ? { connection: { url }, defaultJobOptions: jobOptions }
        : { connection: { url } },
    );
    await this.queue.upsertJobScheduler(
      c.jobName,
      c.firstTickAt
        ? { every, startDate: c.firstTickAt(new Date(Date.now()), every) }
        : { every },
      jobOptions
        ? { name: c.jobName, data: {}, opts: jobOptions }
        : { name: c.jobName, data: {} },
    );
  }

  async onModuleDestroy(): Promise<void> {
    const q = this.queue;
    this.queue = null;
    if (q !== null) {
      await q.close();
    }
  }
}
