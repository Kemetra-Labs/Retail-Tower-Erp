/**
 * RT-1507 (spec 049 section 7.3, 8.1): the review decisions, pure. A decision moves one `needs_review` or `error` row:
 * `create_new` -> `ready_create`, `update_product` -> `ready_update`, `exclude` -> `excluded`, `clear` -> back to the
 * status validate gave it.
 *
 * What a decision does to the row's outcome (the contract's `RowOutcome`):
 *   - `create_new` writes the row's identifiers that validate kept (`identifierAdds`) and lists the others as
 *     `identifiersNotAdded` (a store-scoped conflict). It is offered only while no identifier on the row is active on a
 *     product (`match` is `no_match`), and never in an `update` batch.
 *   - `update_product P` recomputes the outcome against P: the field changes, and per identifier of the row: already P's
 *     is nothing, active on another product is never moved (317) and is listed as not added, a second SKU on a product that
 *     has one is not added (OD-1: `sku_mismatch` keeps P's SKU), a value another product holds at a store is not added
 *     (311), and any other is added. It is offered for a product among the row's candidates only, never in a `create`
 *     batch, never for a retired product; the product's `updated_at` is captured for the publish stale re-check (8.2).
 *   - `exclude` keeps the outcome: nothing is written for an excluded row.
 *
 * The validated state is kept inside the stored outcome under `_validated` while a decision stands, so `clear` restores
 * it exactly (the schema has no other column for it); the wire never shows the key. No I/O here.
 */
import type { ProductRef } from "./import-issues";
import type { CatalogLookups, ProductFacts } from "./import-lookups";
import type { ImportMode } from "./import-mapping";
import { computeFieldChanges, type IdentifierRef, type RowOutcome, type RowStatus } from "./import-row-evaluate";
import { identifierKey, type ParsedRow } from "./import-row-parse";

type DecisionAction = "create_new" | "update_product" | "exclude";

/** A review decision: the action and, for `update_product`, the chosen product. */
export interface Decision {
  readonly action: DecisionAction;
  readonly productId: string | null;
}

/** A stored outcome: the contract's `RowOutcome`, plus the validated outcome while a decision stands. */
export interface StoredOutcome extends RowOutcome {
  readonly _validated?: RowOutcome;
}

/** What a row was validated as: the state `clear` returns to and every decision starts from. */
export interface BaseRow {
  readonly status: RowStatus;
  readonly outcome: RowOutcome;
  /** The matched product's `updated_at` (UTC ISO, microseconds) validation stored, or null. */
  readonly matchedUpdatedAt: string | null;
}

/** The state a decision gives a row. */
export interface AppliedDecision {
  readonly status: RowStatus;
  readonly outcome: StoredOutcome;
  readonly matchedUpdatedAt: string | null;
}

/** A row as stored: its columns, with the decision. */
export interface StoredRowState {
  readonly status: RowStatus;
  readonly reviewReason: string | null;
  readonly outcome: StoredOutcome;
  readonly matchedUpdatedAt: string | null;
  readonly decision: Decision | null;
}

/** The outcome without its internal `_validated` snapshot: what the wire and the hash see. */
export function publicOutcome(outcome: StoredOutcome): RowOutcome {
  const { _validated: _snapshot, ...rest } = outcome;
  return rest;
}

/**
 * The row as validation left it. With no decision that is the stored row; with one, the snapshot (and a matched
 * `updated_at` only when validation matched the product: a decision on another row's candidate captured its own).
 */
export function baseOf(row: StoredRowState): BaseRow {
  if (row.decision === null || row.outcome._validated === undefined) {
    return { status: row.status, outcome: publicOutcome(row.outcome), matchedUpdatedAt: row.matchedUpdatedAt };
  }
  const outcome = row.outcome._validated;
  return {
    status: row.reviewReason !== null ? "needs_review" : "error",
    outcome,
    matchedUpdatedAt: outcome.match === "match" ? row.matchedUpdatedAt : null,
  };
}

/** The `clear` result: the validated state again. */
export function clearedState(row: StoredRowState): AppliedDecision {
  const base = baseOf(row);
  return { status: base.status, outcome: base.outcome, matchedUpdatedAt: base.matchedUpdatedAt };
}

/** What a decision is applied against. */
export interface DecisionContext {
  readonly mode: ImportMode;
  readonly base: BaseRow;
  readonly parsed: ParsedRow;
  readonly lookups: CatalogLookups;
}

