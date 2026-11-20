/**
 * RT-1505 part B (spec 049 sections 5 to 7): the validate engine, pure. Each cell rule, each matching outcome, each
 * mode and each row status, plus the time of validating 5,000 rows of 50 columns.
 */
import { collectLookupKeys } from "../../../src/catalog/catalog-import/import-lookups";
import { previewHashOf } from "../../../src/catalog/catalog-import/import-preview-hash";
import { countStatuses, evaluateRows } from "../../../src/catalog/catalog-import/import-row-evaluate";
import { parseRows, trimmedCellText } from "../../../src/catalog/catalog-import/import-row-parse";
import type { StagedCell } from "../../../src/catalog/catalog-import/staged-cell";
import { AR, catalogue, codes, formula, mapOf, num, run } from "./__support__/import-engine-fixtures";

const NBSP = "\u{00A0}";
const RLM = "\u{200F}";
const LRM = "\u{200E}";
const ALM = "\u{061C}";

const P1 = "0192f000-0000-7000-8000-000000000a01";
const P2 = "0192f000-0000-7000-8000-000000000a02";
const P3 = "0192f000-0000-7000-8000-000000000a03";

/** sku, name, tax_category */
const SNT = mapOf("sku", "name", "tax_category");

describe("trim (OD-10): every cell, mapped or not, with a notice per changed cell", () => {
  it("trims spaces, NBSP and the bidi marks, and says so", () => {
    const [r] = run("create", mapOf("sku", "name", "tax_category", "ignore"), [[`${NBSP} A1 ${RLM}`, `${LRM}Tea${ALM}`, " standard ", `  ${NBSP}`]]);
    expect(r?.status).toBe("ready_create");
    expect(r?.outcome.identifierAdds).toEqual([{ type: "sku", value: "A1" }]);
    const trimmed = r?.issues.filter((i) => i.code === "whitespace_trimmed") ?? [];
    expect(trimmed.map((i) => [i.columnNumber, i.field, i.severity])).toEqual([
      [1, "sku", "notice"],
      [2, "name", "notice"],
      [3, "tax_category", "notice"],
      [4, null, "notice"],
    ]);
  });

  it("does not report a cell it left alone, and shows a whitespace-only cell as blank", () => {
    const [r] = run("create", SNT, [["A1", "Tea", "standard"]]);
    expect(codes(r!)).toEqual([]);
    expect(trimmedCellText(`  ${NBSP} `)).toBeNull();
    expect(trimmedCellText(`${NBSP}x${NBSP}`)).toBe("x");
    expect(trimmedCellText({ t: "f", v: { t: "b", v: "true" } })).toBe("true");
    expect(trimmedCellText({ t: "f", v: null })).toBeNull();
    expect(trimmedCellText(undefined)).toBeNull();
  });
});

describe("identifier cells", () => {
  it("an XLSX number cell is identifier_numeric_cell with the fix, and the row is an error", () => {
    const [r] = run("create", SNT, [[num("6220000000001"), "Tea", "standard"]]);
    expect(r?.status).toBe("error");
    expect(r?.issues.find((i) => i.code === "identifier_numeric_cell")).toMatchObject({ severity: "error", field: "sku", columnNumber: 1 });
    expect(r?.issues[0]?.message).toMatch(/Text/);
  });

  it("an identifier from a formula is an error, cached or not", () => {
    expect(run("create", SNT, [[formula("A1"), "Tea", "standard"]])[0]?.issues.map((i) => i.code)).toEqual(["identifier_formula_cell"]);
    expect(run("create", SNT, [[formula(null), "Tea", "standard"]])[0]?.issues.map((i) => i.code)).toEqual(["identifier_formula_cell"]);
  });

  it("a boolean or date cell is not an identifier either", () => {
    expect(codes(run("create", SNT, [[{ t: "b", v: "true" }, "Tea", "standard"]])[0]!)).toEqual(["value_invalid"]);
    expect(codes(run("create", SNT, [[{ t: "d", v: "2026-01-01T00:00:00.000Z" }, "Tea", "standard"]])[0]!)).toEqual(["value_invalid"]);
  });

  it("Arabic-Indic digits in a barcode or a PLU are an error (OD-15); a SKU may hold any script", () => {
    const map = mapOf("barcode", "plu", "sku", "name", "tax_category");
    const [r] = run("create", map, [[AR.digits, `12${AR.digits.slice(0, 1)}`, AR.digits, "Tea", "standard"]]);
    expect(r?.issues.filter((i) => i.code === "identifier_non_ascii_digits").map((i) => i.field)).toEqual(["barcode", "plu"]);
    expect(r?.status).toBe("error");
    // Extended (Persian) digits too.
    expect(codes(run("create", mapOf("barcode", "name", "tax_category"), [["\u{06F1}\u{06F2}", "Tea", "standard"]])[0]!)).toContain("identifier_non_ascii_digits");
    // The SKU alone is fine.
    expect(run("create", map, [[null, null, AR.digits, "Tea", "standard"]])[0]?.status).toBe("ready_create");
  });

  it("a bidi mark or NBSP INSIDE an identifier is an error (it can never match a scan)", () => {
    for (const hidden of [NBSP, RLM, LRM, ALM]) {
      expect(codes(run("create", SNT, [[`A${hidden}1`, "Tea", "standard"]])[0]!)).toContain("identifier_invisible_char");
    }
  });

  it("a control character, a length over 200 and a leading BOM-like space fail the identifier pattern; 200 passes", () => {
    expect(codes(run("create", SNT, [["A\u{0009}1", "Tea", "standard"]])[0]!)).toContain("value_invalid");
    expect(codes(run("create", SNT, [["x".repeat(201), "Tea", "standard"]])[0]!)).toContain("value_invalid");
    expect(run("create", SNT, [["x".repeat(200), "Tea", "standard"]])[0]?.status).toBe("ready_create");
    expect(codes(run("create", SNT, [["\u{FEFF}A1", "Tea", "standard"]])[0]!)).toContain("value_invalid");
    // The identifier is stored byte for byte: case and inner spaces are kept.
    expect(run("create", SNT, [["Ab 1", "Tea", "standard"]])[0]?.outcome.identifierAdds).toEqual([{ type: "sku", value: "Ab 1" }]);
  });

  it("leading zeros are kept: a text barcode is never converted", () => {
    const [r] = run("create", mapOf("barcode", "name", "tax_category"), [["0012345678905", "Tea", "standard"]]);
    expect(r?.outcome.identifierAdds).toEqual([{ type: "barcode", value: "0012345678905" }]);
  });
});

