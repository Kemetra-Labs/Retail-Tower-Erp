/**
 * SaleQuarantineOpsService — RT-1312 Phase 3(b), slice B: the Console half of
 * the sale quarantine (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft):
 * `consoleListQuarantinedSales`, `consoleGetQuarantinedSale` and
 * `consoleWriteOffQuarantinedSale`. The repair (`consoleRepairQuarantinedSale`)
 * is slice C.
 *
 * Reads and writes `sale_quarantine_items` (migration 0093) in place, tenant-
 * scoped under `runWithTenantContext` (RLS, FORCE). Raw parameterized SQL, as
 * the sibling `SaleSyncOpsReadModelService` and the upload service do.
 *
 * Invariants:
 *   - Object-level authz: RLS scopes the tenant; the caller's membership store
 *     scope (RT-193, `context/operator-store-scope.ts`) is a `store_id`
 *     predicate on every read and on the write-off's locking read. An item
 *     outside it reads as absent (non-disclosing 404, FR-063/102).
 *   - The projection is the contract's `QuarantinedSale`: no `tenant_id`, no
 *     line amounts and never the stored body (decision C5). The only money is
 *     the summary's POS total, read from the columns the upload filled.
 *   - Keyset pagination on the UUIDv7 `id` (time-ordered, newest-first), served
 *     by `idx_sale_quarantine_items_tenant_state_id`.
 *   - The write-off acts ONLY on an `open` item (decision C3): it moves the
 *     state to `written-off` for good and stores the note. It never touches the
 *     body, creates no sale, posting intent or stock effect. Anything else is a
 *     `RepairConflictError` (409 `repair_conflict`, no side effect). The
 *     locking read serialises it with a concurrent repair (slice C).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { MembershipRepository, callerStoreScope, scopeStoreIds, type StoreScope } from "../../context";
import { PG_POOL } from "../../database";
import type { QuarantineStateValue } from "./dto/sale-quarantine-ops.dto";
import {
  RepairConflictError,
  type Page,
  type ScopedReadInput,
} from "./sale-sync-ops.read-model.service";

const LIST_MAX_PAGE = 200;

/** Thrown when a quarantine ref does not resolve within the operator's scope (→ non-disclosing 404). */
export class QuarantineNotFoundError extends Error {
  constructor() {
    super("quarantined sale not found");
    this.name = "QuarantineNotFoundError";
  }
}

/** `QuarantineRepair` (contract): the latest repair attempt on an item. */
interface QuarantineRepairBody {
  readonly at: string;
  readonly outcome: "captured" | "already-captured" | "refused";
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
}

/** `QuarantineSaleSummary` (contract, decision C5). */
interface QuarantineSummaryBody {
  readonly occurredAt: string | null;
  readonly posTotal: string | null;
  readonly currencyCode: string | null;
  readonly lineCount: number | null;
}

/** `QuarantinedSale` (contract): the wire projection of one quarantine item. */
export interface QuarantinedSaleBody {
  readonly quarantineRef: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly reasonKind: "refused" | "payload_divergence" | "cashier_claim_refused" | "held_previous_pairing";
  readonly tillHttpStatus: number | null;
  readonly tillErrorCode: string | null;
  readonly state: QuarantineStateValue;
  readonly receivedAt: string;
  readonly tillRecordedAt: string;
  readonly previousTerminalId: string | null;
  readonly repairCount: number;
  readonly lastRepair: QuarantineRepairBody | null;
  readonly uploadConflictCount: number;
  readonly saleRef: string | null;
  readonly summary: QuarantineSummaryBody;
  readonly writeOff: { readonly at: string; readonly note: string } | null;
}

interface ListQuarantinedInput extends ScopedReadInput {
  readonly storeId?: string;
  /** `open` (the queue) when omitted. */
  readonly state?: QuarantineStateValue;
  /** Keyset cursor: the last page's last quarantine `id` (UUIDv7). */
  readonly cursor: string | null;
  readonly limit: number;
}

/** The columns of the projection, and no `sale_body` (never read by the Console, decision C5). */
const ITEM_COLUMNS = `id, store_id, device_id, source_system, external_id, reason_kind,
       till_http_status, till_error_code, state, received_at, till_recorded_at,
       previous_terminal_id, repair_count, last_repair_at, last_repair_outcome,
       last_repair_http_status, last_repair_error_code, upload_conflict_count,
       sale_id, summary_occurred_at, summary_pos_total, summary_currency_code,
       summary_line_count, resolved_at, write_off_note`;

interface ItemRow {
  id: string;
  store_id: string;
  device_id: string;
  source_system: string;
  external_id: string;
  reason_kind: QuarantinedSaleBody["reasonKind"];
  till_http_status: number | null;
  till_error_code: string | null;
  state: QuarantineStateValue;
  received_at: Date;
  till_recorded_at: Date;
  previous_terminal_id: string | null;
  repair_count: number;
  last_repair_at: Date | null;
  last_repair_outcome: QuarantineRepairBody["outcome"] | null;
  last_repair_http_status: number | null;
  last_repair_error_code: string | null;
  upload_conflict_count: number;
  sale_id: string | null;
  summary_occurred_at: Date | null;
  summary_pos_total: string | null;
  summary_currency_code: string | null;
  summary_line_count: number | null;
  resolved_at: Date | null;
  write_off_note: string | null;
}

