/**
 * RT-1505 part B (spec 049 section 5): the mapping rules, the request schemas, the profile entries, the header
 * synonyms and the profile selection rule (spec 049 section 12.1), the row-list cursor and query.
 */
import { InvalidImportCursorError } from "../../../src/catalog/catalog-import/import-batch-refusal";
import { mappingProblem, profileEntries, SetMappingBodySchema, ValidateBodySchema } from "../../../src/catalog/catalog-import/import-mapping";
import { decodeRowCursor, encodeRowCursor, RowsQuerySchema, toRowBody } from "../../../src/catalog/catalog-import/import-row-page";
import { normalizeHeader, suggestMapping, synonymFieldOf, type SuggestionProfile } from "../../../src/catalog/catalog-import/import-synonyms";
import { mapOf } from "./__support__/import-engine-fixtures";

/** Arabic headers as code points. */
const AR = {
  barcode: "\u{0627}\u{0644}\u{0628}\u{0627}\u{0631}\u{0643}\u{0648}\u{062F}",
  name: "\u{0627}\u{0633}\u{0645} \u{0627}\u{0644}\u{0645}\u{0646}\u{062A}\u{062C}",
  // "الفئة" with ta marbuta, and the same word typed with ha
  category: "\u{0627}\u{0644}\u{0641}\u{0626}\u{0629}",
  categoryHa: "\u{0627}\u{0644}\u{0641}\u{0626}\u{0647}",
  tax: "\u{0627}\u{0644}\u{0641}\u{0626}\u{0629} \u{0627}\u{0644}\u{0636}\u{0631}\u{064A}\u{0628}\u{064A}\u{0629}",
  price: "\u{0627}\u{0644}\u{0633}\u{0639}\u{0631}",
  sku: "\u{0643}\u{0648}\u{062F} \u{0627}\u{0644}\u{0635}\u{0646}\u{0641}",
  // "الباركود" with a tatweel and a fatha added
  barcodeMarked: "\u{0627}\u{0644}\u{0628}\u{0627}\u{0631}\u{0643}\u{0640}\u{0648}\u{064E}\u{062F}",
};

describe("mappingProblem (the rules of consoleSetCatalogImportMapping, re-applied by validate)", () => {
  it("accepts a complete mapping", () => {
    expect(mappingProblem(mapOf("sku", "name", "tax_category", "ignore", "price"), 5, "create")).toBeNull();
    expect(mappingProblem(mapOf("sku", "ignore"), 2, "update")).toBeNull();
  });

  it("needs every column exactly once", () => {
    expect(mappingProblem(mapOf("sku", "name"), 3, "update")).not.toBeNull();
    expect(mappingProblem([{ columnNumber: 1, target: "sku" }, { columnNumber: 1, target: "name" }], 2, "update")).not.toBeNull();
    expect(mappingProblem([{ columnNumber: 1, target: "sku" }, { columnNumber: 3, target: "name" }], 2, "update")).not.toBeNull();
    expect(mappingProblem(mapOf("sku", "name", "ignore"), 2, "update")).not.toBeNull();
  });

  it("a field at most once, barcode up to five times", () => {
    expect(mappingProblem(mapOf("name", "name", "tax_category"), 3, "create")).toMatch(/name/);
    expect(mappingProblem(mapOf("barcode", "barcode", "barcode", "barcode", "barcode", "name", "tax_category"), 7, "create")).toBeNull();
    expect(mappingProblem(mapOf("barcode", "barcode", "barcode", "barcode", "barcode", "barcode", "name", "tax_category"), 8, "create")).toMatch(/barcode/);
    expect(mappingProblem(mapOf("ignore", "ignore", "ignore"), 3, "update")).toBeNull();
  });

  it("create and upsert need name and tax_category; update does not", () => {
    for (const mode of ["create", "upsert"] as const) {
      expect(mappingProblem(mapOf("sku", "name"), 2, mode)).toMatch(/tax_category/);
      expect(mappingProblem(mapOf("sku", "tax_category"), 2, mode)).toMatch(/name/);
    }
    expect(mappingProblem(mapOf("sku", "name"), 2, "update")).toBeNull();
  });
});

