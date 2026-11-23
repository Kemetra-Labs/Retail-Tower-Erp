/**
 * RT-1485 PR-16a-2a — the initial legacy price import (spec 044 §4.1–§4.4), run in ONE transaction
 * by the operator CLI (`cli/pricing-legacy-import.ts`). Order:
 *
 *   1. The tenant's pricing publish lock (spec 042 §8), first.
 *   2. Watermark (§4.3 step 2): the tenant's `catalog_change_log` head, read before any legacy
 *      price, and the import instant.
 *   3. Refusals, before any write: authority not `legacy` (§4.3; the cutover caller of PR-16b does
 *      not exist yet, so `cutover_in_progress` is refused too); a non-empty `price_history`; the
 *      planner's refusals (multi-currency tenant, currency mismatch, no reference zone); an
 *      existing Book whose currency or tax basis differs from the declared MC-10 inputs.
 *   4. First import (no revision yet): create the Book and default Zone when missing (§4.1), then
 *      publish the `legacy_import` set as revision 1 with one event per accepted row (§4.2). A
 *      tenant with no accepted row gets its Book and no revision ("an empty diff creates none").
 *   5. Re-run (revision 1 is the import): when the active events equal the legacy state, nothing
 *      is written but the run row (a no-op). Any difference is a delta, which this slice refuses:
 *      0123 allows a `legacy_import` set only once per tenant and only as revision 1 (owner
 *      decision RT-1151 c17827). The owner chose to amend 0123 (2026-11-23); the §4.3 delta
 *      publication lands with that amendment in PR-16a-2b.
 *      A tenant whose revisions did not start with the import is refused.
 *   6. The run row (§4.3 step 5) and the audit rows: `pricing.price_book.created` when the Book was
 *      created here, `pricing.change_set.published` when the revision was.
 *
 * Deliberate gaps of this slice, each refused rather than guessed: the delta import and its
 * scheduled run, MC-3 history import (a non-empty `price_history` refuses), and the cutover caller.
 * Nothing runs this on a real tenant before the PR-03E census is attached to RT-1485.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { insertAuditRowInTransaction } from "../../audit";
import { catalogChangeLogHead, legacyPriceHistoryCount, readLegacyPrices } from "../../catalog";
import { allStoreZones } from "../../stores";
import { lockPricingPublish } from "../pricing-publish-lock";
import { planLegacyImport, type ImportException, type ImportInputs, type PlannedEvent, type RefusalReason } from "./legacy-import-plan";
import {
  activeEvents,
  createRetailBook,
  headRevision,
  legacyImportRevision,
  publishLegacyImport,
  recordImportRun,
  retailBook,
  tenantAuthority,
  type RetailBook,
  type Writer,
} from "./legacy-import.repository";

type Queryable = Pick<PoolClient, "query">;

interface LegacyImportRequest {
  readonly tenantId: string;
  readonly inputs: ImportInputs;
  /** The operator who runs the import: `created_by_user_id` and the audit actor. */
  readonly actorUserId: string;
  readonly correlationId: string;
  /** The import instant `T` (§4.2). */
  readonly at: Date;
  /** Plan and check only: no write at all. */
  readonly dryRun: boolean;
}

type LegacyImportRefusal =
  | RefusalReason
  | "authority_not_legacy"
  | "price_history_present"
  | "price_book_mismatch"
  | "tenant_has_pricing_revisions"
  | "delta_import_pending_decision";

interface ImportCounts {
  readonly bookEvents: number;
  readonly storeEvents: number;
  readonly zeroPrice: number;
  readonly notRepresentable: number;
}

export type LegacyImportResult =
  | { readonly outcome: "refused"; readonly reason: LegacyImportRefusal; readonly detail: Readonly<Record<string, unknown>> }
  | {
      readonly outcome: "imported" | "no_change" | "dry_run";
      readonly revisionNo: number | null;
      readonly priceBookId: string | null;
      readonly bookCreated: boolean;
      readonly runId: string | null;
      readonly changeLogSequence: number;
      readonly counts: ImportCounts;
      readonly exceptions: readonly ImportException[];
      /** The zone of the book-event starts: the westernmost Store zone, or the reference zone (MC-1). */
      readonly bookZone: string;
      readonly referenceZone: string | null;
    };

const refused = (reason: LegacyImportRefusal, detail: Record<string, unknown> = {}): LegacyImportResult => ({ outcome: "refused", reason, detail });

function countsOf(events: readonly PlannedEvent[], exceptions: readonly ImportException[]): ImportCounts {
  return {
    bookEvents: events.filter((e) => e.scope === "book").length,
    storeEvents: events.filter((e) => e.scope === "store").length,
    zeroPrice: exceptions.filter((x) => x.cls === "zero_price").length,
    notRepresentable: exceptions.filter((x) => x.cls === "not_representable").length,
  };
}

/** The event identity a legacy value can express: scope, Store, product, price, currency (§4.3). */
const keyOf = (scope: string, storeId: string | null, productId: string, price: string, currencyCode: string): string =>
  `${scope}|${storeId ?? "-"}|${productId}|${price}|${currencyCode}`;

/** True when the Book's active events are exactly the planned ones, each open-ended (§4.3 "unchanged"). */
async function matchesLegacy(client: Queryable, tenantId: string, book: RetailBook, events: readonly PlannedEvent[]): Promise<boolean> {
  const active = await activeEvents(client, tenantId, book.id);
  if (active.length !== events.length || active.some((e) => !e.openEnded)) return false;
  const have = active.map((e) => keyOf(e.scope, e.storeId, e.productId, e.price, e.currencyCode)).sort();
  const want = events.map((e) => keyOf(e.scope, e.storeId, e.productId, e.price, book.currencyCode)).sort();
  return have.every((k, i) => k === want[i]);
}

