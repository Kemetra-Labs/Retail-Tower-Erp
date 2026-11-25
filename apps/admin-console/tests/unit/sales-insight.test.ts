import { describe, expect, test } from "vitest";
import { salesInsightOf } from "@/sales/SalesInsight";
import { item } from "./sale-fixtures";

describe("salesInsightOf (modern concept 2/6, rule 4)", () => {
  test("no attention in the loaded rows: nothing", () => {
    expect(salesInsightOf([item(), item({ saleNumber: "R-0043" })])).toBeNull();
    expect(salesInsightOf([])).toBeNull();
  });

  test("failed ERP postings come first and count only the loaded rows", () => {
    expect(
      salesInsightOf([
        item({ erpPostingState: "failed" }),
        item({ erpPostingState: "failed", syncStatus: "failed-needs-repair" }),
        item({ syncStatus: "failed-needs-repair" }),
      ]),
    ).toEqual({ kind: "failedPosting", count: 2 });
  });

  test("sales needing repair count when nothing failed to post", () => {
    expect(salesInsightOf([item(), item({ syncStatus: "failed-needs-repair" })])).toEqual({
      kind: "needsRepair",
      count: 1,
    });
  });

  test("a voided or returned row is not attention on its own", () => {
    expect(salesInsightOf([item({ voided: true }), item({ returnState: "full" })])).toBeNull();
  });
});
