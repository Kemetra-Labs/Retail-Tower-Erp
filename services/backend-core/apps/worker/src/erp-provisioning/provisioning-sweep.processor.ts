/**
 * RT-1358 — `ProvisioningSweepProcessor`: the scheduled pass over the ERP
 * provisioning requests (lease reclaim and the heartbeat hold; the work itself
 * is `sweepErpProvisioning` in `@data-pulse-2/db`, the second of the only two
 * writers of the table). A repeatable BullMQ job, default every minute. It never
 * touches the tenant access state: the flip to `unrestricted` stays the platform
 * admin's manual mark-provisioned until the per-store gate (RT-1361).
 *
 * Logging: counts only, never an id, name or secret.
 */
import { sweepErpProvisioning, type SweepResult } from "@data-pulse-2/db";
import type { Pool } from "pg";
import { z } from "zod";

/** BullMQ job (and job-scheduler) name. Pinned by the scheduler spec. */
export const PROVISIONING_SWEEP_JOB_NAME = "erp-provisioning-sweep";

const JobSchema = z.object({}).passthrough();

export type ProvisioningSweepLog = (line: Readonly<Record<string, string | number>>) => void;

function writeStderr(line: Readonly<Record<string, string | number>>): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface ProvisioningSweepRunner {
  run(now: Date, heartbeatTimeoutMs: number): Promise<SweepResult>;
}

export class PgProvisioningSweepRunner implements ProvisioningSweepRunner {
  constructor(private readonly pool: Pool) {}
  run(now: Date, heartbeatTimeoutMs: number): Promise<SweepResult> {
    return sweepErpProvisioning(this.pool, { now, heartbeatTimeoutMs });
  }
}

/** The no-DB path (non-production without Redis): nothing to sweep. */
export class NoOpProvisioningSweepRunner implements ProvisioningSweepRunner {
  run(): Promise<SweepResult> {
    return Promise.resolve({ leasesReclaimed: 0, succeeded: 0, timedOut: 0 });
  }
}

export class UnknownProvisioningSweepJobError extends Error {
  constructor(name: string) {
    super(`Unknown ERP provisioning sweep job name: '${name}'`);
    this.name = "UnknownProvisioningSweepJobError";
  }
}

export class MalformedProvisioningSweepJobError extends Error {
  constructor(name: string) {
    super(`Malformed ERP provisioning sweep job '${name}': payload must be an object`);
    this.name = "MalformedProvisioningSweepJobError";
  }
}

export class ProvisioningSweepProcessor {
  constructor(
    private readonly runner: ProvisioningSweepRunner,
    private readonly heartbeatTimeoutMs: number,
    private readonly log: ProvisioningSweepLog = writeStderr,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(jobName: string, data: unknown): Promise<SweepResult> {
    if (jobName !== PROVISIONING_SWEEP_JOB_NAME) throw new UnknownProvisioningSweepJobError(jobName);
    if (!JobSchema.safeParse(data ?? {}).success) throw new MalformedProvisioningSweepJobError(jobName);
    const startedAt = Date.now();
    const result = await this.runner.run(this.clock(), this.heartbeatTimeoutMs);
    this.log({
      level: result.timedOut > 0 ? "warn" : "info",
      component: "erp-provisioning.sweep",
      message: "sweep_complete",
      leasesReclaimed: result.leasesReclaimed,
      succeeded: result.succeeded,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }
}
