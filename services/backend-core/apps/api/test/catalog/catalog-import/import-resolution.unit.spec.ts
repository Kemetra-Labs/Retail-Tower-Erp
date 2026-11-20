/**
 * RT-1507 — the review decisions and the publish plan, pure (no database). The HTTP specs prove them against a real
 * catalogue; these pin the rules and the edge cases that are cheaper to state directly.
 */
import type { CatalogLookups, ProductFacts } from "../../../src/catalog/catalog-import/import-lookups";
import { planPublish, previewOf, summaryOf, type PlanRow } from "../../../src/catalog/catalog-import/import-publish-plan";
import { carryDecisions, countWrites, hashRowsOf } from "../../../src/catalog/catalog-import/import-review-carry";
import { applyDecision, baseOf, clearedState, decisionStillStands, publicOutcome, type BaseRow, type StoredRowState } from "../../../src/catalog/catalog-import/import-resolution";
import { previewHashOf } from "../../../src/catalog/catalog-import/import-preview-hash";
import type { RowOutcome, RowResult } from "../../../src/catalog/catalog-import/import-row-evaluate";
import type { ParsedRow } from "../../../src/catalog/catalog-import/import-row-parse";

const P1 = "0a000000-0000-7000-8000-000000000001";
const P2 = "0a000000-0000-7000-8000-000000000002";

function product(id: string, over: Partial<ProductFacts> = {}): ProductFacts {
  return {
    id,
    name: `Product ${id.slice(-1)}`,
    description: null,
    taxCategory: "standard",
    isActive: true,
    retired: false,
    updatedAtText: "2026-11-20T10:00:00.123456Z",
    categoryName: null,
    brandName: null,
    identifiers: [{ type: "sku", value: `S-${id.slice(-1)}` }],
    ...over,
  };
}

const ref = (p: ProductFacts): { productId: string; name: string; identifiers: ProductFacts["identifiers"] } => ({ productId: p.id, name: p.name, identifiers: p.identifiers });

function lookups(products: ProductFacts[], over: Partial<CatalogLookups> = {}): CatalogLookups {
  return {
    tenantWide: new Map(),
    storeScoped: new Map(),
    products: new Map(products.map((p) => [p.id, p])),
    categories: new Set(),
    brands: new Set(),
    usedTaxCategories: new Set(["standard"]),
    productsByName: new Map(),
    ...over,
  };
}

function parsed(over: Partial<ParsedRow> = {}): ParsedRow {
  return { rowNumber: 2, issues: [], identifiers: [], name: null, description: null, category: null, brand: null, taxCategory: null, isActive: null, ...over };
}

function outcome(over: Partial<RowOutcome> = {}): RowOutcome {
  return { match: "no_match", matchedProduct: null, candidates: [], fieldChanges: [], identifierAdds: [], identifiersNotAdded: [], brandToCreate: null, ...over };
}

const base = (status: BaseRow["status"], o: RowOutcome, matchedUpdatedAt: string | null = null): BaseRow => ({ status, outcome: o, matchedUpdatedAt });

