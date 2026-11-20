/**
 * RT-1503 (spec 049 S2) — `ImportRetentionProcessor`: the catalogue import
 * expiry and retention job. Spec 049 §10 gives this slice the job; no other
 * slice owns it.
 *
 * One run, per tenant (listed as platform admin, then worked under that
 * tenant's own GUC, see the repository):
 *   1. expiry: open `draft` / `validated` batches past `expires_at` become
 *      `expired` (the §8.1 conditional UPDATE plus one `catalog.import.expire`
 *      audit row each, in one transaction per pass);
 *   2. purge: the rows of `cancelled` / `expired` batches 30 days after
 *      `closed_at`, and of `published` batches 13 months after `published_at`,
 *      are deleted and the batch stamped `rows_purged_at`; the header stays.
 * Expiry runs first, so a batch expired in this run starts its 30 days now.
 *
 * Each step drains in bounded passes until a pass comes back short. A failing
 * tenant is logged and counted and the next tenant still runs; the job then
 * fails with `ImportRetentionIncompleteError` so BullMQ retries it. A rerun is
 * safe: an expired batch no longer matches the expiry, and a stamped batch no
 * longer matches the purge.
 *
 * Logging: counts only. A failure line carries the error class and a
 * SQLSTATE-like code, never the message, a tenant id, a batch id or any cell.
 */
import { QUEUE_NAMES } from "@data-pulse-2/shared";
import { z } from "zod";

import { errorFields } from "../common/error-class-name";
import { DEFAULT_IMPORT_RETENTION_LIMITS, type ImportRetentionLimits } from "./import-retention.config";
import type { ImportRetentionRepository } from "./import-retention.repository";

/**
 * BullMQ job (and job-scheduler) name: the queue name itself, so the failed-job
 * listener can declare it from `QUEUE_NAMES` without importing this module
 * (observability -> catalog-import -> email -> observability would be a cycle).
 * Pinned by the specs.
 */
export const IMPORT_RETENTION_JOB_NAME = QUEUE_NAMES.catalogImportRetention;

/** Scheduled runs carry no payload; passthrough tolerates BullMQ metadata. */
const ImportRetentionJobData = z.object({}).passthrough();

export type ImportRetentionLogLine = Readonly<Record<string, string | number>>;
export type ImportRetentionLog = (line: ImportRetentionLogLine) => void;

const COMPONENT = "catalog-import.retention";

export interface ImportRetentionResult {
  readonly tenants: number;
  readonly expired: number;
  readonly purgedBatches: number;
  readonly purgedRows: number;
  readonly passes: number;
  readonly failedTenants: number;
  readonly durationMs: number;
}

export class UnknownImportRetentionJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown catalog import retention job name: '${jobName}'`);
    this.name = "UnknownImportRetentionJobError";
  }
}

export class MalformedImportRetentionJobError extends Error {
  constructor(jobName: string) {
    super(`Malformed catalog import retention job '${jobName}': payload must be an object`);
    this.name = "MalformedImportRetentionJobError";
  }
}

export class ImportRetentionIncompleteError extends Error {
  constructor(readonly result: ImportRetentionResult) {
    super(`catalog import retention incomplete: ${result.failedTenants} tenant(s) failed`);
    this.name = "ImportRetentionIncompleteError";
  }
}

type Counters = { -readonly [K in keyof Omit<ImportRetentionResult, "durationMs">]: number };

function stderrLog(line: ImportRetentionLogLine): void {
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

function assertPositiveWhole(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`ImportRetentionProcessor: ${what} must be a positive whole number`);
  }
}

export class ImportRetentionProcessor {
  constructor(
    private readonly repo: ImportRetentionRepository,
    private readonly limits: ImportRetentionLimits = DEFAULT_IMPORT_RETENTION_LIMITS,
    private readonly log: ImportRetentionLog = stderrLog,
  ) {
    assertPositiveWhole(limits.expiryBatchLimit, "the expiry batch limit");
    assertPositiveWhole(limits.purgeBatchLimit, "the purge batch limit");
  }

  async process(jobName: string, data: unknown): Promise<ImportRetentionResult> {
    if (jobName !== IMPORT_RETENTION_JOB_NAME) throw new UnknownImportRetentionJobError(jobName);
    if (!ImportRetentionJobData.safeParse(data).success) throw new MalformedImportRetentionJobError(jobName);

    const started = Date.now();
    const counters: Counters = { tenants: 0, expired: 0, purgedBatches: 0, purgedRows: 0, passes: 0, failedTenants: 0 };
    const tenantIds = await this.repo.listTenantIds();
    // sequential: one tenant at a time bounds the DB load and isolates a tenant's failure.
    for (const tenantId of tenantIds) {
      counters.tenants += 1;
      try {
        await this.expireTenant(tenantId, counters);
        await this.purgeTenant(tenantId, counters);
      } catch (err) {
        counters.failedTenants += 1;
        this.log({ level: "error", component: COMPONENT, message: "tenant_retention_failed", ...errorFields(err) });
      }
    }

    const result: ImportRetentionResult = { ...counters, durationMs: Date.now() - started };
    this.log({
      level: result.failedTenants > 0 ? "warn" : "info",
      component: COMPONENT,
      message: "retention_complete",
      tenants: result.tenants,
      expired: result.expired,
      purged_batches: result.purgedBatches,
      purged_rows: result.purgedRows,
      passes: result.passes,
      failed_tenants: result.failedTenants,
      duration_ms: result.durationMs,
    });
    if (result.failedTenants > 0) throw new ImportRetentionIncompleteError(result);
    return result;
  }

  /** Expiry passes until one picks fewer than the limit (or expires nothing). */
  private async expireTenant(tenantId: string, counters: Counters): Promise<void> {
    const limit = this.limits.expiryBatchLimit;
    for (;;) {
      // sequential: drain loop; each pass is its own transaction.
      const pass = await this.repo.expireDueBatches(tenantId, limit);
      counters.passes += 1;
      counters.expired += pass.expired;
      if (pass.picked < limit || pass.expired === 0) return;
    }
  }

  /** Purge passes until one purges fewer batches than the limit. */
  private async purgeTenant(tenantId: string, counters: Counters): Promise<void> {
    const limit = this.limits.purgeBatchLimit;
    for (;;) {
      // sequential: drain loop; each pass is its own transaction.
      const pass = await this.repo.purgeDueRows(tenantId, limit);
      counters.passes += 1;
      counters.purgedBatches += pass.batches;
      counters.purgedRows += pass.rows;
      if (pass.batches < limit) return;
    }
  }
}