describe("GTIN check digit (OD-16): a warning, never an error", () => {
  const map = mapOf("barcode", "name", "tax_category");
  it.each(["4006381333931", "96385074", "036000291452", "10012345678902", "6223001360018"])("accepts the valid GTIN %s", (gtin) => {
    expect(codes(run("create", map, [[gtin, "Tea", "standard"]])[0]!)).toEqual([]);
  });

  it.each(["4006381333930", "96385075", "036000291453", "10012345678903"])("warns on %s and still lets the row through", (bad) => {
    const [r] = run("create", map, [[bad, "Tea", "standard"]]);
    expect(r?.issues.map((i) => [i.code, i.severity, i.field])).toEqual([["gtin_check_digit", "warning", "barcode"]]);
    expect(r?.status).toBe("ready_create");
  });

  it("does not check a value that is not 8, 12, 13 or 14 digits (it may be an internal code)", () => {
    for (const value of ["1234567", "123456789", "12345678901234567", "ABC12345", "12345678A"]) {
      expect(codes(run("create", map, [[value, "Tea", "standard"]])[0]!)).toEqual([]);
    }
  });
});

describe("field text rules", () => {
  const map = mapOf("sku", "name", "description", "tax_category", "category", "brand");
  it("accepts the limits and refuses past them", () => {
    const ok = run("create", map, [["S1", "n".repeat(500), "d".repeat(2000), "t".repeat(50), null, "b".repeat(200)]], catalogue({ brands: ["b".repeat(200)] }));
    expect(ok[0]?.status).toBe("ready_create");
    const bad = run("create", map, [["S1", "n".repeat(501), "d".repeat(2001), "t".repeat(51), null, "b".repeat(201)]]);
    expect(bad[0]?.issues.filter((i) => i.code === "value_invalid").map((i) => i.field)).toEqual(["name", "description", "tax_category", "brand"]);
    expect(bad[0]?.status).toBe("error");
  });

  it("counts code points, not UTF-16 units", () => {
    const emoji = "\u{1F600}".repeat(50);
    expect(run("create", mapOf("sku", "name", "tax_category"), [["S1", "Tea", emoji]])[0]?.status).toBe("ready_create");
    expect(codes(run("create", mapOf("sku", "name", "tax_category"), [["S1", "Tea", `${emoji}\u{1F600}`]])[0]!)).toContain("value_invalid");
  });

  it("create needs a name and a tax category (required_field_missing); update does not", () => {
    const [r] = run("create", SNT, [["A1", null, null]]);
    expect(r?.issues.filter((i) => i.code === "required_field_missing").map((i) => [i.field, i.columnNumber])).toEqual([
      ["name", 2],
      ["tax_category", 3],
    ]);
    expect(r?.status).toBe("error");
    const lookups = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1" }] });
    expect(run("update", SNT, [["A1", null, null]], lookups)[0]?.status).toBe("unchanged");
    expect(run("upsert", SNT, [["A1", null, null]], lookups)[0]?.status).toBe("unchanged");
    // upsert needs them only when the row creates
    expect(run("upsert", SNT, [["NEW", null, null]], lookups)[0]?.status).toBe("error");
  });

  it("a whitespace-only name is required_field_missing, and one invalid cell is not reported twice", () => {
    expect(run("create", SNT, [["A1", "   ", "standard"]])[0]?.issues.map((i) => i.code)).toEqual(["whitespace_trimmed", "required_field_missing"]);
    const [r] = run("create", SNT, [["A1", "n".repeat(501), "standard"]]);
    expect(codes(r!)).toEqual(["value_invalid"]);
  });
});

