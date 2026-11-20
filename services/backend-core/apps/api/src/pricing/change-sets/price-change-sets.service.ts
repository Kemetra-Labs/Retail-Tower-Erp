/**
 * PriceChangeSetsService — RT-1484 (RT-282 PR-09b): the authoring runtime of
 * `pricing/price-change-sets.yaml` 1.0.0-draft (list, create, get, update, cancel) over 0121
 * `change_sets` and 0123 `price_change_set_item_lists` / `price_change_set_items` (read:
 * `price_change_set_validations` for a stored summary), plus validate and preview (PR-4b, RT-282
 * PR-10a) over the 0123 validation, line and preview tables (`price-change-set-validation*.ts`,
 * `price-change-set-preview.ts`), and submit, approve, reject and publish (RT-282 PR-10b:
 * `price-change-set-approval.ts`, `price-change-set-staleness.ts`, `price-change-set-publish.ts`).
 * Rollback is a later slice (PR-6).
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant RLS, FORCE,
 * `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on every statement; the
 * tenant and the actor are the session's (§II, §XII). Audit rows go through the `audit` port.
 *
 * Writes. Each is ONE transaction: the change, its `audit_events` row
 * (`pricing.change_set.<transition>`, spec 042 §10) and the body it answers with.
 *   - The authoring gate is `PricingAuthoringGuard` on the controller (RT-1484 comment 17881,
 *     follow-up 5): every non-GET route of a tenant not on `PRICING_AUTHORING_TENANT_ALLOWLIST` is
 *     `409 pricing_authority_legacy` before it reaches this service.
 *   - The system `legacy_import` set is never edited, cancelled or validated here
 *     (`409 change_set_invalid_state`, follow-up 3).
 *   - Audit metadata holds ids, counts, `kind` and `reason_present`, never the free-text reason,
 *     which stays on the set row (FR-AUDIT-3; follow-up 4, spec 042 §10).
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
import { liveAndNamedStores } from "../../stores";
import type {
  ApprovePriceChangeSetBody,
  CreatePriceChangeSetBody,
  RejectPriceChangeSetBody,
  SubmitPriceChangeSetBody,
  ListChangeSetsQuery,
  PreviewQuery,
  PriceChangeItem,
  UpdatePriceChangeSetBody,
  VersionedBody,
} from "./price-change-sets.dto";
import { DEFAULT_MIN_LEAD_TIME_MS, violatesLeadTime } from "./price-change-set-lead-time";
import { bindPreviewCursor, parsePreviewCursor, readPreviewPage, type PriceChangeSetPreviewBody } from "./price-change-set-preview";
import { lockPricingPublish, lockPricingValidate } from "../pricing-publish-lock";
import { isSelfApproval, missingAcknowledgements, requiredAcknowledgements, type FindingPresence } from "./price-change-set-approval";
import { replacedStillActive, writePublication } from "./price-change-set-publish";
import { checkStaleness, loadStoredLines, type StalenessInput } from "./price-change-set-staleness";
import { checkBudget, referencedIds, validateChangeSet } from "./price-change-set-validation";
import {
  headRevision,
  loadCurrentItems,
  loadRetailBook,
  loadPricingContext,
  loadReachContext,
  writeValidation,
} from "./price-change-set-validation.repository";
import {
  decodeChangeSetListCursor,
  encodeChangeSetListCursor,
  PriceChangeSetConflictError,
  PriceChangeSetForbiddenError,
  PriceChangeSetNotFoundError,
  PriceChangeSetUnprocessableError,
  toHeaderBody,
  type ChangeSetRow,
  type ChangeSetState,
  type PriceChangeSetBody,
  type PriceChangeSetPageBody,
  type PublishPriceChangeSetBody,
} from "./price-change-sets.projections";

/** The `pricing.change_set.<transition>` audit actions (spec 042 §10). */
type AuditTransition =
  | "created"
  | "updated"
  | "cancelled"
  | "validated"
  | "submitted"
  | "approved"
  | "rejected"
  | "published"
  | "superseded"
  | "stale";

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
       CASE WHEN c.state = 'published' THEN
         CASE WHEN COALESCE((SELECT min(q.at) FROM (
                SELECT min(p.effective_from) AS at FROM price_change_set_preview_lines p
                 WHERE p.tenant_id = c.tenant_id AND p.change_set_id = c.id AND p.change_set_version = c.version
                UNION ALL
                SELECT min(m.effective_from) FROM price_change_set_preview_memberships m
                 WHERE m.tenant_id = c.tenant_id AND m.change_set_id = c.id AND m.change_set_version = c.version) q),
              '-infinity'::timestamptz) <= now() THEN 'active' ELSE 'scheduled' END
       END AS publication_status,
       to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key`;

/** The request id when it is a UUID (the audit row's `request_id` is uuid), else null. */
function uuidRequestId(input: ChangeSetWriteInput): string | null {
  return input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null;
}

/** `correlation_id` is NOT NULL uuid: the request id when it is one, else a fresh id. */
function correlationOf(input: ChangeSetWriteInput): string {
  return uuidRequestId(input) ?? newId();
}

/**
 * RT-1484 PR-10b: the stored preview's `summary.blocking` and which acknowledgeable findings it
 * holds (`price-change-set-approval.ts`): `replaces` when a line supersedes an event or membership,
 * `invalidates_dependent` when a preview row carries it, `rounded_price` when a helper line was
 * rounded. No validation at the version reads as blocking (fail closed; 0123 makes it unreachable).
 */
async function approvalFactsOf(client: PoolClient, tenantId: string, id: string, version: number): Promise<ApprovalFacts> {
  const r = await client.query<ApprovalFacts>(
    `SELECT COALESCE((v.summary ->> 'blocking')::boolean, true) AS blocking,
            EXISTS (SELECT 1 FROM price_change_set_lines l
                     WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3
                       AND cardinality(l.replaced_ids) > 0) AS replaces,
            EXISTS (SELECT 1 FROM price_change_set_preview_lines p
                     WHERE p.tenant_id = $1::uuid AND p.change_set_id = $2::uuid AND p.change_set_version = $3
                       AND (p.class = 'invalidates_dependent' OR 'invalidates_dependent' = ANY (p.messages))) AS invalidates_dependent,
            EXISTS (SELECT 1 FROM price_change_set_lines l
                     WHERE l.tenant_id = $1::uuid AND l.change_set_id = $2::uuid AND l.change_set_version = $3
                       AND l.rounded_from IS NOT NULL)
            OR EXISTS (SELECT 1 FROM price_change_set_preview_lines p
                        WHERE p.tenant_id = $1::uuid AND p.change_set_id = $2::uuid AND p.change_set_version = $3
                          AND 'rounded_price' = ANY (p.messages)) AS rounded_price
       FROM (SELECT 1) one
       LEFT JOIN price_change_set_validations v
         ON v.tenant_id = $1::uuid AND v.change_set_id = $2::uuid AND v.change_set_version = $3`,
    [tenantId, id, version],
  );
  return r.rows[0] ?? { blocking: true, replaces: true, invalidates_dependent: true, rounded_price: true };
}

/**
 * The one Store a set's current items target, or null (spec 042 §10 `store_id`): every item is a
 * `stores` item or a Zone move, all naming the same single Store, and that Store is the tenant's.
 * A Book or Zone item reaches every Store in its scope, so such a set has none.
 */
async function singleStoreOf(client: PoolClient, tenantId: string, id: string): Promise<string | null> {
  const v = await client.query<{ version: number }>(`SELECT version FROM change_sets WHERE tenant_id = $1::uuid AND id = $2::uuid`, [tenantId, id]);
  const version = v.rows[0]?.version;
  if (version === undefined) return null;
  const { items } = await loadCurrentItems(client, tenantId, id, version);
  if (items.length === 0 || items.some(({ item }) => item.op !== "move_store_zone" && item.scope.kind !== "stores")) return null;
  const stores = referencedIds(items).storeIds;
  if (stores.length !== 1) return null;
  const known = await liveAndNamedStores(client, tenantId, stores);
  return known.some((s) => s.id === stores[0]) ? stores[0]! : null;
}

/** The set row as a write sees it, under its row lock. */
interface LockedSet {
  readonly kind: ChangeSetRow["kind"];
  readonly state: ChangeSetState;
  readonly version: number;
  readonly previewHash: string | null;
  readonly reasonPresent: boolean;
  readonly sensitive: boolean | null;
  readonly validatedAtRevision: number | null;
  readonly createdBy: string;
  readonly submittedBy: string | null;
  readonly approvedBy: string | null;
}

/** A transition refused as `409 stale_validation` after the set's return to `draft` committed. */
const STALE = Symbol("stale");

/** The stored preview's facts submit and approve check (blocking, acknowledgeable findings). */
interface ApprovalFacts extends FindingPresence {
  readonly blocking: boolean;
}

@Injectable()
export class PriceChangeSetsService {
  /** "Now" for `past_dated` and the lead time (ms since the epoch). */
  clock: () => number = Date.now;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
      await this.audit(client, input, "created", id, {
        kind: body.kind,
        version: 1,
        reason_present: body.reason !== undefined,
        item_count: items.length,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consoleUpdatePriceChangeSet — replaces the given fields of a `draft` or `validated` set,
   * increments its version and leaves it in `draft` with no stored preview.
   */
  update(input: ChangeSetWriteInput, id: string, body: UpdatePriceChangeSetBody): Promise<PriceChangeSetBody> {
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (!EDITABLE.includes(set.state) || set.kind === "legacy_import") {
        throw new PriceChangeSetConflictError("change_set_invalid_state");
      }
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
        reason_present: set.reasonPresent || body.reason !== undefined,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /** consoleCancelPriceChangeSet — `draft` / `validated` / `pending_approval` / `approved` → `cancelled`. */
  cancel(input: ChangeSetWriteInput, id: string, body: VersionedBody): Promise<PriceChangeSetBody> {
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      // The system legacy import is never cancelled here (RT-1484 comment 17881, follow-up 3).
      if (!CANCELLABLE.includes(set.state) || set.kind === "legacy_import") {
        throw new PriceChangeSetConflictError("change_set_invalid_state");
      }
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
        reason_present: set.reasonPresent,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consoleValidatePriceChangeSet — materializes the current item list at the head revision,
   * classifies every line, stores the Impact Preview (0123 validation, lines, preview rows,
   * membership changes) and moves the `draft` to `validated` at the same version, even when some
   * lines block submit. Refusals store nothing: `422` (`change_set_empty`, `change_set_too_large`,
   * `change_set_no_target_store`, `lead_time_violation`), `409` (`version_conflict`,
   * `change_set_invalid_state` outside `draft` or for the system legacy import,
   * `price_book_missing`).
   */
  validate(input: ChangeSetWriteInput, id: string, body: VersionedBody): Promise<PriceChangeSetBody> {
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (set.state !== "draft" || set.kind === "legacy_import") throw new PriceChangeSetConflictError("change_set_invalid_state");
      // Review round 4: validations of one tenant serialize (lock order: this set's row, then the
      // tenant validate lock), so this one reads every earlier validation's lines as pending.
      await lockPricingValidate(client, input.tenantId);
      const { listVersion, items } = await loadCurrentItems(client, input.tenantId, id, set.version);
      if (listVersion === null || items.length === 0) {
        throw new PriceChangeSetUnprocessableError("change_set_empty", "The Change Set has no items.");
      }
      const book = await loadRetailBook(client, input.tenantId);
      if (book === null) throw new PriceChangeSetConflictError("price_book_missing");
      const nowMs = this.clock();
      const revision = await headRevision(client, input.tenantId);
      const reach = await loadReachContext(client, { tenantId: input.tenantId, kind: set.kind, nowMs, revision, book, ids: referencedIds(items) });
      // Review round 1, M2: refuse an oversized set before any event is loaded or row written.
      const overBudget = checkBudget(reach, items);
      if (overBudget !== null) throw new PriceChangeSetUnprocessableError(overBudget.code, overBudget.message);
      const result = validateChangeSet(await loadPricingContext(client, reach, id), items);
      if (!result.ok) throw new PriceChangeSetUnprocessableError(result.code, result.message);
      if (violatesLeadTime({ kind: set.kind, nowMs, minLeadTimeMs: DEFAULT_MIN_LEAD_TIME_MS, effectiveMs: result.effectiveMs })) {
        throw new PriceChangeSetUnprocessableError(
          "lead_time_violation",
          "An effective instant is inside the minimum lead time.",
        );
      }
      await writeValidation(client, {
        tenantId: input.tenantId,
        changeSetId: id,
        version: set.version,
        itemListVersion: listVersion,
        bookId: book.id,
        validatedAtRevision: revision,
        previewHash: result.previewHash,
        targetStoreSetHash: result.targetStoreSetHash,
        sensitive: result.sensitive,
        sensitivityReasons: result.sensitivityReasons,
        summary: result.summary,
        targetStores: result.targetStores,
        lines: result.lines,
        previewRows: result.previewRows,
        membershipChanges: result.membershipChanges,
        actorUserId: input.actorUserId,
        correlationId: correlationOf(input),
      });
      await this.audit(client, input, "validated", id, {
        kind: set.kind,
        version: set.version,
        reason_present: set.reasonPresent,
        validated_at_revision: revision,
        preview_hash: result.previewHash,
        earliest_effective_at: result.summary.earliestEffectiveAt,
        line_count: result.lines.length,
        blocking: result.summary.blocking,
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /** consoleGetPriceChangeSetPreview — a page of the stored preview; `409 change_set_not_validated` without one. */
  preview(input: ChangeSetReadInput, id: string, query: PreviewQuery): Promise<PriceChangeSetPreviewBody> {
    // Review round 4: a malformed cursor is 400 before any read, even on a set with no preview.
    const cursor = query.cursor === undefined ? null : parsePreviewCursor(query.cursor);
    return this.inTenant(input, async (client) => {
      const r = await client.query<{ version: number; preview_hash: string | null }>(
        `SELECT version, preview_hash FROM change_sets WHERE tenant_id = $1::uuid AND id = $2::uuid AND domain = 'pricing'`,
        [input.tenantId, id],
      );
      const row = r.rows[0];
      if (!row) throw new PriceChangeSetNotFoundError();
      if (row.preview_hash === null) throw new PriceChangeSetConflictError("change_set_not_validated");
      const cls = query.class ?? null;
      const after = cursor === null ? 0 : bindPreviewCursor(cursor, cls, row.preview_hash);
      const page = await readPreviewPage(client, {
        tenantId: input.tenantId,
        changeSetId: id,
        version: row.version,
        previewHash: row.preview_hash,
        cls,
        afterRowNo: after,
        limit: query.page_size ?? DEFAULT_PAGE_SIZE,
      });
      if (page === null) throw new PriceChangeSetConflictError("change_set_not_validated");
      return page;
    });
  }

  // -------------------------------------------------------------------------
  // Approval and publish (RT-1484 PR-10b, RT-282 PR-10b)
  // -------------------------------------------------------------------------

  /**
   * consoleSubmitPriceChangeSet — `validated` → `pending_approval` (a sensitive set: every set in
   * v1, Q-B1) or straight to `approved` (a non-sensitive one, the submit being its approval).
   * Refusals, in order: `409 version_conflict`, `409 change_set_invalid_state`, `422
   * blocking_findings`, `422 acknowledgement_required`, then `409 stale_validation` (the set returns
   * to `draft` at version + 1, and that return commits).
   */
  submit(input: ChangeSetWriteInput, id: string, body: SubmitPriceChangeSetBody): Promise<PriceChangeSetBody> {
    return this.staleAware(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (set.state !== "validated" || set.kind === "legacy_import") throw new PriceChangeSetConflictError("change_set_invalid_state");
      const straightToApproved = set.sensitive === false;
      await this.requireApprovable(client, input.tenantId, id, set, { kind: "submit", straightToApproved }, body.acknowledgedFindings);
      const fresh = await this.freshness(client, input, id, set);
      if (fresh === STALE) return STALE;
      await client.query(
        `UPDATE change_sets
            SET state = $3, submitted_by_user_id = $4, submitted_at = now(), validated_at_revision = $5,
                approved_by_user_id = CASE WHEN $6::boolean THEN $4::uuid END,
                approved_at = CASE WHEN $6::boolean THEN now() END
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, id, straightToApproved ? "approved" : "pending_approval", input.actorUserId, fresh, straightToApproved],
      );
      await this.audit(client, input, "submitted", id, {
        ...this.auditBase(set),
        validated_at_revision: fresh,
        auto_approved: straightToApproved,
        sensitive: set.sensitive,
        acknowledged_findings: body.acknowledgedFindings ?? [],
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consoleApprovePriceChangeSet — `pending_approval` → `approved` for exactly the shown preview.
   * Refusals, in order: `409 version_conflict`, `409 change_set_invalid_state`, `409
   * preview_changed`, `403 self_approval_forbidden` (four eyes), `422 blocking_findings`, `422
   * acknowledgement_required`, then `409 stale_validation` (the return to `draft` commits).
   */
  approve(input: ChangeSetWriteInput, id: string, body: ApprovePriceChangeSetBody): Promise<PriceChangeSetBody> {
    return this.staleAware(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (set.state !== "pending_approval") throw new PriceChangeSetConflictError("change_set_invalid_state");
      if (set.previewHash !== body.previewHash) throw new PriceChangeSetConflictError("preview_changed");
      if (isSelfApproval(set, input.actorUserId)) throw new PriceChangeSetForbiddenError("self_approval_forbidden");
      await this.requireApprovable(client, input.tenantId, id, set, { kind: "approve" }, body.acknowledgedFindings);
      const fresh = await this.freshness(client, input, id, set);
      if (fresh === STALE) return STALE;
      await client.query(
        `UPDATE change_sets SET state = 'approved', approved_by_user_id = $3, approved_at = now(), validated_at_revision = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, id, input.actorUserId, fresh],
      );
      await this.audit(client, input, "approved", id, {
        ...this.auditBase(set),
        validated_at_revision: fresh,
        submitted_by_user_id: set.submittedBy,
        acknowledged_findings: body.acknowledgedFindings ?? [],
      });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consoleRejectPriceChangeSet — `pending_approval` → `draft` at version + 1 with the reason as
   * `lastRejection`; the validation binding and the submission are cleared (a new validation and
   * submit follow). Any `owner` / `tenant_admin` may reject, the submitter too (a withdrawal).
   */
  reject(input: ChangeSetWriteInput, id: string, body: RejectPriceChangeSetBody): Promise<PriceChangeSetBody> {
    return this.inTenant(input, async (client) => {
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (set.state !== "pending_approval") throw new PriceChangeSetConflictError("change_set_invalid_state");
      const version = await this.returnToDraft(client, input.tenantId, id, set);
      await client.query(
        `UPDATE change_sets SET rejected_by_user_id = $3, rejected_at = now(), rejection_reason = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, id, input.actorUserId, body.reason],
      );
      // The rejection reason is operator free text: it stays on the set row (FR-AUDIT-3).
      await this.audit(client, input, "rejected", id, { ...this.auditBase(set), version, previous_version: set.version, rejection_reason_present: true });
      return this.bodyOf(client, input.tenantId, id);
    });
  }

  /**
   * consolePublishPriceChangeSet — `approved` → `published` as ONE immutable Pricing Revision,
   * all-or-nothing, under the tenant's pricing publish lock (taken first). Refusals, in order:
   * `409 version_conflict`, `409 change_set_invalid_state` (not `approved`; a `rollback` set is
   * RT-1484 PR-6's), `403 self_approval_forbidden` (an approval by the set's author or submitter:
   * the emergency path too, Q-B3), then `409 stale_validation` (the return to `draft` commits).
   */
  async publish(input: ChangeSetWriteInput, id: string, body: VersionedBody): Promise<PublishPriceChangeSetBody> {
    let revisionNo = 0;
    const changeSet = await this.staleAware(input, async (client) => {
      await lockPricingPublish(client, input.tenantId);
      const set = await this.lockSet(client, input.tenantId, id, body.expectedVersion);
      if (set.state !== "approved" || set.kind === "rollback" || set.kind === "legacy_import") {
        throw new PriceChangeSetConflictError("change_set_invalid_state");
      }
      if (set.approvedBy === null || isSelfApproval(set, set.approvedBy)) throw new PriceChangeSetForbiddenError("self_approval_forbidden");
      const stored = await this.storedValidation(client, input, id, set);
      const check = await checkStaleness(client, stored.staleness);
      if (check.stale || !(await replacedStillActive(client, input.tenantId, stored.staleness.lines))) {
        await this.markStale(client, input, id, set, check.head);
        return STALE;
      }
      const result = await writePublication(client, {
        tenantId: input.tenantId,
        changeSetId: id,
        version: set.version,
        kind: set.kind,
        head: check.head,
        actorUserId: input.actorUserId,
        correlationId: correlationOf(input),
        lines: stored.staleness.lines,
        targetStoreIds: stored.staleness.targetStoreIds,
        defaultZoneId: stored.staleness.book.defaultZoneId,
      });
      revisionNo = result.revisionNo;
      await this.audit(client, input, "published", id, {
        ...this.auditBase(set),
        revision_no: result.revisionNo,
        earliest_effective_at: stored.earliestEffectiveAt,
        emergency: set.kind === "emergency",
        approved_by_user_id: set.approvedBy,
        fan_out_store_count: result.fanOutStores,
        superseded_change_set_ids: result.superseded.map((s) => s.id),
      });
      for (const s of result.superseded) {
        await this.audit(client, input, "superseded", s.id, { kind: s.kind, version: s.version, superseded_in_revision: result.revisionNo });
      }
      return this.bodyOf(client, input.tenantId, id);
    });
    return { revisionNo, changeSet };
  }

  /** Runs a transition that may end stale: a `STALE` result commits its return to draft, then answers 409. */
  private async staleAware(input: ChangeSetWriteInput, fn: (client: PoolClient) => Promise<PriceChangeSetBody | typeof STALE>): Promise<PriceChangeSetBody> {
    const result = await this.inTenant(input, fn);
    if (result === STALE) throw new PriceChangeSetConflictError("stale_validation");
    return result;
  }

  /** `422 blocking_findings`, then `422 acknowledgement_required`, from the stored preview. */
  private async requireApprovable(
    client: PoolClient,
    tenantId: string,
    id: string,
    set: LockedSet,
    transition: Parameters<typeof requiredAcknowledgements>[0],
    given: readonly string[] | undefined,
  ): Promise<void> {
    const facts = await approvalFactsOf(client, tenantId, id, set.version);
    if (facts.blocking) {
      throw new PriceChangeSetUnprocessableError("blocking_findings", "The preview has blocking lines; fix the items and validate again.");
    }
    const missing = missingAcknowledgements(requiredAcknowledgements(transition, facts), given);
    if (missing.length > 0) {
      throw new PriceChangeSetUnprocessableError("acknowledgement_required", `Acknowledge every finding of the preview: ${missing.join(", ")}.`);
    }
  }

  /**
   * The staleness check of submit and approve (§3): `STALE` after the set's return to draft, else
   * the revision its validation now stands at (the head when no later revision intersects it).
   */
  private async freshness(client: PoolClient, input: ChangeSetWriteInput, id: string, set: LockedSet): Promise<number | typeof STALE> {
    const stored = await this.storedValidation(client, input, id, set);
    const check = await checkStaleness(client, stored.staleness);
    if (!check.stale) return Math.max(check.head, stored.staleness.validatedAtRevision);
    await this.markStale(client, input, id, set, check.head);
    return STALE;
  }

  /** What the staleness check and publish read of the set's validation at its version. */
  private async storedValidation(
    client: PoolClient,
    input: ChangeSetWriteInput,
    id: string,
    set: LockedSet,
  ): Promise<{ staleness: StalenessInput; earliestEffectiveAt: string | null }> {
    const v = await client.query<{ target_store_set_hash: string; target_stores: { storeId: string }[]; earliest: string | null }>(
      `SELECT target_store_set_hash, target_stores, summary ->> 'earliestEffectiveAt' AS earliest FROM price_change_set_validations
        WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3`,
      [input.tenantId, id, set.version],
    );
    const book = await loadRetailBook(client, input.tenantId);
    const row = v.rows[0];
    if (row === undefined || book === null || set.validatedAtRevision === null) throw new PriceChangeSetConflictError("change_set_not_validated");
    return {
      earliestEffectiveAt: row.earliest,
      staleness: {
        tenantId: input.tenantId,
        kind: set.kind,
        nowMs: this.clock(),
        book,
        validatedAtRevision: set.validatedAtRevision,
        targetStoreSetHash: row.target_store_set_hash,
        targetStoreIds: row.target_stores.map((t) => t.storeId),
        lines: await loadStoredLines(client, input.tenantId, id, set.version),
      },
    };
  }

  /** A stale set returns to `draft` at version + 1 (spec 042 §3) with one `stale` audit row. */
  private async markStale(client: PoolClient, input: ChangeSetWriteInput, id: string, set: LockedSet, head: number): Promise<void> {
    const version = await this.returnToDraft(client, input.tenantId, id, set);
    await this.audit(client, input, "stale", id, { ...this.auditBase(set), version, previous_version: set.version, previous_state: set.state, head_revision: head });
  }

  /** Back to `draft` at version + 1 with no validation binding, submission or approval (0123: a new version). */
  private async returnToDraft(client: PoolClient, tenantId: string, id: string, set: LockedSet): Promise<number> {
    const version = set.version + 1;
    await client.query(
      `UPDATE change_sets
          SET state = 'draft', version = $3, validated_at_revision = NULL, preview_hash = NULL, target_store_set_hash = NULL,
              sensitive = NULL, sensitivity_reasons = '{}', submitted_by_user_id = NULL, submitted_at = NULL,
              approved_by_user_id = NULL, approved_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, id, version],
    );
    return version;
  }

  /** The audit metadata every approval transition carries (ids and flags, never free text). */
  private auditBase(set: LockedSet): Record<string, unknown> {
    return { kind: set.kind, version: set.version, previous_state: set.state, preview_hash: set.previewHash, reason_present: set.reasonPresent };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** One transaction under the caller's tenant (RLS, FORCE). */
  private inTenant<T>(input: ChangeSetReadInput, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, fn);
  }

  /** The set's row lock (`FOR NO KEY UPDATE`), 404 when absent, `409 version_conflict` on a stale version. */
  private async lockSet(client: PoolClient, tenantId: string, id: string, expectedVersion: number): Promise<LockedSet> {
    const r = await client.query<{
      kind: LockedSet["kind"];
      state: ChangeSetState;
      version: number;
      preview_hash: string | null;
      reason_present: boolean;
      sensitive: boolean | null;
      validated_at_revision: string | null;
      created_by: string;
      submitted_by: string | null;
      approved_by: string | null;
    }>(
      `SELECT kind, state, version, preview_hash, reason IS NOT NULL AS reason_present, sensitive,
              validated_at_revision::text AS validated_at_revision, created_by_user_id::text AS created_by,
              submitted_by_user_id::text AS submitted_by, approved_by_user_id::text AS approved_by
         FROM change_sets
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND domain = 'pricing'
        FOR NO KEY UPDATE`,
      [tenantId, id],
    );
    const row = r.rows[0];
    if (!row) throw new PriceChangeSetNotFoundError();
    if (row.version !== expectedVersion) throw new PriceChangeSetConflictError("version_conflict");
    return {
      kind: row.kind,
      state: row.state,
      version: row.version,
      previewHash: row.preview_hash,
      reasonPresent: row.reason_present,
      sensitive: row.sensitive,
      validatedAtRevision: row.validated_at_revision === null ? null : Number(row.validated_at_revision),
      createdBy: row.created_by,
      submittedBy: row.submitted_by,
      approvedBy: row.approved_by,
    };
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

  /**
   * One `pricing.change_set.<transition>` row. `store_id` is the set's one target Store when it has
   * exactly one (spec 042 §10). One rule for every transition (review round 3, minor 5): the set's
   * ITEMS name exactly one Store (`singleStoreOf`), never the Stores validation happened to reach.
   */
  private async audit(
    client: PoolClient,
    input: ChangeSetWriteInput,
    transition: AuditTransition,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const storeId = await singleStoreOf(client, input.tenantId, id);
    return insertAuditRowInTransaction(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      storeId,
      action: `pricing.change_set.${transition}`,
      targetType: "price_change_set",
      targetId: id,
      requestId: uuidRequestId(input),
      metadata: { change_set_id: id, ...metadata },
    });
  }
}
