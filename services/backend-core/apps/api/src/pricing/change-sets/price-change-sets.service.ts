/**
 * PriceChangeSetsService — RT-1484 (RT-282 PR-09b): the authoring runtime of
 * `pricing/price-change-sets.yaml` 1.0.0-draft (list, create, get, update, cancel) over 0121
 * `change_sets` and 0123 `price_change_set_item_lists` / `price_change_set_items` (read:
 * `price_change_set_validations` for a stored summary). Validate and preview are PR-4b; submit,
 * approve, reject, publish and rollback are later slices.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant RLS, FORCE,
 * `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on every statement; the
 * tenant and the actor are the session's (§II, §XII). Audit rows go through the `audit` port.
 *
 * Writes. Each is ONE transaction: the change, its `audit_events` row
 * (`pricing.change_set.<transition>`, spec 042 §10) and the body it answers with.
 *   - The authoring gate comes first: a tenant not on `PRICING_AUTHORING_TENANT_ALLOWLIST` is
 *     `409 pricing_authority_legacy` (owner decision 1, RT-1484 comment 17829; spec 044 §6.1).
 *   - An edit or a cancel locks the set row `FOR NO KEY UPDATE` first, the lock mode 0123's
 *     content triggers take, so two writers of one set serialize instead of deadlocking.
 *   - `expectedVersion` is checked before the state (decision 532: `409 version_conflict`).
 *   - An edit increments the version, returns the set to `draft` and discards the stored preview
 *     binding (0121 `change_sets_preview_whole`); a PATCH with `items` writes a new item list at
 *     the new version (0123: the current list is the latest one at or below the version), a
 *     header-only PATCH keeps the earlier list.
 *   - A cancel keeps the version (0123 `change_sets_content_rules`: outside `draft` it never
 *     changes) and the validation binding, as the record of what was validated.
 * 0123's COMMIT-time checks (an item list holds exactly `item_count` items) run at COMMIT; this
 * service never issues `SET CONSTRAINTS` (RT-1151 residual 1, comment 17827).
 *
 * The UPDATEs name only the columns production grants (`auth/grants/pricing.grants.ts`).
 *
 * Emergency (`kind: emergency`, Q-B3): the `pricing.emergency` capability is held by `owner` and
 * `tenant_admin` (owner decision 3, comment 17829), the only roles `RolesGuard` lets through, so
 * `403 pricing_emergency_not_permitted` cannot arise in v1. The required reason is a request rule.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { insertAuditRowInTransaction } from "../../audit";
import type { TenantContextRequest } from "../../context";
import { PG_POOL } from "../../database";
import { isPricingAuthoringAllowed, PRICING_AUTHORING_CONFIG, type PricingAuthoringConfig } from "./price-authoring.config";
import type {
  CreatePriceChangeSetBody,
  ListChangeSetsQuery,
  PriceChangeItem,
  UpdatePriceChangeSetBody,
  VersionedBody,
} from "./price-change-sets.dto";
import {
  decodeChangeSetListCursor,
  encodeChangeSetListCursor,
  PriceChangeSetConflictError,
  PriceChangeSetNotFoundError,
  toHeaderBody,
  type ChangeSetRow,
  type ChangeSetState,
  type PriceChangeSetBody,
  type PriceChangeSetPageBody,
} from "./price-change-sets.projections";

/** The session tenant and context of a read. */
export interface ChangeSetReadInput {
  readonly tenantId: string;
  readonly context: NonNullable<TenantContextRequest["context"]>;
}