describe("is_active (OD-17)", () => {
  const map = mapOf("sku", "is_active");
  const lookups = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1", active: true }, { id: P2, name: "Old", sku: "A2", active: false }] });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["Yes", true],
    [AR.yes, true],
    ["false", false],
    ["False", false],
    ["0", false],
    ["NO", false],
    [AR.no, false],
  ])("reads %s", (text, expected) => {
    const [r] = run("update", map, [["A2", text]], lookups);
    expect(r?.outcome.fieldChanges.some((c) => c.field === "is_active")).toBe(expected);
  });

  it("refuses anything else as value_invalid", () => {
    for (const text of ["maybe", "2", "y", "on", "null"]) {
      expect(codes(run("update", map, [["A1", text]], lookups)[0]!)).toEqual(["value_invalid"]);
    }
  });

  it("a boolean cell, a number cell 1/0 and LibreOffice's =TRUE() formula all read", () => {
    const cases: StagedCell[] = [{ t: "b", v: "false" }, num("0"), { t: "f", v: { t: "b", v: "false" } }];
    for (const cell of cases) {
      const [r] = run("update", map, [["A1", cell]], lookups);
      expect(r?.outcome.fieldChanges).toEqual([{ field: "is_active", before: "true", after: "false" }]);
    }
    const [f] = run("update", map, [["A1", { t: "f", v: { t: "b", v: "false" } }]], lookups);
    expect(f?.issues.map((i) => i.code)).toEqual(["formula_cached_value", "deactivates_product"]);
  });

  it("counts a deactivation (a warning) only when an active product goes inactive", () => {
    expect(run("update", map, [["A1", "false"]], lookups)[0]?.issues.map((i) => i.code)).toEqual(["deactivates_product"]);
    expect(run("update", map, [["A1", "false"]], lookups)[0]?.issues[0]?.severity).toBe("warning");
    expect(codes(run("update", map, [["A2", "false"]], lookups)[0]!)).toEqual([]);
    expect(run("update", map, [["A2", "false"]], lookups)[0]?.status).toBe("unchanged");
    // On create `false` is just the value.
    expect(codes(run("create", mapOf("sku", "name", "tax_category", "is_active"), [["N1", "Tea", "standard", "false"]])[0]!)).toEqual([]);
  });
});

describe("formula cells outside identifiers (spec 049 section 5)", () => {
  it("use the cached value and count a notice; an uncached formula is an error", () => {
    const [ok] = run("create", SNT, [["A1", formula("Tea"), "standard"]]);
    expect(ok?.status).toBe("ready_create");
    expect(ok?.issues.map((i) => [i.code, i.severity, i.field])).toEqual([["formula_cached_value", "notice", "name"]]);
    const [bad] = run("create", SNT, [["A1", formula(null), "standard"]]);
    expect(bad?.status).toBe("error");
    expect(bad?.issues.map((i) => i.code)).toEqual(["formula_without_value"]);
  });

  it("an update reads the cached value as the new one", () => {
    const lookups = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1" }] });
    const [r] = run("update", SNT, [["A1", formula("Green tea"), null]], lookups);
    expect(r?.outcome.fieldChanges).toEqual([{ field: "name", before: "Tea", after: "Green tea" }]);
  });
});

describe("price and currency (OD-2): recognised, never interpreted", () => {
  const map = mapOf("sku", "name", "tax_category", "price", "currency");
  it("a price value is a notice; currency alone is not; a number or text price is never read", () => {
    expect(codes(run("create", map, [["A1", "Tea", "standard", "12.5", "EGP"]])[0]!)).toEqual(["price_not_imported"]);
    expect(codes(run("create", map, [["A1", "Tea", "standard", num("12.5"), null]])[0]!)).toEqual(["price_not_imported"]);
    expect(codes(run("create", map, [["A1", "Tea", "standard", "not a price", null]])[0]!)).toEqual(["price_not_imported"]);
    expect(codes(run("create", map, [["A1", "Tea", "standard", null, "EGP"]])[0]!)).toEqual([]);
    expect(run("create", map, [["A1", "Tea", "standard", "12.5", "EGP"]])[0]?.status).toBe("ready_create");
  });

  it("a price never changes an updated product", () => {
    const lookups = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1" }] });
    const [r] = run("update", map, [["A1", null, null, "99", "USD"]], lookups);
    expect(r?.status).toBe("unchanged");
    expect(r?.outcome.fieldChanges).toEqual([]);
  });
});

