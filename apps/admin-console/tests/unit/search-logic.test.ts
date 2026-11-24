import { describe, expect, test } from "vitest";
import {
  MAX_SALE_NUMBER_LENGTH,
  MAX_SEARCH_LENGTH,
  SEARCH_PAGE_SIZE,
  productSearchQuery,
  receiptSearchQuery,
  receiptWindow,
} from "@/search/searchLogic";

const WINDOW = { from: "2026-09-23", to: "2026-10-23" };

describe("searchLogic", () => {
  test("receiptWindow covers the 31 business days ending today in the store zone", () => {
    expect(receiptWindow("Africa/Cairo", new Date("2026-10-23T09:00:00Z"))).toEqual(WINDOW);
    // 23:30 UTC is already the next calendar day in Cairo.
    expect(receiptWindow("Africa/Cairo", new Date("2026-10-23T23:30:00Z"))).toEqual({
      from: "2026-09-24",
      to: "2026-10-24",
    });
  });

  test("productSearchQuery is null without a term, and trims it", () => {
    expect(productSearchQuery(null, null)).toBeNull();
    expect(productSearchQuery("   ", null)).toBeNull();
    expect(productSearchQuery("  widget  ", null)).toEqual({
      q: "widget",
      status: "active",
      limit: SEARCH_PAGE_SIZE,
    });
    expect(productSearchQuery("widget", "store-1")).toEqual({
      q: "widget",
      status: "active",
      store_id: "store-1",
      limit: SEARCH_PAGE_SIZE,
    });
  });

  test("productSearchQuery is null past the contract's length", () => {
    expect(productSearchQuery("x".repeat(MAX_SEARCH_LENGTH + 1), null)).toBeNull();
    expect(productSearchQuery("x".repeat(MAX_SEARCH_LENGTH), null)).not.toBeNull();
    expect(SEARCH_PAGE_SIZE).toBe(10);
  });

  test("receiptSearchQuery needs a term, a store and a window", () => {
    expect(receiptSearchQuery(null, "s", WINDOW)).toBeNull();
    expect(receiptSearchQuery("R-1", null, WINDOW)).toBeNull();
    expect(receiptSearchQuery("R-1", "s", null)).toBeNull();
    expect(receiptSearchQuery("R-1", "s", WINDOW)).toEqual({
      store_id: "s",
      from: WINDOW.from,
      to: WINDOW.to,
      sale_number: "R-1",
      page_size: SEARCH_PAGE_SIZE,
    });
  });

  test("receiptSearchQuery is null past the receipt number's length", () => {
    expect(receiptSearchQuery("x".repeat(MAX_SALE_NUMBER_LENGTH + 1), "s", WINDOW)).toBeNull();
    expect(receiptSearchQuery("x".repeat(MAX_SALE_NUMBER_LENGTH), "s", WINDOW)).not.toBeNull();
  });
});