describe("applyDecision", () => {
  const p1 = product(P1);
  const p2 = product(P2, { identifiers: [{ type: "sku", value: "S-2" }, { type: "barcode", value: "222" }] });

  it("create_new needs a needs_review row with no active identifier and is never offered in an update batch", () => {
    const b = base("needs_review", outcome({ identifierAdds: [{ type: "sku", value: "N-1" }] }));
    const p = parsed({ identifiers: [{ type: "sku", value: "N-1", columnNumber: 1 }, { type: "plu", value: "4242", columnNumber: 2 }] });
    const applied = applyDecision({ mode: "upsert", base: b, parsed: p, lookups: lookups([]) }, { action: "create_new", productId: null });
    expect(applied).toMatchObject({ status: "ready_create", matchedUpdatedAt: null });
    expect(applied!.outcome.identifiersNotAdded).toEqual([{ type: "plu", value: "4242" }]);
    expect(applied!.outcome._validated).toEqual(b.outcome);
    expect(applyDecision({ mode: "update", base: b, parsed: p, lookups: lookups([]) }, { action: "create_new", productId: null })).toBeNull();
    const ambiguous = base("needs_review", outcome({ match: "ambiguous", candidates: [ref(p1), ref(p2)] }));
    expect(applyDecision({ mode: "upsert", base: ambiguous, parsed: p, lookups: lookups([p1, p2]) }, { action: "create_new", productId: null })).toBeNull();
  });

  it("update_product needs a candidate, never in a create batch, never a retired product", () => {
    const b = base("needs_review", outcome({ match: "ambiguous", candidates: [ref(p1), ref(p2)] }));
    const ctx = { mode: "upsert" as const, base: b, parsed: parsed(), lookups: lookups([p1, p2, product("0a000000-0000-7000-8000-000000000003", { retired: true })]) };
    expect(applyDecision(ctx, { action: "update_product", productId: P1 })).toMatchObject({ status: "ready_update", matchedUpdatedAt: p1.updatedAtText });
    expect(applyDecision(ctx, { action: "update_product", productId: "0a000000-0000-7000-8000-000000000009" })).toBeNull();
    expect(applyDecision(ctx, { action: "update_product", productId: null })).toBeNull();
    expect(applyDecision({ ...ctx, mode: "create" }, { action: "update_product", productId: P1 })).toBeNull();
    const retiredCandidate = base("needs_review", outcome({ match: "ambiguous", candidates: [{ productId: "0a000000-0000-7000-8000-000000000003", name: "R", identifiers: [] }] }));
    expect(applyDecision({ ...ctx, base: retiredCandidate }, { action: "update_product", productId: "0a000000-0000-7000-8000-000000000003" })).toBeNull();
  });

  it("update_product lists what the chosen product leaves out: another product's identifier, a second SKU, a store-scoped value", () => {
    const b = base("needs_review", outcome({ match: "ambiguous", candidates: [ref(p1), ref(p2)] }));
    const p = parsed({
      identifiers: [
        { type: "sku", value: "S-1", columnNumber: 1 }, // P1's own: nothing to do
        { type: "barcode", value: "222", columnNumber: 2 }, // P2's: never moved
        { type: "sku", value: "S-NEW", columnNumber: 3 }, // a second SKU
        { type: "plu", value: "7", columnNumber: 4 }, // a store-scoped value of P2
        { type: "barcode", value: "555", columnNumber: 5 }, // free
      ],
      name: { value: "Renamed", columnNumber: 6 },
    });
    const look = lookups([p1, p2], {
      tenantWide: new Map([["sku\u0000S-1", P1], ["barcode\u0000222", P2]]),
      storeScoped: new Map([["plu\u00007", [P2]]]),
    });
    const applied = applyDecision({ mode: "upsert", base: b, parsed: p, lookups: look }, { action: "update_product", productId: P1 })!;
    expect(applied.outcome.identifierAdds).toEqual([{ type: "barcode", value: "555" }]);
    expect(applied.outcome.identifiersNotAdded).toEqual([
      { type: "barcode", value: "222" },
      { type: "sku", value: "S-NEW" },
      { type: "plu", value: "7" },
    ]);
    expect(applied.outcome.fieldChanges).toEqual([{ field: "name", before: "Product 1", after: "Renamed" }]);
    expect(applied.outcome.matchedProduct).toEqual(ref(p1));
  });

  it("keeps the validated updated_at when validation had matched the same product", () => {
    const matched = base("needs_review", outcome({ match: "match", matchedProduct: ref(p1), candidates: [ref(p1)] }), "2026-11-20T09:00:00.000001Z");
    const applied = applyDecision({ mode: "upsert", base: matched, parsed: parsed(), lookups: lookups([p1]) }, { action: "update_product", productId: P1 })!;
    expect(applied.matchedUpdatedAt).toBe("2026-11-20T09:00:00.000001Z");
  });

  it("exclude is offered for needs_review and error rows; everything else for an error row is not; a ready row takes nothing", () => {
    const review = base("needs_review", outcome());
    const err = base("error", outcome());
    expect(applyDecision({ mode: "upsert", base: review, parsed: parsed(), lookups: lookups([]) }, { action: "exclude", productId: null })).toMatchObject({ status: "excluded" });
    expect(applyDecision({ mode: "upsert", base: err, parsed: parsed(), lookups: lookups([]) }, { action: "exclude", productId: null })).toMatchObject({ status: "excluded" });
    expect(applyDecision({ mode: "upsert", base: err, parsed: parsed(), lookups: lookups([]) }, { action: "create_new", productId: null })).toBeNull();
    expect(applyDecision({ mode: "upsert", base: base("ready_create", outcome()), parsed: parsed(), lookups: lookups([]) }, { action: "exclude", productId: null })).toBeNull();
  });

  it("clear returns the validated state exactly, and baseOf reads it from the snapshot", () => {
    const b = base("needs_review", outcome({ identifierAdds: [{ type: "sku", value: "N-1" }] }));
    const applied = applyDecision({ mode: "upsert", base: b, parsed: parsed({ identifiers: [{ type: "sku", value: "N-1", columnNumber: 1 }] }), lookups: lookups([]) }, { action: "create_new", productId: null })!;
    const stored: StoredRowState = { status: applied.status, reviewReason: "no_identifier", outcome: applied.outcome, matchedUpdatedAt: applied.matchedUpdatedAt, decision: { action: "create_new", productId: null } };
    expect(clearedState(stored)).toEqual({ status: "needs_review", outcome: b.outcome, matchedUpdatedAt: null });
    expect(publicOutcome(applied.outcome)).not.toHaveProperty("_validated");
    expect(baseOf({ ...stored, decision: null, status: "ready_create" })).toMatchObject({ status: "ready_create" });
  });
});