const withSnapshot = (outcome: RowOutcome, base: BaseRow): StoredOutcome => ({ ...outcome, _validated: base.outcome });

function refOf(product: ProductFacts): ProductRef {
  return { productId: product.id, name: product.name, identifiers: product.identifiers };
}

function rowIdentifiers(parsed: ParsedRow): IdentifierRef[] {
  return parsed.identifiers.map((i) => ({ type: i.type, value: i.value }));
}

function sameIdentifier(a: IdentifierRef, b: IdentifierRef): boolean {
  return a.type === b.type && a.value === b.value;
}

function createNew(ctx: DecisionContext): AppliedDecision | null {
  const { base, parsed } = ctx;
  if (ctx.mode === "update" || base.status !== "needs_review" || base.outcome.match !== "no_match") return null;
  const adds = base.outcome.identifierAdds;
  const outcome: RowOutcome = { ...base.outcome, identifiersNotAdded: rowIdentifiers(parsed).filter((id) => !adds.some((a) => sameIdentifier(a, id))) };
  return { status: "ready_create", outcome: withSnapshot(outcome, base), matchedUpdatedAt: null };
}

/** The row's identifiers a chosen product takes, and the ones it leaves out (never moved, never a second SKU). */
function splitIdentifiers(parsed: ParsedRow, product: ProductFacts, lookups: CatalogLookups): { adds: IdentifierRef[]; notAdded: IdentifierRef[] } {
  const hasSku = product.identifiers.some((i) => i.type === "sku");
  const adds: IdentifierRef[] = [];
  const notAdded: IdentifierRef[] = [];
  for (const id of parsed.identifiers) {
    const key = identifierKey(id.type, id.value);
    const holder = lookups.tenantWide.get(key);
    if (holder === product.id) continue;
    const storeHeld = (lookups.storeScoped.get(key) ?? []).some((h) => h !== product.id);
    const left = holder !== undefined || (id.type === "sku" && hasSku) || storeHeld;
    (left ? notAdded : adds).push({ type: id.type, value: id.value });
  }
  return { adds, notAdded };
}

function updateProduct(ctx: DecisionContext, productId: string | null): AppliedDecision | null {
  const { base, parsed, lookups } = ctx;
  if (ctx.mode === "create" || base.status !== "needs_review" || productId === null) return null;
  if (!base.outcome.candidates.some((c) => c.productId === productId)) return null;
  const product = lookups.products.get(productId);
  if (product === undefined || product.retired) return null;
  const { adds, notAdded } = splitIdentifiers(parsed, product, lookups);
  const matched = base.outcome.match === "match" && base.outcome.matchedProduct?.productId === productId;
  const outcome: RowOutcome = {
    ...base.outcome,
    matchedProduct: refOf(product),
    fieldChanges: computeFieldChanges(parsed, product, lookups.categories, base.outcome.brandToCreate),
    identifierAdds: adds,
    identifiersNotAdded: notAdded,
  };
  return { status: "ready_update", outcome: withSnapshot(outcome, base), matchedUpdatedAt: matched ? base.matchedUpdatedAt : product.updatedAtText };
}

/**
 * The state a decision gives the row, or null when the action is not offered for it (the contract's `422
 * resolution_not_allowed`). An `error` row takes only `exclude`.
 */
export function applyDecision(ctx: DecisionContext, decision: Decision): AppliedDecision | null {
  const { base } = ctx;
  if (base.status !== "needs_review" && base.status !== "error") return null;
  if (decision.action === "exclude") return { status: "excluded", outcome: withSnapshot(base.outcome, base), matchedUpdatedAt: base.matchedUpdatedAt };
  if (base.status === "error") return null;
  return decision.action === "create_new" ? createNew(ctx) : updateProduct(ctx, decision.productId);
}

/** Whether a decision recorded for a row still stands after the row was validated again (spec 049 section 8.1). */
export function decisionStillStands(previous: { reviewReason: string | null; candidateIds: readonly string[]; errorCodes: readonly string[] }, next: { status: RowStatus; reviewReason: string | null; candidateIds: readonly string[]; errorCodes: readonly string[] }): boolean {
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
  if (next.status === "needs_review") return previous.reviewReason === next.reviewReason && sameSet(previous.candidateIds, next.candidateIds);
  if (next.status === "error") return previous.reviewReason === null && sameSet(previous.errorCodes, next.errorCodes);
  return false;
}