describe("category and brand (OD-3), tax category", () => {
  const map = mapOf("sku", "name", "tax_category", "category", "brand");
  const lookups = catalogue({ categories: ["Drinks"], brands: ["Acme"], usedTax: ["standard"] });

  it("a category must exist, by exact name: otherwise category_not_found (OD-3 A)", () => {
    expect(run("create", map, [["A1", "Tea", "standard", "Drinks", null]], lookups)[0]?.status).toBe("ready_create");
    const [r] = run("create", map, [["A1", "Tea", "standard", "drinks", null]], lookups);
    expect(r?.status).toBe("error");
    expect(r?.issues.map((i) => [i.code, i.field, i.columnNumber])).toEqual([["category_not_found", "category", 4]]);
  });

  it("a missing brand is created at publish and listed (OD-3 B); an existing one is not", () => {
    const [made] = run("create", map, [["A1", "Tea", "standard", null, "Nova"]], lookups);
    expect(made?.status).toBe("ready_create");
    expect(made?.outcome.brandToCreate).toBe("Nova");
    expect(made?.issues.map((i) => [i.code, i.severity])).toEqual([["brand_created", "notice"]]);
    const [have] = run("create", map, [["A1", "Tea", "standard", null, "Acme"]], lookups);
    expect(have?.outcome.brandToCreate).toBeNull();
    expect(codes(have!)).toEqual([]);
  });

  it("a row that cannot be written creates no brand", () => {
    const [r] = run("create", map, [["A1", null, "standard", null, "Nova"]], lookups);
    expect(r?.status).toBe("error");
    expect(r?.outcome.brandToCreate).toBeNull();
    expect(codes(r!)).not.toContain("brand_created");
  });

  it("a tax category the tenant never used is a warning, not an error", () => {
    const [r] = run("create", map, [["A1", "Tea", "stnadard", null, null]], lookups);
    expect(r?.status).toBe("ready_create");
    expect(r?.issues.map((i) => [i.code, i.severity])).toEqual([["tax_category_unused", "warning"]]);
  });
});

