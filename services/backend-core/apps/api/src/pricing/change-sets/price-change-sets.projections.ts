/**
 * RT-1484 (RT-282 PR-09b) — wire projections, the list keyset cursor and the service errors of
 * `pricing/price-change-sets.yaml` 1.0.0-draft (`PriceChangeSetHeader`, `PriceChangeSet`,
 * `PriceChangeSetPage`). Pure: the unit spec drives them with rows.
 *
 * No projection carries `tenant_id`, `domain` or `correlation_id` (not in the contract schemas,
 * which are `additionalProperties: false`).
 */
import { z } from "zod";

import { decodeOpaque, encodeOpaque, InvalidCursorError } from "../../common/cursor/opaque-cursor";
import { isRfc3339Instant } from "../pricing-query";
import type { PriceChangeItem } from "./price-change-sets.dto";

// ---------------------------------------------------------------------------
// Errors (mapped to HTTP by the controller)
// ---------------------------------------------------------------------------

/** A set of another tenant, or absent → the non-disclosing 404. */
export class PriceChangeSetNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "PriceChangeSetNotFoundError";
  }
}

export type PriceChangeSetConflictCode =
  | "version_conflict"
  | "change_set_invalid_state"
  | "change_set_not_validated"
  | "price_book_missing"
  | "pricing_authority_legacy";

/** A 409 of the contract's `Conflict` list; nothing was written. */
export class PriceChangeSetConflictError extends Error {
  constructor(readonly code: PriceChangeSetConflictCode) {
    super(code);
    this.name = "PriceChangeSetConflictError";
  }
}

export type PriceChangeSetUnprocessableCode =
  | "change_set_empty"
  | "change_set_too_large"
  | "change_set_no_target_store"
  | "lead_time_violation";

/** A 422 of the contract's `ValidateUnprocessable` list; nothing was stored. */
export class PriceChangeSetUnprocessableError extends Error {
  constructor(
    readonly code: PriceChangeSetUnprocessableCode,
    message: string,
  ) {
    super(message);
    this.name = "PriceChangeSetUnprocessableError";
  }
}

/** A list cursor this operation did not issue → 400 `validation_error`. */
export class ChangeSetListCursorError extends InvalidCursorError {
  constructor(message?: string) {
    super(message);
    this.name = "ChangeSetListCursorError";
  }
}

// ---------------------------------------------------------------------------
// Rows and bodies
// ---------------------------------------------------------------------------

export type ChangeSetState =
  | "draft"
  | "validated"
  | "pending_approval"
  | "approved"
  | "published"
  | "superseded"
  | "rolled_back"
  | "cancelled";
export type ChangeSetKind = "standard" | "emergency" | "rollback" | "legacy_import";

/** A `change_sets` row as the service selects it (`CHANGE_SET_COLUMNS`). */
export interface ChangeSetRow {
  id: string;
  kind: ChangeSetKind;
  title: string;
  reason: string | null;
  state: ChangeSetState;
  version: number;
  validated_at_revision: string | null;
  preview_hash: string | null;
  sensitive: boolean | null;
  sensitivity_reasons: string[];
  revision_no: string | null;
  rolls_back_change_set_id: string | null;
  rolled_back_by_change_set_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  submitted_by_user_id: string | null;
  submitted_at: Date | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  published_by_user_id: string | null;
  published_at: Date | null;
  cancelled_by_user_id: string | null;
  cancelled_at: Date | null;
  rejected_by_user_id: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  /** The keyset position, canonical UTC text with microseconds. */
  created_key: string;
}

interface ActorBody {
  readonly userId: string;
  readonly at: string;
}