describe("decisionStillStands", () => {
  const prior = { reviewReason: "ambiguous", candidateIds: [P1, P2], errorCodes: [] as string[] };
  it("holds while the reason and the candidate set are unchanged, in any order", () => {
    expect(decisionStillStands(prior, { status: "needs_review", reviewReason: "ambiguous", candidateIds: [P2, P1], errorCodes: [] })).toBe(true);
  });
  it("drops when the reason or a candidate changed, or the row is no longer a review", () => {
    expect(decisionStillStands(prior, { status: "needs_review", reviewReason: "sku_mismatch", candidateIds: [P1, P2], errorCodes: [] })).toBe(false);
    expect(decisionStillStands(prior, { status: "needs_review", reviewReason: "ambiguous", candidateIds: [P1], errorCodes: [] })).toBe(false);
    expect(decisionStillStands(prior, { status: "ready_update", reviewReason: null, candidateIds: [], errorCodes: [] })).toBe(false);
  });
  it("keeps an excluded error row only while its error codes are the same", () => {
    const err = { reviewReason: null, candidateIds: [] as string[], errorCodes: ["category_not_found"] };
    expect(decisionStillStands(err, { status: "error", reviewReason: null, candidateIds: [], errorCodes: ["category_not_found"] })).toBe(true);
    expect(decisionStillStands(err, { status: "error", reviewReason: null, candidateIds: [], errorCodes: ["product_retired"] })).toBe(false);
  });
});

describe("carryDecisions and the hash", () => {
  const p1 = product(P1);
  function result(status: RowResult["status"], over: Partial<RowResult> = {}): RowResult {
    return { rowNumber: 2, status, reviewReason: null, outcome: outcome(), issues: [], matchedUpdatedAt: null, ...over };
  }

  it("applies a still-standing decision to the fresh result, keeps who and when, and changes the hash against none", () => {
    const fresh = result("needs_review", { reviewReason: "no_identifier" });
    const prior = [{ rowNumber: 2, decision: { action: "exclude" as const, productId: null }, resolvedBy: "u", resolvedAt: "2026-11-20T10:00:00.000000Z", reviewReason: "no_identifier", candidateIds: [], errorCodes: [] }];
    const writes = carryDecisions("upsert", [fresh], [parsed()], lookups([p1]), prior);
    expect(writes[0]).toMatchObject({ status: "excluded", carried: { resolvedBy: "u" } });
    expect(countWrites(writes)).toMatchObject({ excluded: 1, needs_review: 0 });
    const none = carryDecisions("upsert", [fresh], [parsed()], lookups([p1]), []);
    expect(previewHashOf("upsert", hashRowsOf(writes))).not.toBe(previewHashOf("upsert", hashRowsOf(none)));
    expect(previewHashOf("upsert", hashRowsOf(none))).toBe(previewHashOf("upsert", [fresh]));
  });

  it("drops a decision whose row changed reason", () => {
    const fresh = result("needs_review", { reviewReason: "possible_duplicate" });
    const prior = [{ rowNumber: 2, decision: { action: "exclude" as const, productId: null }, resolvedBy: "u", resolvedAt: "2026-11-20T10:00:00.000000Z", reviewReason: "no_identifier", candidateIds: [], errorCodes: [] }];
    expect(carryDecisions("upsert", [fresh], [parsed()], lookups([]), prior)[0]).toMatchObject({ status: "needs_review", carried: null });
  });
});

