/**
 * RT-1536 (spec 049 S5b) — the conflicts `planPublish` reports: the product, the rows to fix and the reason, for exactly the
 * products `conflictingProducts` (the publish's refusal) names. Pure; no database.
 */
import type { ProductRef } from "../../../src/catalog/catalog-import/import-issues";
import { MAX_CONFLICT_ROWS, MAX_PREVIEW_CONFLICTS, planPublish, previewOf, type PlanRow } from "../../../src/catalog/catalog-import/import-publish-plan";
import type { FieldChange, IdentifierRef, RowStatus } from "../../../src/catalog/catalog-import/import-row-evaluate";

const product = (id: string, identifiers: ProductRef["identifiers"] = []): ProductRef => ({ productId: id, name: `P ${id}`, identifiers });

function row(rowNumber: number, status: RowStatus, p: ProductRef, over: { changes?: FieldChange[]; adds?: IdentifierRef[] } = {}): PlanRow {
  return {
    rowNumber,
    status,
    outcome: { match: "match", matchedProduct: p, candidates: [], fieldChanges: over.changes ?? [], identifierAdds: over.adds ?? [], identifiersNotAdded: [], brandToCreate: null },
    matchedText: "2026-11-20T10:00:00.000000Z",
    matchedMs: "1784541600000",
    priceNotImported: false,
  };
}
const rename = (after: string): FieldChange[] => [{ field: "name", before: "Old", after }];
const P1 = product("p1");

describe("planPublish conflicts (RT-1536)", () => {
  it("reports nothing for rows that agree, and for a batch with no shared product", () => {
    const plan = planPublish([row(2, "ready_update", P1, { changes: rename("Same") }), row(3, "ready_update", P1, { changes: rename("Same") }), row(4, "ready_update", product("p2"), { changes: rename("X") })]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.conflictingProducts).toEqual([]);
    expect(previewOf(plan)).toMatchObject({ conflictCount: 0, conflicts: [] });
  });

  it("names the field and both rows of a disagreement, in step with conflictingProducts", () => {
    const plan = planPublish([row(2, "ready_update", P1, { changes: rename("A") }), row(3, "ready_update", P1, { changes: rename("B") })]);
    expect(plan.conflicts).toEqual([{ productId: "p1", product: P1, rowNumbers: [2, 3], reason: "field_disagreement", field: "name" }]);
    expect(plan.conflictingProducts).toEqual(["p1"]);
  });

  it("includes an unchanged row that restates a value against another row's change (it is in no update's row list)", () => {
    const explicit = new Map([[3, { name: "Old" }]]);
    const plan = planPublish([row(2, "ready_update", P1, { changes: rename("New") }), row(3, "unchanged", P1)], explicit);
    expect(plan.conflicts).toEqual([{ productId: "p1", product: P1, rowNumbers: [2, 3], reason: "field_disagreement", field: "name" }]);
    expect(planPublish([row(2, "ready_update", P1, { changes: rename("New") }), row(3, "unchanged", P1)]).conflicts).toEqual([]);
  });

  it("reports one entry per disagreeing field, ordered by field", () => {
    const active: FieldChange[] = [{ field: "is_active", before: "true", after: "false" }];
    const plan = planPublish([row(2, "ready_update", P1, { changes: [...rename("A"), ...active] }), row(3, "ready_update", P1, { changes: [...rename("B"), { field: "is_active", before: "true", after: "true" }] })]);
    expect(plan.conflicts.map((c) => c.field)).toEqual(["is_active", "name"]);
    expect(plan.conflictingProducts).toEqual(["p1"]);
  });

  it("reports a second SKU through two rows, and through a SKU added to a product that has one", () => {
    const two = planPublish([row(2, "ready_update", P1, { adds: [{ type: "sku", value: "S1" }] }), row(3, "ready_update", P1, { adds: [{ type: "sku", value: "S2" }] })]);
    expect(two.conflicts).toEqual([{ productId: "p1", product: P1, rowNumbers: [2, 3], reason: "second_sku" }]);
    const has = product("p9", [{ type: "sku", value: "HAS" }]);
    const one = planPublish([row(5, "ready_update", has, { adds: [{ type: "sku", value: "NEW" }] })]);
    expect(one.conflicts).toEqual([{ productId: "p9", product: has, rowNumbers: [5], reason: "second_sku" }]);
    expect(one.conflictingProducts).toEqual(["p9"]);
  });

  it("does not report two barcodes, or a product no update touches", () => {
    const plan = planPublish([row(2, "ready_update", P1, { adds: [{ type: "barcode", value: "1" }] }), row(3, "ready_update", P1, { adds: [{ type: "barcode", value: "2" }] })]);
    expect(plan.conflicts).toEqual([]);
    const idle = planPublish([row(2, "unchanged", P1), row(3, "unchanged", P1)], new Map([[2, { name: "A" }], [3, { name: "B" }]]));
    expect(idle.conflicts).toEqual([]);
    expect(idle.conflictingProducts).toEqual([]);
  });

  it("orders conflicts by first row and bounds the preview lists while counting them all", () => {
    const rows: PlanRow[] = [];
    for (let i = 0; i < MAX_PREVIEW_CONFLICTS + 5; i += 1) {
      const p = product(`q${String(i).padStart(3, "0")}`);
      rows.push(row(1000 - 2 * i, "ready_update", p, { changes: rename("A") }), row(1001 - 2 * i, "ready_update", p, { changes: rename("B") }));
    }
    const plan = planPublish(rows);
    const preview = previewOf(plan);
    expect(preview.conflictCount).toBe(MAX_PREVIEW_CONFLICTS + 5);
    expect(preview.conflicts).toHaveLength(MAX_PREVIEW_CONFLICTS);
    const firsts = plan.conflicts.map((c) => c.rowNumbers[0] as number);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    const many: PlanRow[] = Array.from({ length: MAX_CONFLICT_ROWS + 10 }, (_, i) => row(2 + i, "ready_update", P1, { changes: rename(`V${i}`) }));
    expect(previewOf(planPublish(many)).conflicts[0]?.rowNumbers).toHaveLength(MAX_CONFLICT_ROWS);
  });

  it("lists a conflict next to a row that still needs review (the batch is not publishable either way)", () => {
    const plan = planPublish([row(2, "ready_update", P1, { changes: rename("A") }), row(3, "ready_update", P1, { changes: rename("B") }), row(4, "needs_review", product("p5"))]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflictingProducts).toEqual(["p1"]);
  });
});
