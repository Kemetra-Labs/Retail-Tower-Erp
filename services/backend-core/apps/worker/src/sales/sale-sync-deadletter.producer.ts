/**
 * Sale-sync NEEDS_REPAIR / RETRYABLE quarantine PRODUCER — 032 §8 / T030.
 *
 * The write half the classifier (T029) feeds: given a classified sync failure
 * for one sale, it (a) writes a `sale_sync_deadletters` quarantine row with
 * PROVENANCE INTACT (028) and (b) advances `sales.sync_status` to the matching
 * `failed-*` state — atomically, in ONE transaction, under tenant RLS. THIS is
 * what makes US2's NEEDS_REPAIR list + repair op non-inert: before this, the
 * `sale_sync_deadletters` table existed (migration 0026) but nothing wrote it.
 *
 * NEVER A SILENT DROP (Principle V / XIII)
 * ----------------------------------------
 * A non-retryable failure produces a durable `needs-repair` row the Console can
 * see and an operator can repair; a transient failure produces a `retryable`
 * row with retry accounting. Neither path loses the sale or its provenance.
 *
 * ATOMICITY
 * ---------
 * `runWithTenantContext` opens a transaction (BEGIN/COMMIT) and sets the RLS
 * GUCs. The deadletter INSERT and the `sales` UPDATE run on the SAME client
 * inside that one transaction, so they commit or roll back together — a partial
 * quarantine (row written but status not advanced, or vice-versa) is impossible.
 *
 * IDEMPOTENCY (at-least-once safe)
 * -------------------------------
 * The deadletter INSERT is guarded against the `uq_sale_sync_deadletters_open`
 * partial-unique index (one OPEN row per sale) by an
 * `ON CONFLICT ... WHERE resolved_at IS NULL DO NOTHING`: a re-delivery of the
 * same failure is a no-op insert, not a duplicate row and not a throw. The
 * `sales` status UPDATE is guarded so it only advances a sale that is NOT
 * already in a terminal-success (`synced`) state — a failure classification
 * must never clobber a sale a concurrent drain already synced (§XI converge,
 * the SaleProcessingProcessor `processed_at IS NULL` precedent).
 *
 * NO SALE-FACT REWRITE
 * --------------------
 * The immutable `sales` / `sale_lines` / terminal-event facts are untouched;
 * only the SaaS-owned `sync_status` column moves and a separate quarantine row
 * is added. No money, no line amounts, no PII, no raw payload is written or
 * logged (the `reason_code` is the classifier's redacted machine label).
 *
 * METRICS — DEFERRED (documented gap), NOT silently skipped
 * ---------------------------------------------------------
 * T030 calls for the §VII signals (failed-job rate, reconciliation mismatch
 * rate). The worker metric registry (`observability/metrics/worker.metrics.ts`)
 * gates its label sets (`WORKER_JOB_NAMES` / `WORKER_QUEUE_NAMES`) and the
 * shared `ALLOWED_METRIC_LABELS` allowlist behind a cardinality review
 * (FR-B-012); `worker.module.ts` itself flags adding a `sale-processing` entry
 * as "forbidden" / deferred to a monitoring follow-up, and those files are
 * OUTSIDE this slice's lock scope. There is no existing helper whose domain
 * fits a sale-sync dead-letter (`erpnext_posting_reconciliation_total` is the
 * ERPNext posting domain, not sale-sync). Registering a new sale-sync signal
 * here would either silently grow a gated bounded set or fail the label-policy
 * assertion at module load. So metric EMISSION is deferred to the monitoring
 * slice that owns those files — the same precedent as the deferred queue-lag /
 * DLQ entries for `sale-processing`. The quarantine itself (the durable row +
 * status advance) is the §VII data source that slice will count.
 *
 * LIVE DRAIN-TRIGGER — WIRED (RT-1233)
 * ------------------------------------
 * `worker.module.ts` registers this producer and injects it into
 * `SaleProcessingProcessor`, whose failure branch maps the caught error to a
 * §8 condition (`sale-processing-failure.ts`) and calls
 * `recordProcessingFailure`:
 *   - needs-repair -> one OPEN dead-letter row + `failed-needs-repair` (the
 *     `quarantine` writes, same transaction), and the job is not retried;
 *   - transient -> a STATUS-ONLY `failed-retryable` write, then the original
 *     error is rethrown so BullMQ backs off. No dead-letter row: nothing ever
 *     resolves an open `retryable` row, and an open row of either class blocks
 *     the next insert (one OPEN row per sale), so a later deterministic failure
 *     would never reach the Console's needs-repair list.
 * Neither path touches a `synced` sale, and a transient failure never
 * downgrades a `failed-needs-repair` one. `quarantine(...)` itself is
 * unchanged (callers and specs still use it directly).
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import {
  classifySyncFailure,
  SYNC_STATUS_FAILED_NEEDS_REPAIR,
  SYNC_STATUS_FAILED_RETRYABLE,
  type SyncFailureClassification,
  type SyncFailureCondition,
} from "./sale-sync-failure-classifier";

/** Worker-local copy of the §7 terminal-success status (pinned, not imported). */
const SYNC_STATUS_SYNCED = "synced" as const;