describe("planPublish", () => {
  const row = (rowNumber: number, status: PlanRow["status"], o: Partial<RowOutcome> = {}, over: Partial<PlanRow> = {}): PlanRow => ({
    rowNumber,
    status,
    outcome: outcome(o),
    matchedText: null,
    matchedMs: null,
    priceNotImported: false,
    ...over,
  });
  const p1 = product(P1);
  const update = (rowNumber: number, fieldChanges: RowOutcome["fieldChanges"], extra: Partial<RowOutcome> = {}, over: Partial<PlanRow> = {}): PlanRow =>
    row(rowNumber, "ready_update", { match: "match", matchedProduct: ref(p1), fieldChanges, ...extra }, { matchedText: "2026-11-20T10:00:00.123456Z", matchedMs: "1795168800123", ...over });

  it("counts creates, updates, identifier adds, deactivations and brands once; unchanged and excluded write nothing", () => {
    const plan = planPublish([
      row(2, "ready_create", { brandToCreate: "Acme", identifierAdds: [{ type: "sku", value: "A" }, { type: "barcode", value: "1" }] }, { priceNotImported: true }),
      row(3, "ready_create", { brandToCreate: "Acme", identifierAdds: [{ type: "sku", value: "B" }] }),
      update(4, [{ field: "is_active", before: "true", after: "false" }], { identifierAdds: [{ type: "barcode", value: "9" }] }),
      row(5, "unchanged"),
      row(6, "excluded"),
    ]);
    expect(plan.brands).toEqual([{ name: "Acme", rowNumber: 2 }]);
    expect(summaryOf(plan)).toEqual({ brandsCreated: 1, productsCreated: 2, productsUpdated: 1, identifiersAdded: 4, productsDeactivated: 1, rowsUnchanged: 1, rowsExcluded: 1 });
    expect(previewOf(plan)).toMatchObject({ brandsToCreate: ["Acme"], productsToCreate: 2, productsToUpdate: 1, identifiersToAdd: 4, newProductsWithoutPrice: 2, rowsWithPriceNotImported: 1 });
    expect(previewOf(plan).deactivations).toEqual([{ rowNumber: 4, product: ref(p1) }]);
  });

  it("writes nothing for a decided update with nothing to change or add", () => {
    const plan = planPublish([update(2, [], { identifiersNotAdded: [{ type: "sku", value: "X" }] })]);
    expect(plan.updates).toEqual([]);
    expect(summaryOf(plan).productsUpdated).toBe(0);
  });

  it("merges two rows that update one product when they agree, and flags a disagreement or different validated states", () => {
    const merged = planPublish([update(2, [{ field: "name", before: "a", after: "b" }], { identifierAdds: [{ type: "barcode", value: "1" }] }), update(3, [{ field: "name", before: "a", after: "b" }, { field: "description", before: null, after: "d" }])]);
    expect(merged.updates).toHaveLength(1);
    expect(merged.updates[0]).toMatchObject({ rowNumbers: [2, 3] });
    expect(merged.updates[0]!.changes.map((c) => c.field)).toEqual(["name", "description"]);
    expect(merged.conflictingProducts).toEqual([]);
    const conflict = planPublish([update(2, [{ field: "name", before: "a", after: "b" }]), update(3, [{ field: "name", before: "a", after: "c" }])]);
    expect(conflict.conflictingProducts).toEqual([P1]);
    const stale = planPublish([update(2, [{ field: "name", before: "a", after: "b" }]), update(3, [{ field: "description", before: null, after: "d" }], {}, { matchedText: "2026-11-20T11:00:00.000000Z" })]);
    expect(stale.staleProducts).toEqual([P1]);
  });

  it("refuses a ready_update row that names no product", () => {
    expect(() => planPublish([row(2, "ready_update", { fieldChanges: [{ field: "name", before: "a", after: "b" }] })])).toThrow(/without a matched product/);
  });
});