describe("matching (spec 049 section 7.1) and the modes (section 7.2)", () => {
  const A = { id: P1, name: "Tea", sku: "A1", barcodes: ["6223001360018"], plu: "77" };
  const B = { id: P2, name: "Coffee", sku: "B1", barcodes: ["4006381333931"] };
  const lookups = catalogue({ products: [A, B] });
  const map = mapOf("sku", "barcode", "plu", "name", "tax_category");

  it("no identifier is active: no_match; create and upsert create, update is not_found", () => {
    const row = ["NEW", null, null, "Tea 2", "standard"] as const;
    const [c] = run("create", map, [row], lookups);
    expect([c?.status, c?.outcome.match]).toEqual(["ready_create", "no_match"]);
    expect(run("upsert", map, [row], lookups)[0]?.status).toBe("ready_create");
    const [u] = run("update", map, [row], lookups);
    expect([u?.status, u?.issues.map((i) => i.code)]).toEqual(["error", ["not_found"]]);
  });

  it("a SKU match: create is already_exists naming the product (OD-11); update and upsert update it", () => {
    const row = ["A1", null, null, "Tea", "standard"] as const;
    const [c] = run("create", map, [row], lookups);
    expect(c?.status).toBe("error");
    expect(c?.issues[0]).toMatchObject({
      code: "already_exists",
      severity: "error",
      relatedProduct: { productId: P1, name: "Tea", identifiers: [{ type: "sku", value: "A1" }, { type: "barcode", value: "6223001360018" }, { type: "plu", value: "77" }] },
    });
    expect(c?.outcome.matchedProduct?.productId).toBe(P1);
    for (const mode of ["update", "upsert"] as const) {
      const [r] = run(mode, map, [row], lookups);
      expect([r?.status, r?.outcome.match, r?.matchedUpdatedAt]).toEqual(["unchanged", "match", "2026-11-20 10:00:00.123456+00"]);
    }
  });

  it("a barcode or PLU alone matches; the SKU is not required", () => {
    expect(run("update", map, [[null, "6223001360018", null, "Tea", "standard"]], lookups)[0]?.outcome.matchedProduct?.productId).toBe(P1);
    expect(run("update", map, [[null, null, "77", "Tea", "standard"]], lookups)[0]?.outcome.matchedProduct?.productId).toBe(P1);
  });

  it("is by (type, value): a barcode 77 does not match the PLU 77", () => {
    const [r] = run("update", map, [[null, "77", null, "Tea", "standard"]], lookups);
    expect(r?.issues.map((i) => i.code)).toEqual(["not_found"]);
  });

  it("is byte for byte: no case folding, no trimming of inner space, no prefix, never the name", () => {
    expect(codes(run("update", map, [["a1", null, null, "Tea", "standard"]], lookups)[0]!)).toEqual(["not_found"]);
    expect(codes(run("update", map, [["A1 ", null, null, "Tea", "standard"]], lookups)[0]!)).toEqual(["whitespace_trimmed"]);
    expect(codes(run("update", map, [["A", null, null, "Tea", "standard"]], lookups)[0]!)).toEqual(["not_found"]);
    expect(codes(run("update", map, [[null, null, null, "Tea", "standard"]], lookups)[0]!)).toEqual(["not_found"]);
  });

  it("identifiers that resolve to one product are a match", () => {
    const [r] = run("update", map, [["A1", "6223001360018", "77", "Tea", "standard"]], lookups);
    expect([r?.status, r?.outcome.match, r?.outcome.identifierAdds]).toEqual(["unchanged", "match", []]);
  });

  it("identifiers that resolve to two products are ambiguous: a review with both as candidates, in every mode (421)", () => {
    for (const mode of ["create", "update", "upsert"] as const) {
      const [r] = run(mode, map, [["A1", "4006381333931", null, "Tea", "standard"]], lookups);
      expect([r?.status, r?.reviewReason, r?.outcome.match]).toEqual(["needs_review", "ambiguous", "ambiguous"]);
      expect(r?.outcome.candidates.map((c) => c.productId)).toEqual([P1, P2]);
      expect(r?.outcome.matchedProduct).toBeNull();
      expect(r?.matchedUpdatedAt).toBeNull();
    }
  });

  it("a retired matched product is product_retired in every mode (no un-retire)", () => {
    const retired = catalogue({ products: [{ id: P3, name: "Gone", sku: "R1", retired: true }] });
    for (const mode of ["create", "update", "upsert"] as const) {
      const [r] = run(mode, map, [["R1", null, null, "Gone", "standard"]], retired);
      expect([r?.status, r?.issues[0]?.code, r?.issues[0]?.relatedProduct?.productId]).toEqual(["error", "product_retired", P3]);
    }
  });

  it("an update lists the fields that differ, before and after; a blank cell is unchanged (OD-5)", () => {
    const l = catalogue({ products: [{ ...A, description: "old", tax: "standard", category: "Drinks", brand: "Acme" }], categories: ["Drinks", "Food"], brands: ["Acme", "Nova"] });
    const m = mapOf("sku", "name", "description", "tax_category", "category", "brand", "is_active");
    const [changed] = run("update", m, [["A1", "Green tea", "new", "reduced", "Food", "Nova", "false"]], catalogue({ products: [{ ...A, description: "old", tax: "standard", category: "Drinks", brand: "Acme" }], categories: ["Drinks", "Food"], brands: ["Acme", "Nova"], usedTax: ["standard", "reduced"] }));
    expect(changed?.status).toBe("ready_update");
    expect(changed?.outcome.fieldChanges).toEqual([
      { field: "name", before: "Tea", after: "Green tea" },
      { field: "description", before: "old", after: "new" },
      { field: "category", before: "Drinks", after: "Food" },
      { field: "brand", before: "Acme", after: "Nova" },
      { field: "tax_category", before: "standard", after: "reduced" },
      { field: "is_active", before: "true", after: "false" },
    ]);
    const [blank] = run("update", m, [["A1", null, null, null, null, null, null]], l);
    expect([blank?.status, blank?.outcome.fieldChanges]).toEqual(["unchanged", []]);
    const [same] = run("update", m, [["A1", "Tea", "old", "standard", "Drinks", "Acme", "true"]], l);
    expect(same?.status).toBe("unchanged");
  });

  it("a brand to create is a field change of an update", () => {
    const l = catalogue({ products: [{ ...A, brand: "Acme" }], brands: ["Acme"] });
    const [r] = run("update", mapOf("sku", "brand"), [["A1", "Brand New"]], l);
    expect(r?.outcome.fieldChanges).toEqual([{ field: "brand", before: "Acme", after: "Brand New" }]);
    expect(r?.outcome.brandToCreate).toBe("Brand New");
  });

  it("a free barcode or PLU on a matched product is an identifier add (never a move)", () => {
    const [r] = run("update", map, [["A1", "5901234123457", "88", "Tea", "standard"]], lookups);
    expect(r?.status).toBe("ready_update");
    expect(r?.outcome.identifierAdds).toEqual([
      { type: "barcode", value: "5901234123457" },
      { type: "plu", value: "88" },
    ]);
  });

  it("a created product gets every identifier of its row", () => {
    const [r] = run("create", map, [["N1", "5901234123457", "88", "New", "standard"]], lookups);
    expect(r?.outcome.identifierAdds).toEqual([
      { type: "sku", value: "N1" },
      { type: "barcode", value: "5901234123457" },
      { type: "plu", value: "88" },
    ]);
  });

  it("up to five barcode columns and one SKU and PLU make seven adds", () => {
    const m = mapOf("sku", "barcode", "barcode", "barcode", "barcode", "barcode", "plu", "name", "tax_category");
    const [r] = run("create", m, [["S", "10000001", "10000002", "10000003", "10000004", "10000005", "9", "New", "standard"]], lookups);
    expect(r?.outcome.identifierAdds).toHaveLength(7);
  });
});