async function audit(client: Queryable, w: Writer, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
  await insertAuditRowInTransaction(client, {
    tenantId: w.tenantId,
    actorUserId: w.actorUserId,
    storeId: null,
    action,
    targetType,
    targetId,
    requestId: w.correlationId,
    metadata: { source: "legacy_import", ...metadata },
  });
}

/** What the checks hand to the writes: the accepted plan, the existing Book and the head revision. */
interface Checked {
  readonly events: readonly PlannedEvent[];
  readonly exceptions: readonly ImportException[];
  readonly existing: RetailBook | null;
  readonly head: number | null;
  readonly bookZone: string;
}

/** Steps 3 and 5 (order of the header): every refusal, before any write. */
async function check(client: Queryable, req: LegacyImportRequest): Promise<Checked | LegacyImportResult> {
  const { tenantId, inputs } = req;
  const authority = await tenantAuthority(client, tenantId);
  if (authority !== "legacy") return refused("authority_not_legacy", { authority });
  const history = await legacyPriceHistoryCount(client, tenantId);
  if (history > 0) return refused("price_history_present", { rows: history });
  const plan = planLegacyImport(await readLegacyPrices(client, tenantId), inputs, await allStoreZones(client, tenantId), req.at);
  if (plan.kind === "refused") return refused(plan.reason, { currencies: plan.currencies });
  const existing = await retailBook(client, tenantId);
  if (existing !== null && (existing.currencyCode !== inputs.currencyCode || existing.taxPriceBasis !== inputs.taxPriceBasis)) {
    return refused("price_book_mismatch", { currencyCode: existing.currencyCode, taxPriceBasis: existing.taxPriceBasis });
  }
  const head = await headRevision(client, tenantId);
  if (head !== null) {
    if (existing === null || (await legacyImportRevision(client, tenantId)) !== 1) return refused("tenant_has_pricing_revisions", { head });
    if (!(await matchesLegacy(client, tenantId, existing, plan.events))) return refused("delta_import_pending_decision", { head });
  }
  return { events: plan.events, exceptions: plan.exceptions, existing, head, bookZone: plan.bookZone };
}

/** Steps 4 and 6: the Book when missing, revision 1 on a first import with events, the audit rows. */
async function write(client: Queryable, w: Writer, inputs: ImportInputs, c: Checked, counts: ImportCounts): Promise<{ book: RetailBook; revisionNo: number | null }> {
  const book = c.existing ?? (await createRetailBook(client, w, inputs));
  if (c.existing === null) {
    await audit(client, w, "pricing.price_book.created", "price_book", book.id, {
      price_book_id: book.id,
      default_price_zone_id: book.defaultZoneId,
      code: "RETAIL",
      currency_code: book.currencyCode,
      tax_price_basis: book.taxPriceBasis,
    });
  }
  if (c.head !== null || c.events.length === 0) return { book, revisionNo: null };
  const publication = await publishLegacyImport(client, w, book, c.events);
  await audit(client, w, "pricing.change_set.published", "price_change_set", publication.changeSetId, {
    change_set_id: publication.changeSetId,
    kind: "legacy_import",
    revision_no: publication.revisionNo,
    fan_out_store_count: publication.fanOutStores,
    book_event_count: counts.bookEvents,
    store_event_count: counts.storeEvents,
    exception_count: c.exceptions.length,
    book_zone: c.bookZone,
    reference_zone: inputs.referenceZone,
  });
  return { book, revisionNo: publication.revisionNo };
}

/** Runs the import on `client`, already inside the tenant's `pricing_legacy_import` transaction. */
export async function runLegacyImport(client: Queryable, req: LegacyImportRequest): Promise<LegacyImportResult> {
  await lockPricingPublish(client, req.tenantId);
  // §4.3 step 2 before step 3: the watermark is read before any legacy price, so a change committed
  // in between is above it (an `import_lag` mismatch, §5.3), never below it.
  const changeLogSequence = await catalogChangeLogHead(client, req.tenantId);
  const checked = await check(client, req);
  if ("outcome" in checked) return checked;
  const counts = countsOf(checked.events, checked.exceptions);
  const base = {
    counts,
    exceptions: checked.exceptions,
    changeLogSequence,
    bookZone: checked.bookZone,
    referenceZone: req.inputs.referenceZone,
  };
  if (req.dryRun) return { outcome: "dry_run", revisionNo: null, priceBookId: checked.existing?.id ?? null, bookCreated: false, runId: null, ...base };

  const w: Writer = { tenantId: req.tenantId, actorUserId: req.actorUserId, correlationId: req.correlationId };
  const { book, revisionNo } = await write(client, w, req.inputs, checked, counts);
  const outcome = revisionNo === null ? "no_change" : "imported";
  const runId = newId();
  // MC-10: the declared inputs are recorded with the run (the zones are in no other column).
  const recorded = { ...counts, outcome, bookZone: checked.bookZone, referenceZone: req.inputs.referenceZone ?? "" };
  await recordImportRun(client, w, { id: runId, at: req.at, changeLogSequence, revisionNo, counts: recorded });
  return { outcome, revisionNo, priceBookId: book.id, bookCreated: checked.existing === null, runId, ...base };
}
