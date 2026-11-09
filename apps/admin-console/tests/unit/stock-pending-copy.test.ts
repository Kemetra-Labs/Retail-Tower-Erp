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
});