describe("review reasons (spec 049 section 7.3)", () => {
  const A = { id: P1, name: "Tea", sku: "A1", barcodes: ["6223001360018"] };
  const NOSKU = { id: P2, name: "Coffee", barcodes: ["4006381333931"] };
  const map = mapOf("sku", "barcode", "name", "tax_category");

  it("sku_mismatch: a barcode that matches a product with another SKU is a review, never a second SKU (OD-1)", () => {
    const [r] = run("update", map, [["A2", "6223001360018", "Tea", "standard"]], catalogue({ products: [A] }));
    expect([r?.status, r?.reviewReason]).toEqual(["needs_review", "sku_mismatch"]);
    expect(r?.issues.find((i) => i.code === "sku_mismatch")).toMatchObject({ severity: "review", field: "sku", relatedProduct: { productId: P1 } });
    expect(r?.outcome.candidates.map((c) => c.productId)).toEqual([P1]);
    expect(r?.outcome.identifierAdds).toEqual([]);
  });

  it("a SKU on a matched product that has none is an identifier add", () => {
    const [r] = run("upsert", map, [["NEWSKU", "4006381333931", "Coffee", "standard"]], catalogue({ products: [NOSKU] }));
    expect([r?.status, r?.outcome.identifierAdds]).toEqual(["ready_update", [{ type: "sku", value: "NEWSKU" }]]);
  });

  it("store_scoped_conflict: a free barcode that is another product's store-scoped one is a review", () => {
    const l = catalogue({ products: [A, NOSKU], storeScoped: [{ type: "barcode", value: "5901234123457", productId: P2 }] });
    const [r] = run("update", map, [["A1", "5901234123457", "Tea", "standard"]], l);
    expect([r?.status, r?.reviewReason]).toEqual(["needs_review", "store_scoped_conflict"]);
    expect(r?.issues.find((i) => i.code === "store_scoped_conflict")).toMatchObject({ field: "barcode", relatedProduct: { productId: P2, name: "Coffee" } });
    expect(r?.outcome.identifierAdds).toEqual([]);
    // For a create it is the same review, with no candidate to update.
    const [c] = run("create", map, [["N1", "5901234123457", "New", "standard"]], l);
    expect([c?.status, c?.reviewReason, c?.outcome.candidates]).toEqual(["needs_review", "store_scoped_conflict", []]);
  });

  it("the same product's store-scoped identifier is a warning, not a review", () => {
    const l = catalogue({ products: [A], storeScoped: [{ type: "barcode", value: "5901234123457", productId: P1 }] });
    const [r] = run("update", map, [["A1", "5901234123457", "Tea", "standard"]], l);
    expect([r?.status, r?.issues.map((i) => [i.code, i.severity])]).toEqual(["ready_update", [["store_scoped_same_product", "warning"]]]);
    expect(r?.outcome.identifierAdds).toEqual([{ type: "barcode", value: "5901234123457" }]);
  });

  it("a store-scoped identifier is only checked for a value the row would add", () => {
    const l = catalogue({ products: [A, NOSKU], storeScoped: [{ type: "barcode", value: "6223001360018", productId: P2 }] });
    const [r] = run("update", map, [["A1", "6223001360018", "Tea", "standard"]], l);
    expect(r?.status).toBe("unchanged");
  });

  it("no_identifier: a create or upsert row with none is a review; an update row is not_found", () => {
    for (const mode of ["create", "upsert"] as const) {
      const [r] = run(mode, map, [[null, null, "New", "standard"]]);
      expect([r?.status, r?.reviewReason, r?.issues.map((i) => i.code)]).toEqual(["needs_review", "no_identifier", ["no_identifier"]]);
    }
    expect(run("update", map, [[null, null, "New", "standard"]])[0]?.issues.map((i) => i.code)).toEqual(["not_found"]);
  });

  it("possible_duplicate: a create whose exact name is an active product's is a hint for a human", () => {
    const l = catalogue({ products: [A, { id: P3, name: "Tea", sku: "T9" }] });
    const [r] = run("create", map, [["N1", null, "Tea", "standard"]], l);
    expect([r?.status, r?.reviewReason]).toEqual(["needs_review", "possible_duplicate"]);
    expect(r?.outcome.candidates.map((c) => c.productId)).toEqual([P1, P3]);
    expect(r?.issues[0]).toMatchObject({ code: "possible_duplicate", field: "name", relatedProduct: { productId: P1 } });
    // Case and spacing matter: an exact comparison only.
    expect(run("create", map, [["N1", null, "tea", "standard"]], l)[0]?.status).toBe("ready_create");
    // A retired product's name is not a duplicate.
    const gone = catalogue({ products: [{ id: P3, name: "Tea", sku: "T9", retired: true }] });
    expect(run("create", map, [["N1", null, "Tea", "standard"]], gone)[0]?.status).toBe("ready_create");
  });

  it("lists every review issue but names one reason, in the order ambiguous, sku_mismatch, store_scoped_conflict, no_identifier, possible_duplicate", () => {
    const l = catalogue({ products: [A, { id: P3, name: "New", sku: "T9" }] });
    // No identifier AND a duplicate name: the reason is no_identifier, both are listed.
    const [r] = run("create", map, [[null, null, "New", "standard"]], l);
    expect(r?.reviewReason).toBe("no_identifier");
    expect(r?.issues.map((i) => i.code)).toEqual(["no_identifier", "possible_duplicate"]);
  });

  it("an error row drops its review issues and its outcome writes nothing", () => {
    const l = catalogue({ products: [A], brands: [] });
    const [r] = run("create", mapOf("sku", "name", "tax_category", "brand"), [[null, null, "standard", "Nova"]], l);
    expect(r?.status).toBe("error");
    expect(r?.reviewReason).toBeNull();
    expect(codes(r!)).toEqual(["required_field_missing"]);
    expect(r?.outcome).toMatchObject({ candidates: [], fieldChanges: [], identifierAdds: [], brandToCreate: null });
  });
});

