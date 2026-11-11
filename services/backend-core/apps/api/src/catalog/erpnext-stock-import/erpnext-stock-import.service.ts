/**
 * ErpnextStockImportService — RT-1288 runtime of
 * `packages/contracts/openapi/erpnext-connector/stock-import.yaml` 1.0.0-draft.
 *
 *   - `pullRequests` (`stockImportPullRequests`): first maintains the runs, then
 *     returns the open pages after the opaque `since` cursor.
 *       * A running run whose open page has waited more than
 *         `STOCK_IMPORT_PAGE_TIMEOUT_SECONDS` for its report, or whose warehouse
 *         map was retired, is closed `failed`; its page leaves the feed (its
 *         `requestRef` then answers 404) and the warehouse's next run reads
 *         again from the same position. This also covers a report Backend-Core
 *         refused (400/413): the Connector passes it, the page times out, and
 *         the next run re-reads (RT-1287 hand-off, RT-1288 comment 16634).
 *       * For each active `stock` warehouse map whose tenant has sale effects
 *         activated (so the store has its anchor, DC-8) and which has no running
 *         run and no run that ended less than `STOCK_IMPORT_RUN_INTERVAL_SECONDS`
 *         ago, a run and its page 0 are opened. Page 0's `after` is null while
 *         nothing was ever read at the warehouse; otherwise it is the last
 *         non-null `readThrough.creation` minus `overlapSeconds`, with a null
 *         ledger position. A partial unique index keeps one running run per map.
 *     Then: the open pages (no report yet) of running runs, in id (UUIDv7)
 *     order after `since`. A page k+1 exists only once page k's report is
 *     recorded, so a run never has two pages on the feed.
 *   - `reportRows` (`stockImportReportRows`): records the report of one page,
 *     once. Under the report's transaction: the inventory settings lock SHARED
 *     (activation waits), the page and its run FOR UPDATE, the anchor, then the
 *     rows (`ingestRows`). A refusal is recorded as an `unmapped_warehouse`
 *     finding and closes the run `refused` without advancing anything. An
 *     exhausted page completes the run; otherwise page k+1 is opened with
 *     `after` = this page's `readThrough`, as received.
 *
 * Idempotency: `@Idempotent("required")` replays the same key and body; this
 * service also answers a page that already has a report: the same key and body
 * replay its recorded projection (`replayed`), the same key with another body
 * is `idempotency_key_conflict`, another key is `import_report_conflict`.
 *
 * Tenant scope is the connector principal's only (§XII); RLS scopes every read
 * and write. §IX: Backend-Core makes no outbound call.
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { readSaleEffectsActivation, runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { UUID_RE_I } from "../../common/ids";
import type { StockImportReport } from "./dto/stock-import.dto";
import { ingestRows, recordFinding } from "./stock-import.ingest";

/** The settle bound sent on every request (contract default until RT-1287's bench measures it). */
export const STOCK_IMPORT_SETTLE_SECONDS = 300;
/**
 * The run-start overlap. At least 3600 + settle (RT-1287 hand-off): `creation`
 * is naive site wall time, so on a daylight-saving zone (Africa/Cairo) rows of
 * the repeated hour's second pass sort before a cursor taken in its first pass.
 */
export const STOCK_IMPORT_OVERLAP_SECONDS = 3600 + STOCK_IMPORT_SETTLE_SECONDS;
/** Report rows per page (the contract maximum). */
const STOCK_IMPORT_PAGE_MAX_ROWS = 100;
/** The least time between one run's end and the next run's start, per warehouse. */
const STOCK_IMPORT_RUN_INTERVAL_SECONDS = 300;
/** How long an issued page may wait for its report before its run is failed. */
const STOCK_IMPORT_PAGE_TIMEOUT_SECONDS = 3600;
const FEED_MAX_PAGE = 500;

export class StockImportNotFoundError extends Error {
  constructor() {
    super("Stock import request not found.");
    this.name = "StockImportNotFoundError";
  }
}

/** 409 with one of the contract's two conflict codes. */
export class StockImportConflictError extends Error {
  constructor(readonly code: "idempotency_key_conflict" | "import_report_conflict") {
    super(code);
    this.name = "StockImportConflictError";
  }
}

/** 400 for a body rule that needs the pulled request (`rows` above its `maxRows`). */
export class StockImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockImportValidationError";
  }
}

export interface LedgerKeyWire {
  readonly creation: string;
  readonly ledgerEntryRef: string | null;
  readonly entryIndex: number | null;
}