/**
 * RT-1233: one failed sale-processing drain. The job's scope and a §8
 * condition; the provenance is read from the sale itself. `correlationId` is
 * the job's free text: a non-UUID is stored as null.
 */
interface ProcessingFailureInput {
  readonly saleId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly condition: SyncFailureCondition;
  readonly correlationId?: string | null;
}

/**
 * - `quarantined`: the sale has an OPEN needs-repair row (written now, or by
 *   an earlier delivery) — retrying cannot help;
 * - `retryable`: a transient failure, the status is (or already was) guarded
 *   to `failed-retryable` where allowed — retry;
 * - `skipped`: the sale is synced or not in scope — nothing was written.
 */
type ProcessingFailureOutcome = "quarantined" | "retryable" | "skipped";

interface LockedSale {
  source_system: string;
  external_id: string;
  sync_status: string;
}

/**
 * The input to quarantine one failed sale-sync. Carries the (tenant, store)
 * scope + the sale id, the §8 condition to classify, the provenance to
 * preserve (028), and an optional correlation id. NO money / payload / PII.
 */
export interface QuarantineInput {
  readonly saleId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly condition: SyncFailureCondition;
  /** Provenance, preserved intact (028). */
  readonly sourceSystem: string;
  readonly externalId: string;
  /**
   * Optional end-to-end correlation id. The `sale_sync_deadletters.correlation_id`
   * column is UUID-typed, so this MUST be a UUID or null — a non-UUID value will
   * throw `22P02` at the INSERT. WIRING NOTE: the sale-processing job's
   * `correlationId` is FREE TEXT (may be non-UUID); the live drain-trigger slice
   * (deferred — see file docstring) MUST pass a UUID or null here, mirroring the
   * `SaleProcessingProcessor` emit that deliberately nulls a non-UUID
   * correlation id. Do NOT forward a raw free-text correlationId unchanged.
   */
  readonly correlationId?: string | null;
}