describe("duplicates inside the file (spec 049 section 5): both rows are errors, no first-wins", () => {
  it("names the other row; a value that is a barcode in one row and a PLU in another is not a duplicate", () => {
    const m = mapOf("sku", "barcode", "name", "tax_category");
    const rows = run("create", m, [
      ["S1", null, "A", "standard"],
      ["S1", null, "B", "standard"],
      ["S2", "10000001", "C", "standard"],
      [null, "10000001", "D", "standard"],
      ["10000001", null, "E", "standard"],
      ["S3", "10000009", "F", "standard"],
      ["S3", "10000009", "G", "standard"],
    ]);
    expect(rows.map((r) => r.status)).toEqual(["error", "error", "error", "error", "ready_create", "error", "error"]);
    expect(rows[0]?.issues.find((i) => i.code === "duplicate_in_file")).toMatchObject({ field: "sku", columnNumber: 1, relatedRowNumber: 3 });
    expect(rows[1]?.issues.find((i) => i.code === "duplicate_in_file")).toMatchObject({ relatedRowNumber: 2 });
    expect(rows[2]?.issues.filter((i) => i.code === "duplicate_in_file").map((i) => [i.field, i.relatedRowNumber])).toEqual([["barcode", 5]]);
  });

  it("the same identifier twice on ONE row is a single identifier", () => {
    const m = mapOf("barcode", "barcode", "name", "tax_category");
    const [r] = run("create", m, [["10000001", "10000001", "A", "standard"]]);
    expect([r?.status, r?.outcome.identifierAdds]).toEqual(["ready_create", [{ type: "barcode", value: "10000001" }]]);
  });

  it("an invalid identifier does not make a duplicate", () => {
    const m = mapOf("sku", "name", "tax_category");
    const rows = run("create", m, [["A\u{0001}x", "A", "standard"], ["A\u{0001}x", "B", "standard"]]);
    expect(rows.map((r) => codes(r))).toEqual([["value_invalid"], ["value_invalid"]]);
  });
});