export interface StockImportRequestWire {
  readonly requestRef: string;
  readonly runRef: string;
  readonly pageSeq: number;
  readonly storeId: string;
  readonly erpnextWarehouseRef: string;
  readonly after: LedgerKeyWire | null;
  readonly settleSeconds: number;
  readonly overlapSeconds: number;
  readonly maxRows: number;
  readonly itemCursor: string;
}

export interface PullResult {
  readonly items: readonly StockImportRequestWire[];
  readonly cursor: string | null;
  readonly nextPageToken: string | null;
}

export interface RecordedStockImport {
  readonly requestRef: string;
  readonly runRef: string;
  readonly pageSeq: number;
  readonly erpnextWarehouseRef: string;
  readonly recordedRowCount: number;
  readonly exhausted: boolean;
  readonly refused: boolean;
  readonly readAt: string;
  readonly recordedAt: string;
}

export interface ReportInput {
  readonly tenantId: string;
  readonly requestRef: string;
  readonly body: StockImportReport;
  readonly idempotencyKey: string;
  /** The connector registration (`stock_movements.created_by`). */
  readonly actorId: string;
}

interface PageRow {
  page_id: string;
  run_id: string;
  page_seq: number;
  after_key: LedgerKeyWire | null;
  max_rows: number;
  store_id: string;
  warehouse_map_id: string;
  erpnext_warehouse_ref: string;
  settle_seconds: number;
  overlap_seconds: number;
  run_status: string;
  map_active: boolean;
  recorded_at: string | null;
  idempotency_key: string | null;
  body_hash: string | null;
  read_at: string | null;
  row_count: number | null;
  exhausted: boolean | null;
  refused: boolean | null;
}