/** A write adds the actor and the request id for the audit row. */
export interface ChangeSetWriteInput extends ChangeSetReadInput {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

const DEFAULT_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** States an edit may start from (contract: `draft` or `validated`). */
const EDITABLE: readonly ChangeSetState[] = ["draft", "validated"];
/** States a cancel may start from (contract: before publish). */
const CANCELLABLE: readonly ChangeSetState[] = ["draft", "validated", "pending_approval", "approved"];

const CHANGE_SET_COLUMNS = `c.id::text AS id, c.kind, c.title, c.reason, c.state, c.version,
       c.validated_at_revision::text AS validated_at_revision, c.preview_hash, c.sensitive, c.sensitivity_reasons,
       c.revision_no::text AS revision_no, c.rolls_back_change_set_id::text AS rolls_back_change_set_id,
       (SELECT r.id::text FROM change_sets r
         WHERE r.tenant_id = c.tenant_id AND r.rolls_back_change_set_id = c.id AND r.revision_no IS NOT NULL
         LIMIT 1) AS rolled_back_by_change_set_id,
       c.created_by_user_id::text AS created_by_user_id, c.created_at,
       c.submitted_by_user_id::text AS submitted_by_user_id, c.submitted_at,
       c.approved_by_user_id::text AS approved_by_user_id, c.approved_at,
       c.published_by_user_id::text AS published_by_user_id, c.published_at,
       c.cancelled_by_user_id::text AS cancelled_by_user_id, c.cancelled_at,
       c.rejected_by_user_id::text AS rejected_by_user_id, c.rejected_at, c.rejection_reason,
       to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key`;

/** The request id when it is a UUID (the audit row's `request_id` is uuid), else null. */
function uuidRequestId(input: ChangeSetWriteInput): string | null {
  return input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null;
}

/** `correlation_id` is NOT NULL uuid: the request id when it is one, else a fresh id. */
function correlationOf(input: ChangeSetWriteInput): string {
  return uuidRequestId(input) ?? newId();
}

/** The set row as an edit or a cancel sees it, under its row lock. */
interface LockedSet {
  readonly kind: ChangeSetRow["kind"];
  readonly state: ChangeSetState;
  readonly version: number;
  readonly previewHash: string | null;
}

@Injectable()
export class PriceChangeSetsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRICING_AUTHORING_CONFIG) private readonly authoring: PricingAuthoringConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Reads (open to every owner / tenant_admin, allowlisted or not)
  // -------------------------------------------------------------------------

  /** consoleListPriceChangeSets — headers, newest first by (createdAt, id), keyset paginated. */
  list(input: ChangeSetReadInput, query: ListChangeSetsQuery): Promise<PriceChangeSetPageBody> {
    const filters = { state: query.state ?? null, kind: query.kind ?? null };
    const cursor = query.cursor === undefined ? null : decodeChangeSetListCursor(query.cursor, filters);
    const limit = query.page_size ?? DEFAULT_PAGE_SIZE;
    return this.inTenant(input, async (client) => {
      const r = await client.query<ChangeSetRow>(
        `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets c
          WHERE c.tenant_id = $1::uuid AND c.domain = 'pricing'
            AND ($2::text IS NULL OR c.state = $2) AND ($3::text IS NULL OR c.kind = $3)
            AND ($4::timestamptz IS NULL OR (c.created_at, c.id) < ($4::timestamptz, $5::uuid))
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $6`,
        [input.tenantId, filters.state, filters.kind, cursor?.createdKey ?? null, cursor?.id ?? null, limit + 1],
      );
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map(toHeaderBody),
        nextCursor:
          r.rows.length > limit && last !== undefined
            ? encodeChangeSetListCursor({ createdKey: last.created_key, id: last.id, ...filters })
            : null,
      };
    });
  }

  /** consoleGetPriceChangeSet — the header, the current items and the stored summary. */
  get(input: ChangeSetReadInput, id: string): Promise<PriceChangeSetBody> {
    return this.inTenant(input, (client) => this.bodyOf(client, input.tenantId, id));
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** consoleCreatePriceChangeSet — a `draft` at version 1 with its item list (possibly empty). */
  create(input: ChangeSetWriteInput, body: CreatePriceChangeSetBody): Promise<PriceChangeSetBody> {
    this.assertAuthoring(input.tenantId);
    return this.inTenant(input, async (client) => {
      const book = await client.query(
        `SELECT 1 FROM price_books
          WHERE tenant_id = $1::uuid AND pricing_context = 'retail' AND retired_at IS NULL`,
        [input.tenantId],
      );
      if ((book.rowCount ?? 0) === 0) throw new PriceChangeSetConflictError("price_book_missing");
      const id = newId();
      const correlationId = correlationOf(input);
      await client.query(
        `INSERT INTO change_sets (id, tenant_id, domain, kind, title, reason, created_by_user_id, correlation_id)
         VALUES ($1, $2, 'pricing', $3, $4, $5, $6, $7)`,
        [id, input.tenantId, body.kind, body.title, body.reason ?? null, input.actorUserId, correlationId],
      );
      const items = body.items ?? [];
      await this.writeItemList(client, input, id, 1, items, correlationId);
      // Ids and counts only: the title and reason are operator free text (FR-AUDIT-3, §XIV).
      await this.audit(client, input, "created", id, { kind: body.kind, version: 1, item_count: items.length });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consoleUpdatePriceChangeSet — replaces the given fields of a `draft` or `validated` set,
   * increments its version and leaves it in `draft` with no stored preview.
   */
  update(input: ChangeSetWriteInput, id: string, body: UpdatePriceChangeSetBody): Promise<PriceChangeSetBody> {
    this.assertAuthoring(input.tenantId);
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (!EDITABLE.includes(set.state)) throw new PriceChangeSetConflictError("change_set_invalid_state");
      // A rollback set's items are generated from its target (spec 042 §8).
      if (set.kind === "rollback" && body.items !== undefined) throw new PriceChangeSetConflictError("change_set_invalid_state");
      const version = set.version + 1;
      await client.query(
        `UPDATE change_sets
            SET version = $3, state = 'draft',
                title = COALESCE($4, title), reason = COALESCE($5, reason),
                validated_at_revision = NULL, preview_hash = NULL, target_store_set_hash = NULL,
                sensitive = NULL, sensitivity_reasons = '{}'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, id, version, body.title ?? null, body.reason ?? null],
      );
      if (body.items !== undefined) {
        await this.writeItemList(client, input, id, version, body.items, correlationOf(input));
      }
      await this.audit(client, input, "updated", id, {
        kind: set.kind,
        version,
        previous_version: set.version,
        previous_state: set.state,
        items_replaced: body.items !== undefined,
        item_count: body.items?.length ?? null,
        title_changed: body.title !== undefined,
        reason_changed: body.reason !== undefined,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /** consoleCancelPriceChangeSet — `draft` / `validated` / `pending_approval` / `approved` → `cancelled`. */
  cancel(input: ChangeSetWriteInput, id: string, body: VersionedBody): Promise<PriceChangeSetBody> {
    this.assertAuthoring(input.tenantId);
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (!CANCELLABLE.includes(set.state)) throw new PriceChangeSetConflictError("change_set_invalid_state");
      await client.query(
        `UPDATE change_sets SET state = 'cancelled', cancelled_by_user_id = $3, cancelled_at = now()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, id, input.actorUserId],
      );
      await this.audit(client, input, "cancelled", id, {
        kind: set.kind,
        version: set.version,
        previous_state: set.state,
        preview_hash: set.previewHash,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** `409 pricing_authority_legacy` unless the tenant is on the authoring allowlist. */
  private assertAuthoring(tenantId: string): void {
    if (!isPricingAuthoringAllowed(this.authoring, tenantId)) {
      throw new PriceChangeSetConflictError("pricing_authority_legacy");
    }
  }

  /** One transaction under the caller's tenant (RLS, FORCE). */
  private inTenant<T>(input: ChangeSetReadInput, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, fn);
  }

  /** The set's row lock (`FOR NO KEY UPDATE`), 404 when absent, `409 version_conflict` on a stale version. */
  private async lockSet(client: PoolClient, tenantId: string, id: string, expectedVersion: number): Promise<LockedSet> {
    const r = await client.query<{ kind: LockedSet["kind"]; state: ChangeSetState; version: number; preview_hash: string | null }>(
      `SELECT kind, state, version, preview_hash FROM change_sets
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND domain = 'pricing'
        FOR NO KEY UPDATE`,
      [tenantId, id],
    );
    const row = r.rows[0];
    if (!row) throw new PriceChangeSetNotFoundError();
    if (row.version !== expectedVersion) throw new PriceChangeSetConflictError("version_conflict");
    return { kind: row.kind, state: row.state, version: row.version, previewHash: row.preview_hash };
  }

  /** A new item list at `version` with its items, in authored order (0123: sealed by this transaction). */
  private async writeItemList(
    client: PoolClient,
    input: ChangeSetWriteInput,
    id: string,
    version: number,
    items: readonly PriceChangeItem[],
    correlationId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO price_change_set_item_lists (tenant_id, change_set_id, change_set_version, item_count, created_by_user_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, id, version, items.length, input.actorUserId, correlationId],
    );
    if (items.length === 0) return;
    await client.query(
      `INSERT INTO price_change_set_items
         (tenant_id, change_set_id, change_set_version, position, op, item, created_by_user_id, correlation_id)
       SELECT $1, $2, $3, e.ord, e.item ->> 'op', e.item, $4, $5
         FROM jsonb_array_elements($6::jsonb) WITH ORDINALITY AS e(item, ord)`,
      [input.tenantId, id, version, input.actorUserId, correlationId, JSON.stringify(items)],
    );
  }

  /** The `PriceChangeSet` body: header, the current item list and the stored summary. */
  private async bodyOf(client: PoolClient, tenantId: string, id: string): Promise<PriceChangeSetBody> {
    const r = await client.query<ChangeSetRow>(
      `SELECT ${CHANGE_SET_COLUMNS} FROM change_sets c WHERE c.tenant_id = $1::uuid AND c.id = $2::uuid AND c.domain = 'pricing'`,
      [tenantId, id],
    );
    const row = r.rows[0];
    if (!row) throw new PriceChangeSetNotFoundError();
    const items = await client.query<{ item: PriceChangeItem }>(
      `SELECT i.item FROM price_change_set_items i
        WHERE i.tenant_id = $1::uuid AND i.change_set_id = $2::uuid
          AND i.change_set_version = (SELECT max(l.change_set_version) FROM price_change_set_item_lists l
                                       WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid
                                         AND l.change_set_version <= $3)
        ORDER BY i.position`,
      [tenantId, id, row.version],
    );
    let summary: Record<string, unknown> | null = null;
    if (row.preview_hash !== null) {
      const v = await client.query<{ summary: Record<string, unknown> }>(
        `SELECT summary FROM price_change_set_validations
          WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3 AND preview_hash = $4`,
        [tenantId, id, row.version, row.preview_hash],
      );
      summary = v.rows[0]?.summary ?? null;
    }
    return { header: toHeaderBody(row), items: items.rows.map((i) => i.item), summary };
  }

  private audit(
    client: PoolClient,
    input: ChangeSetWriteInput,
    transition: "created" | "updated" | "cancelled",
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return insertAuditRowInTransaction(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      storeId: null,
      action: `pricing.change_set.${transition}`,
      targetType: "price_change_set",
      targetId: id,
      requestId: uuidRequestId(input),
      metadata: { change_set_id: id, ...metadata },
    });
  }
}