describe("every row has exactly one status (decision 419) and the preview hash is stable", () => {
  it("counts every row", () => {
    const l = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1" }] });
    const results = run("upsert", SNT, [["A1", "Tea", "standard"], ["N1", "New", "standard"], ["N2", null, "standard"], [null, "Anon", "standard"], ["A1x", "Dup", "standard"]], l);
    const counts = countStatuses(results);
    expect(counts).toEqual({ ready_create: 2, ready_update: 0, unchanged: 1, needs_review: 1, error: 1, excluded: 0 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(results.length);
    expect(results.map((r) => r.rowNumber)).toEqual([2, 3, 4, 5, 6]);
  });

  it("is the same for the same input and changes with the mode, a field or a product's updated_at", () => {
    const l = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1" }] });
    const rows = [["A1", "Green", "standard"]] as const;
    const base = previewHashOf("upsert", run("upsert", SNT, rows, l));
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(previewHashOf("upsert", run("upsert", SNT, rows, l))).toBe(base);
    expect(previewHashOf("update", run("upsert", SNT, rows, l))).not.toBe(base);
    expect(previewHashOf("upsert", run("upsert", SNT, [["A1", "Greener", "standard"]], l))).not.toBe(base);
    const moved = catalogue({ products: [{ id: P1, name: "Tea", sku: "A1", updated: "2026-11-21 10:00:00+00" }] });
    expect(previewHashOf("upsert", run("upsert", SNT, rows, moved))).not.toBe(base);
  });
});

describe("collectLookupKeys", () => {
  it("lists each identifier, name, category, brand and tax category once", () => {
    const m = mapOf("sku", "barcode", "name", "tax_category", "category", "brand");
    const rows = parseRows(m, [
      { rowNumber: 2, cells: ["S1", "10000001", "Tea", "standard", "Drinks", "Acme"] },
      { rowNumber: 3, cells: ["S1", "10000002", "Tea", "standard", "Drinks", "Acme"] },
    ]);
    const keys = collectLookupKeys(rows);
    expect(keys.identifierTypes.map((t, i) => `${t}:${keys.identifierValues[i]}`)).toEqual(["sku:S1", "barcode:10000001", "barcode:10000002"]);
    expect([keys.names, keys.categories, keys.brands, keys.taxCategories]).toEqual([["Tea"], ["Drinks"], ["Acme"], ["standard"]]);
  });
});

describe("performance: validating 5,000 rows of 50 columns stays linear (spec 049 section 8.5)", () => {
  const FIELDS = ["sku", "barcode", "plu", "name", "description", "category", "brand", "tax_category", "is_active", "price", "currency"] as const;
  const mapping = Array.from({ length: 50 }, (_v, i) => ({ columnNumber: i + 1, target: i < FIELDS.length ? FIELDS[i]! : ("ignore" as const) }));
  const products = Array.from({ length: 2000 }, (_v, i) => ({ id: `0192f000-0000-7000-8000-${String(i).padStart(12, "0")}`, name: `Product ${i}`, sku: `SKU${i}`, barcodes: [`2${String(i).padStart(7, "0")}`] }));
  const lookups = catalogue({ products, categories: ["Drinks"], brands: ["Acme"] });

  const fileOf = (n: number): StagedCell[][] =>
    Array.from({ length: n }, (_v, r) => {
      const cells: StagedCell[] = Array.from({ length: 50 }, (_w, c) => `  r${r}c${c}  `);
      cells[0] = `SKU${r}`;
      cells[1] = `2${String(r).padStart(7, "0")}`;
      cells[2] = null;
      cells[3] = `Product ${r}`;
      cells[5] = "Drinks";
      cells[6] = "Acme";
      cells[7] = "standard";
      cells[8] = "true";
      return cells;
    });

  const timeIt = (rowsIn: StagedCell[][]): number => {
    const started = process.hrtime.bigint();
    const parsed = parseRows(mapping, rowsIn.map((cells, i) => ({ rowNumber: i + 2, cells })));
    collectLookupKeys(parsed);
    const results = evaluateRows("upsert", mapping, parsed, lookups);
    expect(results).toHaveLength(rowsIn.length);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const best = (rowsIn: StagedCell[][]): number => Math.min(timeIt(rowsIn), timeIt(rowsIn), timeIt(rowsIn));

  it("twice the rows is nowhere near four times the time (best of three, so a slow CI box does not flip it)", () => {
    const small = fileOf(1500);
    const large = fileOf(3000);
    const ratio = best(large) / best(small);
    expect(ratio).toBeLessThan(3.2);
  });

  it("5,000 x 50 validates in a few seconds even under coverage (the work itself is a fraction of a second)", () => {
    const ms = timeIt(fileOf(5000));
    expect(ms).toBeLessThan(9000);
  });

  it("5,000 rows of 50 columns give 5,000 results and every row is trimmed once per cell that needed it", () => {
    const parsed = parseRows(mapping, fileOf(100).map((cells, i) => ({ rowNumber: i + 2, cells })));
    const trimmed = parsed[0]!.issues.filter((i) => i.code === "whitespace_trimmed");
    // 50 columns, minus the eight cells the file builder wrote without padding.
    expect(trimmed).toHaveLength(42);
  });
});