export interface QuarantineResult {
  readonly saleId: string;
  readonly classification: SyncFailureClassification;
  /**
   * true when THIS call wrote a fresh quarantine row; false when an OPEN row
   * already existed (idempotent no-op insert — the first classification stands).
   */
  readonly quarantined: boolean;
  /**
   * true when the `sales.sync_status` advanced as a result of this call; false
   * when the sale was already `synced` (a failure must not clobber success) or
   * absent in scope.
   */
  readonly statusAdvanced: boolean;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID correlation id is kept; free text (the job's may be) becomes null. */
function uuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/** Thrown when the target sale does not resolve within the tenant/store scope. */
export class QuarantineSaleNotFoundError extends Error {
  constructor() {
    super("sale not found for quarantine");
    this.name = "QuarantineSaleNotFoundError";
  }
}

/** Minimal log seam — quarantine logging is testable without a real logger. */
export interface QuarantineLogger {
  error(obj: Record<string, unknown>, msg?: string): void;
}

export class SaleSyncDeadletterProducer {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: QuarantineLogger,
  ) {}

  /**
   * Quarantine one failed sale-sync. Classifies the §8 condition, writes the
   * deadletter row + advances `sales.sync_status` atomically under tenant RLS,
   * and returns what happened. Idempotent under at-least-once re-delivery.
   */
  async quarantine(input: QuarantineInput): Promise<QuarantineResult> {
    this.assertInput(input);
    const classification = classifySyncFailure(input.condition);

    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: input.tenantId, isPlatformAdmin: false },
        async (client): Promise<QuarantineResult> => {
          // Object-safety gate under tenant RLS + explicit store predicate: the
          // sale must resolve within (tenant, store) scope before any write.
          // The composite FK on sale_sync_deadletters would also reject a
          // cross-tenant/store sale, but checking first gives a clean
          // not-found rather than a constraint error.
          const found = await this.readSaleInScope(client, input);
          if (!found) {
            throw new QuarantineSaleNotFoundError();
          }

          const quarantined = await this.insertDeadletter(
            client,
            input,
            classification,
          );
          // Advance status ONLY when THIS call wrote a fresh quarantine row. On
          // an open-row conflict (`quarantined === false`) the FIRST
          // classification stands (see docstring) — a re-delivery carrying a
          // DIFFERENT condition must not rewrite `sales.sync_status` while the
          // original open deadletter row is left unchanged, which would drift
          // status away from the open row's recorded classification.
          const statusAdvanced = quarantined
            ? await this.advanceStatus(client, input, classification)
            : false;

          return {
            saleId: input.saleId,
            classification,
            quarantined,
            statusAdvanced,
          };
        },
      );
    } catch (err: unknown) {
      // Log ONLY identifiers + the error class — never the sale row, the
      // provenance values' content, or any payload (FR-042 / FR-092).
      this.logger?.error(
        {
          job_name: "sale-sync-quarantine",
          sale_id: input.saleId,
          tenant_id: input.tenantId,
          store_id: input.storeId,
          classification: classification.classification,
          reason_code: classification.reasonCode,
          correlation_id: input.correlationId ?? null,
          error_class: err instanceof Error ? err.constructor.name : "Unknown",
        },
        "sale sync quarantine failed",
      );
      throw err;
    }
  }

  /**
   * RT-1233: record one failed sale-processing drain (the processor's failure
   * branch). One transaction under tenant RLS; the sale row is locked first,
   * so a concurrent drain cannot sync it between the check and the write.
   * See the file docstring for what each classification writes.
   */
  async recordProcessingFailure(
    input: ProcessingFailureInput,
  ): Promise<ProcessingFailureOutcome> {
    this.assertScope(input);
    const classification = classifySyncFailure(input.condition);
    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ProcessingFailureOutcome> => {
        const sale = await this.lockSaleInScope(client, input);
        if (!sale || sale.sync_status === SYNC_STATUS_SYNCED) return "skipped";
        if (classification.classification === "retryable") {
          await this.markRetryable(client, input);
          return "retryable";
        }
        const quarantine: QuarantineInput = {
          ...input,
          sourceSystem: sale.source_system,
          externalId: sale.external_id,
          correlationId: uuidOrNull(input.correlationId),
        };
        if (await this.insertDeadletter(client, quarantine, classification)) {
          await this.advanceStatus(client, quarantine, classification);
          return "quarantined";
        }
        // An OPEN row already exists (a re-delivery): the first classification
        // stands, exactly as in `quarantine`.
        return sale.sync_status === SYNC_STATUS_FAILED_NEEDS_REPAIR ? "quarantined" : "retryable";
      },
    );
  }

  /** The sale in (tenant, store) scope, locked for this transaction; null when absent. */
  private async lockSaleInScope(
    client: PoolClient,
    input: ProcessingFailureInput,
  ): Promise<LockedSale | null> {
    const r = await client.query<LockedSale>(
      `SELECT source_system, external_id, sync_status
         FROM sales
        WHERE id = $1 AND store_id = $2
          FOR UPDATE`,
      [input.saleId, input.storeId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * The transient write: status only, no dead-letter row. Moves a sale to
   * `failed-retryable` unless it is already there (no version churn on every
   * retry), `synced` (never clobber success), or `failed-needs-repair` (a
   * transient failure must not hide an open needs-repair row).
   */
  private async markRetryable(
    client: PoolClient,
    input: ProcessingFailureInput,
  ): Promise<void> {
    await client.query(
      `UPDATE sales
          SET sync_status = $3,
              -- RT-1061 (RT-973): every sync_status write moves the version by one.
              sync_status_version = sync_status_version + 1
        WHERE id = $1
          AND store_id = $2
          AND sync_status NOT IN ($3, $4, $5)`,
      [
        input.saleId,
        input.storeId,
        SYNC_STATUS_FAILED_RETRYABLE,
        SYNC_STATUS_SYNCED,
        SYNC_STATUS_FAILED_NEEDS_REPAIR,
      ],
    );
  }

  /** Object-safety: the sale resolves within (tenant, store) scope. */
  private async readSaleInScope(
    client: PoolClient,
    input: QuarantineInput,
  ): Promise<boolean> {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM sales WHERE id = $1 AND store_id = $2`,
      [input.saleId, input.storeId],
    );
    return r.rows.length > 0;
  }

  /**
   * Insert the quarantine row, idempotent against the OPEN-row partial-unique
   * index. Returns true when a fresh row was written, false on a no-op
   * (an OPEN row already existed — the first classification stands).
   */
  private async insertDeadletter(
    client: PoolClient,
    input: QuarantineInput,
    classification: SyncFailureClassification,
  ): Promise<boolean> {
    // ON CONFLICT against the `uq_sale_sync_deadletters_open` PARTIAL unique
    // index (predicate `resolved_at IS NULL`): a partial-unique conflict target
    // requires the matching index predicate be restated. A re-delivery while an
    // OPEN row exists is a no-op; a NEW failure after a prior repair resolved
    // the last row inserts a fresh open row (the resolved row is retained for
    // audit — never deleted, never a silent drop). `id`, `quarantined_at`,
    // `retry_count` use their DB-side defaults. Provenance preserved (028).
    const r = await client.query<{ id: string }>(
      `INSERT INTO sale_sync_deadletters
         (sale_id, tenant_id, store_id, classification, reason_code,
          source_system, external_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sale_id) WHERE resolved_at IS NULL
         DO NOTHING
       RETURNING id`,
      [
        input.saleId,
        input.tenantId,
        input.storeId,
        classification.classification,
        classification.reasonCode,
        input.sourceSystem,
        input.externalId,
        input.correlationId ?? null,
      ],
    );
    return r.rows.length > 0;
  }

  /**
   * Advance `sales.sync_status` to the classified `failed-*` state, but ONLY
   * for a sale not already in terminal-success (`synced`). A failure
   * classification must never clobber a sale a concurrent drain already synced
   * (§XI converge). Returns true when a row was updated.
   */
  private async advanceStatus(
    client: PoolClient,
    input: QuarantineInput,
    classification: SyncFailureClassification,
  ): Promise<boolean> {
    const r = await client.query<{ id: string }>(
      `UPDATE sales
          SET sync_status = $3,
              -- RT-1061 (RT-973): every sync_status write moves the version by one.
              sync_status_version = sync_status_version + 1
        WHERE id = $1
          AND store_id = $2
          AND sync_status <> $4
        RETURNING id`,
      [
        input.saleId,
        input.storeId,
        classification.syncStatus,
        SYNC_STATUS_SYNCED,
      ],
    );
    return r.rows.length > 0;
  }

  private assertInput(input: QuarantineInput): void {
    this.assertScope(input);
    if (typeof input.sourceSystem !== "string" || input.sourceSystem.length === 0) {
      throw new Error(
        "SaleSyncDeadletterProducer: sourceSystem must be a non-empty string",
      );
    }
    if (typeof input.externalId !== "string" || input.externalId.length === 0) {
      throw new Error(
        "SaleSyncDeadletterProducer: externalId must be a non-empty string",
      );
    }
    // `correlation_id` is a UUID-typed column AND is logged as `correlation_id`
    // on failure (§XIV PII boundary): reject a malformed value HERE so a
    // non-UUID neither reaches the INSERT as a `22P02` nor leaks arbitrary
    // free text into the worker log. null is allowed (the column is nullable).
    if (
      input.correlationId !== null &&
      input.correlationId !== undefined &&
      !UUID_RE.test(input.correlationId)
    ) {
      throw new Error(
        "SaleSyncDeadletterProducer: correlationId must be a UUID string or null",
      );
    }
  }

  private assertScope(input: { saleId: string; tenantId: string; storeId: string }): void {
    if (!UUID_RE.test(input.saleId)) {
      throw new Error("SaleSyncDeadletterProducer: saleId must be a UUID string");
    }
    if (!UUID_RE.test(input.tenantId)) {
      throw new Error(
        "SaleSyncDeadletterProducer: tenantId must be a UUID string",
      );
    }
    if (!UUID_RE.test(input.storeId)) {
      throw new Error(
        "SaleSyncDeadletterProducer: storeId must be a UUID string",
      );
    }
  }
}