/** Order-insensitive fingerprint of a JSON value (sorted object keys). */
export function bodyHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** A `timestamptz` rendered as RFC 3339 UTC with microseconds, in SQL. */
const RFC3339_UTC = (expr: string): string =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class ErpnextStockImportService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async pullRequests(input: { tenantId: string; since: string | null; limit: number }): Promise<PullResult> {
    const limit = Math.min(Math.max(1, input.limit), FEED_MAX_PAGE);
    // Opaque on the wire; v1 encodes a page id. A malformed cursor re-baselines.
    const since = input.since && UUID_RE_I.test(input.since) ? input.since : null;
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      await this.failStaleRuns(client);
      await this.openRuns(client, input.tenantId);
      const r = await client.query<{
        page_id: string;
        run_id: string;
        page_seq: number;
        store_id: string;
        erpnext_warehouse_ref: string;
        after_key: LedgerKeyWire | null;
        settle_seconds: number;
        overlap_seconds: number;
        max_rows: number;
      }>(
        `SELECT p.id AS page_id, p.run_id, p.page_seq, r.store_id, r.erpnext_warehouse_ref, p.after_key,
                r.settle_seconds, r.overlap_seconds, p.max_rows
           FROM erp_stock_import_pages p
           JOIN erp_stock_import_runs r ON r.id = p.run_id
          WHERE p.recorded_at IS NULL AND r.status = 'running'
            AND ($1::uuid IS NULL OR p.id > $1::uuid)
          ORDER BY p.id
          LIMIT $2`,
        [since, limit],
      );
      const items = r.rows.map(
        (row): StockImportRequestWire => ({
          requestRef: row.page_id,
          runRef: row.run_id,
          pageSeq: row.page_seq,
          storeId: row.store_id,
          erpnextWarehouseRef: row.erpnext_warehouse_ref,
          after: row.after_key,
          settleSeconds: row.settle_seconds,
          // The overlap applies to page 0's `after` only (contract: 0 on later pages and when `after` is null).
          overlapSeconds: row.page_seq === 0 && row.after_key !== null ? row.overlap_seconds : 0,
          maxRows: row.max_rows,
          itemCursor: row.page_id,
        }),
      );
      const advanced = items.length > 0 ? items[items.length - 1]!.requestRef : null;
      return { items, cursor: advanced, nextPageToken: items.length === limit ? advanced : null };
    });
  }

  /** Close the running runs whose page timed out or whose warehouse map is no longer active. */
  private async failStaleRuns(client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE erp_stock_import_runs r
          SET status = 'failed', ended_at = now(),
              status_reason = CASE WHEN m.retired_at IS NOT NULL THEN 'warehouse_remapped' ELSE 'report_timeout' END
         FROM erpnext_warehouse_map m
        WHERE m.id = r.warehouse_map_id AND r.status = 'running'
          AND (m.retired_at IS NOT NULL
               OR EXISTS (SELECT 1 FROM erp_stock_import_pages p
                           WHERE p.run_id = r.id AND p.recorded_at IS NULL
                             AND p.issued_at < now() - make_interval(secs => $1)))`,
      [STOCK_IMPORT_PAGE_TIMEOUT_SECONDS],
    );
  }

  /** Open a run and its page 0 for every eligible mapped warehouse (see the header). */
  private async openRuns(client: PoolClient, tenantId: string): Promise<void> {
    const due = await client.query<{ map_id: string; store_id: string; warehouse_ref: string; after_creation: string | null }>(
      `SELECT m.id AS map_id, m.store_id, m.erpnext_warehouse_ref AS warehouse_ref,
              (SELECT ${RFC3339_UTC(`p.read_through_creation - make_interval(secs => $2)`)}
                 FROM erp_stock_import_pages p
                 JOIN erp_stock_import_runs r ON r.id = p.run_id
                WHERE r.erpnext_warehouse_ref = m.erpnext_warehouse_ref AND p.read_through_creation IS NOT NULL
                ORDER BY p.recorded_at DESC, p.id DESC
                LIMIT 1) AS after_creation
         FROM erpnext_warehouse_map m
         JOIN tenant_inventory_settings s ON s.tenant_id = m.tenant_id AND s.sale_effects_activated_at IS NOT NULL
        WHERE m.tenant_id = $1 AND m.purpose = 'stock' AND m.retired_at IS NULL
          AND EXISTS (SELECT 1 FROM inventory_anchors a WHERE a.store_id = m.store_id)
          AND NOT EXISTS (SELECT 1 FROM erp_stock_import_runs r
                           WHERE r.warehouse_map_id = m.id
                             AND (r.status = 'running' OR r.ended_at > now() - make_interval(secs => $3)))
        ORDER BY m.id`,
      [tenantId, STOCK_IMPORT_OVERLAP_SECONDS, STOCK_IMPORT_RUN_INTERVAL_SECONDS],
    );
    for (const w of due.rows) {
      // sequential: one pg client per transaction; each run is two small inserts.
      const runId = newId();
      const opened = await client.query(
        `INSERT INTO erp_stock_import_runs
           (id, tenant_id, store_id, warehouse_map_id, erpnext_warehouse_ref, settle_seconds, overlap_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, warehouse_map_id) WHERE status = 'running' DO NOTHING
         RETURNING id`,
        [runId, tenantId, w.store_id, w.map_id, w.warehouse_ref, STOCK_IMPORT_SETTLE_SECONDS, STOCK_IMPORT_OVERLAP_SECONDS],
      );
      if (opened.rowCount === 0) continue; // a concurrent pull opened it
      const after: LedgerKeyWire | null =
        w.after_creation === null ? null : { creation: w.after_creation, ledgerEntryRef: null, entryIndex: null };
      await this.issuePage(client, tenantId, runId, 0, after);
    }
  }

  private async issuePage(
    client: PoolClient,
    tenantId: string,
    runId: string,
    pageSeq: number,
    after: LedgerKeyWire | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO erp_stock_import_pages (id, tenant_id, run_id, page_seq, after_key, max_rows)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [newId(), tenantId, runId, pageSeq, after === null ? null : JSON.stringify(after), STOCK_IMPORT_PAGE_MAX_ROWS],
    );
  }

  async reportRows(input: ReportInput): Promise<{ replayed: boolean; view: RecordedStockImport }> {
    const hash = bodyHash(input.body);
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      // First: the settings lock SHARED, so the anchor read below and the effects
      // written after it cannot straddle an activation (DC-8).
      const active = await readSaleEffectsActivation(client, input.tenantId);
      const page = await this.lockPage(client, input.requestRef);
      if (page === null) throw new StockImportNotFoundError();
      if (page.recorded_at !== null) {
        if (page.idempotency_key !== input.idempotencyKey) throw new StockImportConflictError("import_report_conflict");
        if (page.body_hash !== hash) throw new StockImportConflictError("idempotency_key_conflict");
        return { replayed: true, view: projection(page) };
      }
      if (page.run_status !== "running" || !page.map_active) throw new StockImportNotFoundError();
      if (input.body.rows.length > page.max_rows) {
        throw new StockImportValidationError(`rows exceeds the request's maxRows (${page.max_rows})`);
      }
      const recorded = await this.recordPage(client, page, input, hash);
      await this.applyReport(client, input, page, active);
      return { replayed: false, view: projection(recorded) };
    });
  }

  private async lockPage(client: PoolClient, requestRef: string): Promise<PageRow | null> {
    if (!UUID_RE_I.test(requestRef)) return null;
    const r = await client.query<PageRow>(
      `SELECT p.id AS page_id, p.run_id, p.page_seq, p.after_key, p.max_rows,
              r.store_id, r.warehouse_map_id, r.erpnext_warehouse_ref, r.settle_seconds, r.overlap_seconds,
              r.status AS run_status,
              (m.retired_at IS NULL AND m.purpose = 'stock') AS map_active,
              ${RFC3339_UTC("p.recorded_at")} AS recorded_at, p.idempotency_key, p.body_hash, p.read_at,
              p.row_count, p.exhausted, p.refused
         FROM erp_stock_import_pages p
         JOIN erp_stock_import_runs r ON r.id = p.run_id
         JOIN erpnext_warehouse_map m ON m.id = r.warehouse_map_id
        WHERE p.id = $1
        FOR UPDATE OF p, r`,
      [requestRef],
    );
    return r.rows[0] ?? null;
  }

  private async recordPage(client: PoolClient, page: PageRow, input: ReportInput, hash: string): Promise<PageRow> {
    const body = input.body;
    const refused = body.refusal !== undefined && body.refusal !== null;
    const r = await client.query<{ recorded_at: string }>(
      `UPDATE erp_stock_import_pages
          SET recorded_at = now(), idempotency_key = $2, body_hash = $3, read_at = $4, row_count = $5,
              exhausted = $6, refused = $7, read_through = $8::jsonb, read_through_creation = $9::timestamptz
        WHERE id = $1
        RETURNING ${RFC3339_UTC("recorded_at")} AS recorded_at`,
      [
        page.page_id,
        input.idempotencyKey,
        hash,
        body.readAt,
        body.rows.length,
        body.exhausted,
        refused,
        body.readThrough === null ? null : JSON.stringify(body.readThrough),
        body.readThrough?.creation ?? null,
      ],
    );
    return {
      ...page,
      recorded_at: r.rows[0]!.recorded_at,
      idempotency_key: input.idempotencyKey,
      body_hash: hash,
      read_at: body.readAt,
      row_count: body.rows.length,
      exhausted: body.exhausted,
      refused,
    };
  }

  private async applyReport(client: PoolClient, input: ReportInput, page: PageRow, active: boolean): Promise<void> {
    const body = input.body;
    const ctxBase = {
      tenantId: input.tenantId,
      storeId: page.store_id,
      pageId: page.page_id,
      erpnextWarehouseRef: page.erpnext_warehouse_ref,
    };
    if (body.refusal !== undefined && body.refusal !== null) {
      await recordFinding(client, ctxBase, null, "unmapped_warehouse", { reason: body.refusal.reason });
      await this.closeRun(client, page.run_id, "refused", body.refusal.reason);
      return;
    }
    const anchor = await this.readAnchor(client, page.store_id);
    if (!active || anchor === null) {
      // The run was opened for an activated tenant; an anchor that is gone now
      // cannot classify anything. Nothing is imported; the rows are re-read later.
      await this.closeRun(client, page.run_id, "failed", "not_activated");
      return;
    }
    await ingestRows(
      client,
      { ...ctxBase, anchorReadAt: anchor.readAt, primaryLocationId: anchor.primaryLocationId, actorId: input.actorId },
      body.rows,
    );
    if (body.exhausted) {
      await this.closeRun(client, page.run_id, "completed", null);
      return;
    }
    // Not exhausted means rows were read, so readThrough is set (DTO rule).
    await this.issuePage(client, input.tenantId, page.run_id, page.page_seq + 1, body.readThrough);
  }

  /** The store's latest anchor snapshot time (exact text) and its primary location. */
  private async readAnchor(
    client: PoolClient,
    storeId: string,
  ): Promise<{ readAt: string; primaryLocationId: string } | null> {
    const r = await client.query<{ read_at: string; location: string }>(
      `SELECT a.snapshot_read_at::text AS read_at,
              (SELECT id FROM stock_locations WHERE store_id = $1 AND kind = 'primary') AS location
         FROM inventory_anchors a
        WHERE a.store_id = $1
        ORDER BY a.generation DESC
        LIMIT 1`,
      [storeId],
    );
    const row = r.rows[0];
    return row === undefined ? null : { readAt: row.read_at, primaryLocationId: row.location };
  }

  private async closeRun(client: PoolClient, runId: string, status: string, reason: string | null): Promise<void> {
    await client.query(
      `UPDATE erp_stock_import_runs SET status = $2, status_reason = $3, ended_at = now()
        WHERE id = $1 AND status = 'running'`,
      [runId, status, reason],
    );
  }
}

function projection(page: PageRow): RecordedStockImport {
  return {
    requestRef: page.page_id,
    runRef: page.run_id,
    pageSeq: page.page_seq,
    erpnextWarehouseRef: page.erpnext_warehouse_ref,
    recordedRowCount: page.row_count!,
    exhausted: page.exhausted!,
    refused: page.refused!,
    readAt: page.read_at!,
    recordedAt: page.recorded_at!,
  };
}