describe("request schemas", () => {
  it("set-mapping is strict: an unknown or server-owned key is refused", () => {
    const ok = { expectedVersion: 1, columns: [{ columnNumber: 1, target: "sku" }] };
    expect(SetMappingBodySchema.safeParse(ok).success).toBe(true);
    expect(SetMappingBodySchema.safeParse({ ...ok, tenantId: "x" }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, columns: [{ columnNumber: 1, target: "sku", extra: 1 }] }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, columns: [{ columnNumber: 1, target: "supplier_code" }] }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, columns: [{ columnNumber: 51, target: "sku" }] }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, columns: [] }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, expectedVersion: 0 }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, expectedVersion: 2_147_483_648 }).success).toBe(false);
    expect(SetMappingBodySchema.safeParse({ ...ok, expectedVersion: "1" }).success).toBe(false);
  });

  it("saveProfileName: 1 to 100 characters, one not whitespace, no NUL", () => {
    const base = { expectedVersion: 1, columns: [{ columnNumber: 1, target: "sku" }] };
    const parse = (saveProfileName: string): boolean => SetMappingBodySchema.safeParse({ ...base, saveProfileName }).success;
    expect(parse("Supplier A")).toBe(true);
    expect(parse("x".repeat(100))).toBe(true);
    expect(parse("\u{1F600}".repeat(100))).toBe(true);
    expect(parse("x".repeat(101))).toBe(false);
    expect(parse("")).toBe(false);
    expect(parse("   ")).toBe(false);
    expect(parse("a\u{0000}b")).toBe(false);
    expect(parse("\u{D800}")).toBe(false);
  });

  it("validate takes only expectedVersion", () => {
    expect(ValidateBodySchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(ValidateBodySchema.safeParse({}).success).toBe(false);
    expect(ValidateBodySchema.safeParse({ expectedVersion: 3, force: true }).success).toBe(false);
  });
});

