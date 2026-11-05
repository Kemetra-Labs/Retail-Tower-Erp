/**
 * Nest-aware registrars for the worker's observable gauges (RT-1211: moved out of
 * `worker.module.ts`; `worker.module.ts` re-exports them). Pool teardown stays on
 * `AuditDbPool`; each registrar only registers and removes its callbacks.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";

import { GaugeHandleOwner } from "@data-pulse-2/shared";

import { AuditDbPool } from "../audit-db-pool";
import { InstrumentedRedis } from "./instrumented-redis";
import {
  registerDbPoolGauges,
  registerOutboxPendingGauge,
  registerQueueLagGauge,
  WORKER_QUEUE_NAMES,
  type WorkerQueueName,
} from "./metrics/worker.metrics";

/**
 * Nest-aware registrar for the `db_pool_in_use` and `db_pool_waiters`
 * ObservableGauge callbacks (P4 W1).
 *
 * On `onModuleInit` registers both pool-stats callbacks against
 * `AuditDbPool.pool`. On `onModuleDestroy` removes them so the callbacks
 * do not reference a closed pool. The no-DB path (`wrapper.pool === null`)
 * is handled inside `registerDbPoolGauges` — the registrar is always safe
 * to wire regardless of the runtime environment.
 */
@Injectable()
export class WorkerDbPoolGaugeRegistrar extends GaugeHandleOwner implements OnModuleInit {
  constructor(private readonly wrapper: AuditDbPool) {
    super();
  }

  onModuleInit(): void {
    this.handle = registerDbPoolGauges({ pool: this.wrapper.pool });
  }
}

/**
 * Nest-aware registrar for the `queue_lag_seconds` ObservableGauge
 * callback (P4 W2).
 *
 * On `onModuleInit`:
 *   - If `REDIS_URL` is absent → no-op (matches `NoOpWorkerFactory` path).
 *   - Otherwise → creates one lightweight BullMQ `Queue` reader per entry in
 *     `WORKER_QUEUE_NAMES` and passes the map to `registerQueueLagGauge`.
 *     Queue readers share the same connection format as the BullMQ workers but
 *     are read-only (no processor attached). BullMQ owns each connection's
 *     lifecycle.
 *
 * On `onModuleDestroy`:
 *   - Removes the OTel callback.
 *   - Closes all Queue reader connections (fire-and-forget errors are
 *     swallowed since the process is already exiting).
 */
@Injectable()
export class QueueLagGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private queues: Map<WorkerQueueName, Queue> | null = null;
  private clients: InstrumentedRedis[] | null = null;
  private handle: { stop: () => void } | null = null;

  onModuleInit(): void {
    const redisUrl = process.env["REDIS_URL"];
    if (!redisUrl) {
      return;
    }
    const pairs = WORKER_QUEUE_NAMES.map((name) => {
      const client = new InstrumentedRedis(redisUrl);
      const queue = new Queue(name, { connection: client });
      return { client, queue, name };
    });
    this.clients = pairs.map((p) => p.client);
    this.queues = new Map(pairs.map((p) => [p.name, p.queue]));
    this.handle = registerQueueLagGauge({ queues: this.queues });
  }

  async onModuleDestroy(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
    const qs = this.queues;
    this.queues = null;
    if (qs !== null) {
      await Promise.all([...qs.values()].map((q) => q.close().catch(() => undefined)));
    }
    const cs = this.clients;
    this.clients = null;
    if (cs !== null) {
      await Promise.all(cs.map((c) => c.quit().catch(() => undefined)));
    }
  }
}

/**
 * Nest-aware registrar for the `outbox_pending_total` ObservableGauge
 * callback (T595 PR-B-2).
 *
 * Mirrors `OutboxDrainerRunner`'s lifecycle pattern:
 *   - On `onModuleInit`, calls `registerOutboxPendingGauge` with the
 *     shared `AuditDbPool.pool` (real `pg.Pool` in production, `null`
 *     on the safe non-prod / no-DB path — registrar handles both).
 *   - On `onModuleDestroy`, calls the returned `stop` handle so the
 *     OTel callback is removed during graceful shutdown and does not
 *     try to query a closed pool.
 *
 * The registrar is its own provider class (not folded into
 * `OutboxDrainerRunner`) so its lifecycle is independent: the drainer's
 * poll loop and the gauge callback start / stop on their own. The
 * shared `AuditDbPool` wrapper owns pool teardown for both.
 */
@Injectable()
export class OutboxPendingGaugeRegistrar extends GaugeHandleOwner implements OnModuleInit {
  constructor(private readonly wrapper: AuditDbPool) {
    super();
  }

  onModuleInit(): void {
    this.handle = registerOutboxPendingGauge({ pool: this.wrapper.pool });
  }
}