/** The row as the contract's `QuarantinedSale`. Pure: the unit spec drives it with scripted rows. */
export function toQuarantinedSaleBody(row: ItemRow): QuarantinedSaleBody {
  return {
    quarantineRef: row.id,
    storeId: row.store_id,
    deviceId: row.device_id,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    reasonKind: row.reason_kind,
    tillHttpStatus: row.till_http_status,
    tillErrorCode: row.till_error_code,
    state: row.state,
    receivedAt: row.received_at.toISOString(),
    tillRecordedAt: row.till_recorded_at.toISOString(),
    previousTerminalId: row.previous_terminal_id,
    repairCount: row.repair_count,
    lastRepair:
      row.last_repair_at !== null && row.last_repair_outcome !== null
        ? {
            at: row.last_repair_at.toISOString(),
            outcome: row.last_repair_outcome,
            httpStatus: row.last_repair_http_status,
            errorCode: row.last_repair_error_code,
          }
        : null,
    uploadConflictCount: row.upload_conflict_count,
    saleRef: row.sale_id,
    summary: {
      occurredAt: row.summary_occurred_at !== null ? row.summary_occurred_at.toISOString() : null,
      posTotal: row.summary_pos_total,
      currencyCode: row.summary_currency_code,
      lineCount: row.summary_line_count,
    },
    // The 0093 CHECKs tie both columns to the state: set exactly when written off.
    writeOff:
      row.state === "written-off" && row.resolved_at !== null && row.write_off_note !== null
        ? { at: row.resolved_at.toISOString(), note: row.write_off_note }
        : null,
  };
}

@Injectable()
export class SaleQuarantineOpsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * `consoleListQuarantinedSales`: the tenant's items in one state (default
   * `open`), bounded to the caller's store scope in SQL (pages stay full and
   * the keyset cursor gap-free while out-of-scope rows are skipped), newest-
   * first, keyset paginated. Resolved items are listed only when asked for.
   */
  async list(input: ListQuarantinedInput): Promise<Page<QuarantinedSaleBody>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return await this.inTenant(input, async (client) => {
      const scoped = scopeStoreIds(await this.scopeOf(client, input));
      const rows = await client.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS}
           FROM sale_quarantine_items
          WHERE tenant_id = $1::uuid
            AND state = $2
            AND ($3::uuid IS NULL OR store_id = $3::uuid)
            AND ($4::uuid IS NULL OR id < $4::uuid)
            AND ($5::uuid[] IS NULL OR store_id = ANY($5::uuid[]))
          ORDER BY id DESC
          LIMIT $6`,
        [input.tenantId, input.state ?? "open", input.storeId ?? null, input.cursor, scoped, limit],
      );
      const last = rows.rows[rows.rows.length - 1];
      return {
        items: rows.rows.map(toQuarantinedSaleBody),
        nextCursor: rows.rows.length === limit && last ? last.id : null,
      };
    });
  }

  /** `consoleGetQuarantinedSale`: one item, any state; out of scope or absent → `QuarantineNotFoundError`. */
  get(input: ScopedReadInput, quarantineRef: string): Promise<QuarantinedSaleBody> {
    return this.inTenant(input, async (client) =>
      toQuarantinedSaleBody(await this.readScoped(client, input, quarantineRef, false)),
    );
  }

  /**
   * `consoleWriteOffQuarantinedSale` (decision C3): close an `open` item for
   * good, without a sale. The scoped locking read decides 404 before any write
   * and serialises with a concurrent repair; a non-`open` item is a
   * `RepairConflictError` (no side effect). One transaction: the read, the
   * conditional UPDATE and the returned row commit together.
   */
  writeOff(input: ScopedReadInput, quarantineRef: string, note: string): Promise<QuarantinedSaleBody> {
    return this.inTenant(input, async (client) => {
      const current = await this.readScoped(client, input, quarantineRef, true);
      if (current.state !== "open") throw new RepairConflictError();
      // Only the mutable columns (RT-1249 column grants); the body is kept (decision P3).
      const updated = await client.query<ItemRow>(
        `UPDATE sale_quarantine_items
            SET state = 'written-off', resolved_at = now(), write_off_note = $3
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'open'
          RETURNING ${ITEM_COLUMNS}`,
        [input.tenantId, quarantineRef, note],
      );
      const row = updated.rows[0];
      if (!row) throw new RepairConflictError();
      return toQuarantinedSaleBody(row);
    });
  }

  /** One transaction under the caller's tenant (RLS, FORCE). */
  private inTenant<T>(input: ScopedReadInput, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, fn);
  }

  /** The caller's store scope from its role in the tenant (RLS-scoped read; the RT-192 rule). */
  private scopeOf(client: PoolClient, input: ScopedReadInput): Promise<StoreScope> {
    return callerStoreScope(client, this.memberships, input);
  }

  /** The item, if it is in the caller's store scope; else `QuarantineNotFoundError`. */
  private async readScoped(
    client: PoolClient,
    input: ScopedReadInput,
    quarantineRef: string,
    lock: boolean,
  ): Promise<ItemRow> {
    const scoped = scopeStoreIds(await this.scopeOf(client, input));
    const r = await client.query<ItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM sale_quarantine_items
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND ($3::uuid[] IS NULL OR store_id = ANY($3::uuid[]))${lock ? "\n        FOR UPDATE" : ""}`,
      [input.tenantId, quarantineRef, scoped],
    );
    const row = r.rows[0];
    if (!row) throw new QuarantineNotFoundError();
    return row;
  }
}