describe("profileEntries: the exact trimmed header to its target; an empty or repeated header is never saved", () => {
  it("keeps unique non-empty headers only", () => {
    const columns = [
      { columnNumber: 1, header: "Code" },
      { columnNumber: 2, header: "" },
      { columnNumber: 3, header: "Barcode" },
      { columnNumber: 4, header: "Barcode" },
      { columnNumber: 5, header: "Name" },
    ];
    const entries = profileEntries(columns, mapOf("sku", "ignore", "barcode", "barcode", "name"));
    expect({ ...entries }).toEqual({ Code: "sku", Name: "name" });
  });

  it("a header called __proto__ is just a key", () => {
    const entries = profileEntries([{ columnNumber: 1, header: "__proto__" }], mapOf("sku"));
    expect(JSON.parse(JSON.stringify(entries)) as unknown).toEqual(JSON.parse('{"__proto__":"sku"}'));
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("header synonyms (Arabic and English)", () => {
  it("normalises case, spacing, punctuation, diacritics and the alef, ya and ta marbuta variants", () => {
    expect(normalizeHeader("  Tax-Category ")).toBe("tax category");
    expect(normalizeHeader("TAX_CATEGORY")).toBe("tax category");
    expect(normalizeHeader("Item  Code.")).toBe("item code");
    expect(normalizeHeader(AR.categoryHa)).toBe(normalizeHeader(AR.category));
    expect(normalizeHeader(AR.barcodeMarked)).toBe(normalizeHeader(AR.barcode));
    expect(normalizeHeader("\u{0623}\u{062D}\u{0645}\u{062F}")).toBe(normalizeHeader("\u{0627}\u{062D}\u{0645}\u{062F}"));
  });

  it("finds the field of an English or Arabic header, and nothing for an unknown one", () => {
    expect(synonymFieldOf("SKU")).toBe("sku");
    expect(synonymFieldOf("Item Code")).toBe("sku");
    expect(synonymFieldOf("EAN-13")).toBe("barcode");
    expect(synonymFieldOf("Bar Code")).toBe("barcode");
    expect(synonymFieldOf("Product Name")).toBe("name");
    expect(synonymFieldOf("VAT")).toBe("tax_category");
    expect(synonymFieldOf("Selling Price")).toBe("price");
    expect(synonymFieldOf("Currency")).toBe("currency");
    expect(synonymFieldOf("Active")).toBe("is_active");
    expect(synonymFieldOf(AR.barcode)).toBe("barcode");
    expect(synonymFieldOf(AR.name)).toBe("name");
    expect(synonymFieldOf(AR.category)).toBe("category");
    expect(synonymFieldOf(AR.categoryHa)).toBe("category");
    expect(synonymFieldOf(AR.tax)).toBe("tax_category");
    expect(synonymFieldOf(AR.price)).toBe("price");
    expect(synonymFieldOf(AR.sku)).toBe("sku");
    expect(synonymFieldOf("Colour")).toBeNull();
    expect(synonymFieldOf("")).toBeNull();
    expect(synonymFieldOf("x".repeat(5000))).toBeNull();
  });

  it("is linear on a long header of separators (no backtracking)", () => {
    const started = Date.now();
    normalizeHeader(`${"-".repeat(500_000)}a`);
    normalizeHeader(`${"\u{0640}".repeat(500_000)}a`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

const profile = (id: string, name: string, entries: Record<string, string>, updatedAt = "2026-11-01T00:00:00Z"): SuggestionProfile => ({ id, name, entries, updatedAt: new Date(updatedAt) });
const cols = (...headers: string[]): Array<{ columnNumber: number; header: string }> => headers.map((header, i) => ({ columnNumber: i + 1, header }));

describe("suggestMapping and the profile selection rule", () => {
  it("places columns by synonym with no profile, and leaves out a column it cannot place", () => {
    const r = suggestMapping(cols("Item Code", "Product Name", "Colour", "Tax Category", "Price"), []);
    expect(r).toEqual({
      suggested: [
        { columnNumber: 1, target: "sku" },
        { columnNumber: 2, target: "name" },
        { columnNumber: 4, target: "tax_category" },
        { columnNumber: 5, target: "price" },
      ],
      profileId: null,
    });
  });

  it("a profile entry (exact header) comes before a synonym, and `ignore` is only suggested by a profile", () => {
    const p = profile("p1", "Mine", { Name: "description", Notes: "ignore", Code: "sku" });
    const r = suggestMapping(cols("Code", "Name", "Notes", "Barcode"), [p]);
    expect(r.suggested).toEqual([
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "description" },
      { columnNumber: 3, target: "ignore" },
      { columnNumber: 4, target: "barcode" },
    ]);
    expect(r.profileId).toBe("p1");
  });

  it("a field a profile entry holds is left out of the synonym pass; barcode may repeat up to five", () => {
    const p = profile("p1", "Mine", { Code: "name" });
    const r = suggestMapping(cols("Code", "Name", "Barcode 1", "Barcode", "EAN", "UPC", "GTIN", "Bar Code"), [p]);
    expect(r.suggested.filter((m) => m.target === "name")).toEqual([{ columnNumber: 1, target: "name" }]);
    expect(r.suggested.filter((m) => m.target === "barcode").map((m) => m.columnNumber)).toEqual([4, 5, 6, 7, 8]);
  });

  it("an empty or repeated header never takes a profile entry (it cannot identify its column)", () => {
    const p = profile("p1", "Mine", { Zeta: "sku", "": "name" });
    expect(suggestMapping(cols("Zeta", "Zeta", ""), [p])).toEqual({ suggested: [], profileId: null });
  });

  it("names the profile only when it placed a column", () => {
    const p = profile("p1", "Mine", { Unrelated: "sku" });
    expect(suggestMapping(cols("SKU"), [p])).toEqual({ suggested: [{ columnNumber: 1, target: "sku" }], profileId: null });
  });

  it("picks the profile covering the most headers", () => {
    const small = profile("a", "Small", { Code: "sku" }, "2026-11-10T00:00:00Z");
    const big = profile("b", "Big", { Code: "sku", Title: "name", Group: "category" }, "2026-11-01T00:00:00Z");
    expect(suggestMapping(cols("Code", "Title", "Group"), [small, big]).profileId).toBe("b");
  });

  it("breaks a tie by the most recent update, then the smaller name, then the smaller id", () => {
    const e = { Code: "sku" };
    const older = profile("1", "A", e, "2026-11-01T00:00:00Z");
    const newer = profile("2", "B", e, "2026-11-05T00:00:00Z");
    expect(suggestMapping(cols("Code"), [older, newer]).profileId).toBe("2");
    expect(suggestMapping(cols("Code"), [newer, older]).profileId).toBe("2");
    const sameTimeA = profile("9", "Alpha", e);
    const sameTimeB = profile("1", "Beta", e);
    expect(suggestMapping(cols("Code"), [sameTimeB, sameTimeA]).profileId).toBe("9");
    const sameName1 = profile("1", "Same", e);
    const sameName2 = profile("2", "Same", e);
    expect(suggestMapping(cols("Code"), [sameName2, sameName1]).profileId).toBe("1");
  });

  it("ignores an entry whose target is not a field (a corrupt profile)", () => {
    const p = profile("p1", "Odd", { Zeta: "supplier_code" });
    // A header named like an Object.prototype member is not an entry.
    expect(suggestMapping(cols("Zeta", "constructor", "toString"), [p])).toEqual({ suggested: [], profileId: null });
  });

  it("suggests nothing beyond the 50-column limit and never a column twice", () => {
    const headers = Array.from({ length: 50 }, (_v, i) => (i % 2 === 0 ? "Barcode" : `Col${i}`));
    const r = suggestMapping(cols(...headers), []);
    expect(r.suggested.length).toBe(5);
    expect(new Set(r.suggested.map((m) => m.columnNumber)).size).toBe(5);
  });
});

describe("row list query and cursor", () => {
  const binding = { tenantId: "t1", batchId: "b1", generation: 2, status: null as string | null };

  it("is strict: an unknown or repeated key, a bad status, limit or cursor is refused", () => {
    expect(RowsQuerySchema.safeParse({}).success).toBe(true);
    expect(RowsQuerySchema.safeParse({ status: "error", limit: "200" }).success).toBe(true);
    expect(RowsQuerySchema.safeParse({ tenant_id: "x" }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ status: ["error", "unchanged"] }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ status: "published" }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ limit: ["5"] }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ cursor: "a b" }).success).toBe(false);
    expect(RowsQuerySchema.safeParse({ cursor: "a".repeat(513) }).success).toBe(false);
  });

  it("round-trips the last row number and is bound to the tenant, batch, generation and the status parameter", () => {
    const token = encodeRowCursor(binding, 57);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(512);
    expect(decodeRowCursor(token, binding)).toBe(57);
    for (const other of [{ ...binding, tenantId: "t2" }, { ...binding, batchId: "b2" }, { ...binding, generation: 3 }, { ...binding, status: "error" }]) {
      expect(() => decodeRowCursor(token, other)).toThrow(InvalidImportCursorError);
    }
    // Dropping the status parameter, or adding one, is another filter value.
    const filtered = encodeRowCursor({ ...binding, status: "error" }, 9);
    expect(() => decodeRowCursor(filtered, binding)).toThrow(InvalidImportCursorError);
  });

  it("refuses a token that is not one this operation issued", () => {
    for (const junk of ["x", "e30", Buffer.from('{"o":"other"}').toString("base64url"), Buffer.from("[1]").toString("base64url"), Buffer.from('{"o":"catalog-import-rows","t":"t1","b":"b1","g":2,"s":null,"r":0}').toString("base64url")]) {
      expect(() => decodeRowCursor(junk, binding)).toThrow(InvalidImportCursorError);
    }
  });
});

describe("toRowBody", () => {
  const stored = {
    row_number: 2,
    cells: [` x${"\u{00A0}"}`, null, { t: "n" as const, v: "12" }, { t: "f" as const, v: null }],
    status: "unchanged",
    outcome: { match: "match" },
    issues: [],
    review_reason: null,
    resolution: null,
    resolution_product_id: null,
    resolved_at: null,
    product_id: null,
  };

  it("shows the cells after the trim, null for a blank one, and a formula by its cached value", () => {
    expect(toRowBody(stored).cells).toEqual(["x", null, "12", null]);
  });

  it("shows a recorded decision without its actor", () => {
    const body = toRowBody({ ...stored, resolution: "update_product", resolution_product_id: "p", resolved_at: new Date("2026-11-20T10:00:00Z") });
    expect(body.resolution).toEqual({ action: "update_product", productId: "p", decidedAt: "2026-11-20T10:00:00.000Z" });
  });

  it("refuses a row with no validation outcome: a validated batch has none", () => {
    expect(() => toRowBody({ ...stored, status: null })).toThrow(/no validation outcome/);
  });
});
