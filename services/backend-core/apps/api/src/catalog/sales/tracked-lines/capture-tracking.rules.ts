/**
 * Jira RT-451 slice S3 — the pure G7-9 ingest classification of one captured
 * line while tracked selling is on (`pos-sales/sales.yaml` `captureSale`,
 * "Tracked selling ON"; RT-50 G7-9, Q5). Capture never refuses a line for
 * tracking reasons: every line is accepted and classified.
 *
 * When several rows match, the lower (more severe) row wins:
 *
 *   4. unresolved  a tracked product's line without `tracking`
 *                  (`tracking_missing`), an `identityId` unknown in the tenant
 *                  (`identity_unknown`) or another product's identity
 *                  (`identity_other_product`). No finding: the sale goes to
 *                  the Tracking Resolution queue.
 *   3. flagged     the exact identity, expired at the sale's business date
 *                  (or, for an `expiry_required` product, without an expiry:
 *                  fail closed, RT-451 comment 16246), or with no ERP edge-map
 *                  row: `erp_intent_held` (`expired`, `edge_map_missing`).
 *   2. flagged     the exact identity, without a `validationId` or with one
 *                  that does not match an accepted validation of that identity
 *                  at this store, or held or recalled at `occurredAt`:
 *                  `unvalidated_tracked_line` (`validation_missing`,
 *                  `validation_mismatch`), `sold_under_hold` (`quality_hold`,
 *                  `recall_hold`).
 *   1. valid       none of the above.
 *
 * Rows 2 and 3 can hold together: each cause is its own finding (one per
 * line, kind and cause; owner decision 2026-11-03). A line that is neither
 * tracked nor carries `tracking` is not classified (null).
 */
import type { SaleLineFindingCause, SaleLineFindingKind } from "@data-pulse-2/db/schema";

export type TrackingUnresolvedReason = "tracking_missing" | "identity_unknown" | "identity_other_product";

/** The identity the line's `identityId` names in the tenant (batch identities only, as the TLV). */
export interface CapturedIdentityFacts {
  readonly productId: string;
  readonly expiryDate: string | null;
  readonly hasEdgeMap: boolean;
}

/** The facts the classification of one line needs, read in the capture transaction. */
export interface CapturedLineFacts {
  /** The line's `tenantProductRef`, or null for an ad-hoc line. */
  readonly productId: string | null;
  /** The product's Tracking Profile mode (`none` | `batch` | `serial`); null without a product. */
  readonly trackingMode: string | null;
  readonly expiryRequired: boolean;
  /** The line carries `tracking`. */
  readonly hasTracking: boolean;
  /** The named identity, or null when unknown (or the line carries no `tracking`). */
  readonly identity: CapturedIdentityFacts | null;
  /** The line's `validationId`, if sent. */
  readonly validationSent: boolean;
  /** The validation is an accepted TLV record of this identity at this store. */
  readonly validationMatches: boolean;
  /** Holds of the identity active at `occurredAt`. */
  readonly qualityHoldId: string | null;
  readonly recallHoldId: string | null;
  /** The sale's business date (`YYYY-MM-DD`). */
  readonly businessDate: string;
}

export interface LineFinding {
  readonly kind: SaleLineFindingKind;
  readonly cause: SaleLineFindingCause;
  readonly holdId: string | null;
}

export type LineClassification =
  | { readonly trackingClass: null }
  | { readonly trackingClass: "unresolved"; readonly reason: TrackingUnresolvedReason }
  | { readonly trackingClass: "valid" }
  | { readonly trackingClass: "flagged"; readonly findings: readonly LineFinding[] };

const TRACKED_MODES = new Set(["batch", "serial"]);

export function isTrackedMode(mode: string | null): boolean {
  return mode !== null && TRACKED_MODES.has(mode);
}

export function classifyCapturedLine(line: CapturedLineFacts): LineClassification {
  if (!line.hasTracking) {
    return isTrackedMode(line.trackingMode)
      ? { trackingClass: "unresolved", reason: "tracking_missing" }
      : { trackingClass: null };
  }
  const { identity } = line;
  if (identity === null) return { trackingClass: "unresolved", reason: "identity_unknown" };
  if (line.productId === null || identity.productId !== line.productId) {
    return { trackingClass: "unresolved", reason: "identity_other_product" };
  }
  const findings: LineFinding[] = [];
  if (!line.validationSent) {
    findings.push({ kind: "unvalidated_tracked_line", cause: "validation_missing", holdId: null });
  } else if (!line.validationMatches) {
    findings.push({ kind: "unvalidated_tracked_line", cause: "validation_mismatch", holdId: null });
  }
  if (line.qualityHoldId !== null) {
    findings.push({ kind: "sold_under_hold", cause: "quality_hold", holdId: line.qualityHoldId });
  }
  if (line.recallHoldId !== null) {
    findings.push({ kind: "sold_under_hold", cause: "recall_hold", holdId: line.recallHoldId });
  }
  if (isExpired(identity.expiryDate, line.expiryRequired, line.businessDate)) {
    findings.push({ kind: "erp_intent_held", cause: "expired", holdId: null });
  }
  if (!identity.hasEdgeMap) {
    findings.push({ kind: "erp_intent_held", cause: "edge_map_missing", holdId: null });
  }
  return findings.length === 0 ? { trackingClass: "valid" } : { trackingClass: "flagged", findings };
}

/**
 * G7-5: a lot is sellable through its expiry date, inclusive. Without an
 * expiry it is expired only when the product requires one (fail closed). ISO
 * `YYYY-MM-DD` strings compare in calendar order.
 */
function isExpired(expiryDate: string | null, expiryRequired: boolean, businessDate: string): boolean {
  if (expiryDate === null) return expiryRequired;
  return expiryDate < businessDate;
}

/** The sale's tracking status: null when no line was classified. */
export function saleTrackingStatus(
  classes: ReadonlyArray<LineClassification>,
): "tracked" | "tracking_unresolved" | null {
  if (classes.some((c) => c.trackingClass === "unresolved")) return "tracking_unresolved";
  return classes.some((c) => c.trackingClass !== null) ? "tracked" : null;
}
