import { translate } from "@/i18n";
import { describe, expect, test } from "vitest";

/**
 * RT-1299 2a (UX-12.2): the "requested, waiting for the connector" status uses
 * the Arabic term «الموصّل», never the Latin word "Connector".
 */
describe("stock snapshot pending status copy", () => {
  test("the stores-list status reads «طُلبت، بانتظار الموصّل» in Arabic", () => {
    expect(translate("ar", "stock.stores.pending")).toBe("طُلبت، بانتظار الموصّل");
  });

  test("no Latin word in either rendition of the pending status in Arabic", () => {
    for (const key of ["stock.stores.pending", "stock.pending.badge"] as const) {
      expect(translate("ar", key)).not.toMatch(/[A-Za-z]/);
    }
  });

  test("the overdue notes name the connector «موصّل ERPNext», never the Latin word", () => {
    for (const key of ["stock.pending.overdue", "stock.pending.overdueWithPrevious"] as const) {
      const text = translate("ar", key);
      expect(text).not.toMatch(/Connector/);
      expect(text).toContain("موصّل ERPNext");
    }
  });
});