export interface PriceChangeSetHeaderBody {
  readonly id: string;
  readonly kind: ChangeSetKind;
  readonly title: string;
  readonly reason: string | null;
  readonly state: ChangeSetState;
  readonly publicationStatus: "scheduled" | "active" | null;
  readonly version: number;
  readonly validatedAtRevision: number | null;
  readonly previewHash: string | null;
  readonly sensitive: boolean | null;
  readonly sensitivityReasons: readonly string[];
  readonly revisionNo: number | null;
  readonly rollsBackChangeSetId: string | null;
  readonly rolledBackByChangeSetId: string | null;
  readonly created: ActorBody;
  readonly submitted: ActorBody | null;
  readonly approved: ActorBody | null;
  readonly published: ActorBody | null;
  readonly cancelled: ActorBody | null;
  readonly lastRejection: { readonly userId: string; readonly at: string; readonly reason: string } | null;
}

export interface PriceChangeSetBody {
  readonly header: PriceChangeSetHeaderBody;
  readonly items: readonly PriceChangeItem[];
  /** The stored preview summary (`PreviewSummary`); null when not validated. */
  readonly summary: Readonly<Record<string, unknown>> | null;
}

export interface PriceChangeSetPageBody {
  readonly items: readonly PriceChangeSetHeaderBody[];
  readonly nextCursor: string | null;
}

function actor(userId: string | null, at: Date | null): ActorBody | null {
  return userId === null || at === null ? null : { userId, at: at.toISOString() };
}

const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * The header of a row. `publicationStatus` is null: a set reaches `published` only through the
 * publish of a later RT-1484 slice (PR-5), which computes it at read time (spec 042 §3).
 */
export function toHeaderBody(row: ChangeSetRow): PriceChangeSetHeaderBody {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    state: row.state,
    publicationStatus: null,
    version: row.version,
    validatedAtRevision: toNumber(row.validated_at_revision),
    previewHash: row.preview_hash,
    sensitive: row.sensitive,
    sensitivityReasons: row.sensitivity_reasons,
    revisionNo: toNumber(row.revision_no),
    rollsBackChangeSetId: row.rolls_back_change_set_id,
    rolledBackByChangeSetId: row.rolled_back_by_change_set_id,
    created: { userId: row.created_by_user_id, at: row.created_at.toISOString() },
    submitted: actor(row.submitted_by_user_id, row.submitted_at),
    approved: actor(row.approved_by_user_id, row.approved_at),
    published: actor(row.published_by_user_id, row.published_at),
    cancelled: actor(row.cancelled_by_user_id, row.cancelled_at),
    lastRejection:
      row.rejected_by_user_id === null || row.rejected_at === null || row.rejection_reason === null
        ? null
        : { userId: row.rejected_by_user_id, at: row.rejected_at.toISOString(), reason: row.rejection_reason },
  };
}

// ---------------------------------------------------------------------------
// The list cursor
// ---------------------------------------------------------------------------

/** The continuation of `consoleListPriceChangeSets`: the last (createdAt, id) served and the filters. */
export interface ChangeSetListCursor {
  readonly createdKey: string;
  readonly id: string;
  readonly state: ChangeSetState | null;
  readonly kind: ChangeSetKind | null;
}

const ListCursorSchema = z
  .object({
    v: z.literal(1),
    c: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    k: z.string().uuid(),
    s: z.string().max(32).nullable(),
    n: z.string().max(32).nullable(),
  })
  .strict();

export function encodeChangeSetListCursor(cursor: ChangeSetListCursor): string {
  return encodeOpaque({ v: 1, c: cursor.createdKey, k: cursor.id, s: cursor.state, n: cursor.kind });
}

/** The cursor's payload, bound to the request's filters; anything else is a `ChangeSetListCursorError`. */
export function decodeChangeSetListCursor(
  raw: string,
  filters: { readonly state: ChangeSetState | null; readonly kind: ChangeSetKind | null },
): ChangeSetListCursor {
  const p = decodeOpaque(raw, ListCursorSchema, () => new ChangeSetListCursorError());
  // A real calendar instant (RT-1484 comment 17881, follow-up 1): `Date.parse` rolls `02-31`
  // over, Postgres refuses it with a 500.
  if (p.s !== filters.state || p.n !== filters.kind || !isRfc3339Instant(p.c)) {
    throw new ChangeSetListCursorError("the cursor belongs to another filter");
  }
  return { createdKey: p.c, id: p.k, state: filters.state, kind: filters.kind };
}
