/**
 * RT-1537 (spec 049 S5c): the pure parts of the template, the error report and the file replace: the CSV rules (BOM,
 * CRLF, quoting, the formula guard), the template's headers against the auto-mapping, the report's lines, and what a
 * re-upload carries of the previous mapping.
 */
import "reflect-metadata";

import { carryMapping } from "../../../src/catalog/catalog-import/import-replace-carry";
import { buildErrorReportCsv, errorReportDisposition, formatIssues, type ReportRow } from "../../../src/catalog/catalog-import/import-error-report";
import { attachmentDisposition, CSV_BOM, csvField, csvLine, guardFormula } from "../../../src/catalog/catalog-import/import-csv";
import { makeIssue } from "../../../src/catalog/catalog-import/import-issues";
import { CANONICAL_FIELDS } from "../../../src/catalog/catalog-import/import-mapping";
import { suggestMapping, synonymFieldOf } from "../../../src/catalog/catalog-import/import-synonyms";
import { buildTemplateCsv, TEMPLATE_HEADERS, TEMPLATE_LANGUAGES, templateDisposition, TemplateQuerySchema } from "../../../src/catalog/catalog-import/import-template";
import { ReplaceQuerySchema } from "../../../src/catalog/catalog-import/import-upload.query";

describe("CSV rules", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("guards a cell that starts a formula: %j", (cell) => {
    expect(guardFormula(cell)).toBe(`'${cell}`);
  });

  it("leaves other cells alone, including an empty one and one with the trigger inside", () => {
    for (const cell of ["", "abc", "a=b", " =1", "1-1", "'=1"]) expect(guardFormula(cell)).toBe(cell);
  });

  it("quotes a field with a comma, a quote or a line break, doubling quotes, and guards before quoting", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("x\ny")).toBe('"x\ny"');
    expect(csvField("=A1,B1")).toBe(`"'=A1,B1"`);
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("plain")).toBe("plain");
  });

  it("ends a record with CRLF", () => {
    expect(csvLine(["a", "b,c", "-1"])).toBe("a,\"b,c\",'-1\r\n");
  });

  it("builds an RFC 6266 disposition from a plain ASCII name only", () => {
    expect(attachmentDisposition("import-template-ar.csv")).toBe(`attachment; filename="import-template-ar.csv"; filename*=UTF-8''import-template-ar.csv`);
    for (const bad of ['a"b.csv', "a b.csv", "\u{627}.csv", "../x.csv", ""]) expect(() => attachmentDisposition(bad)).toThrow();
  });
});

describe("the template", () => {
  it.each(TEMPLATE_LANGUAGES)("%s: every canonical field once, in order, each header a synonym the auto-mapping recognises", (language) => {
    for (const field of CANONICAL_FIELDS) expect(synonymFieldOf(TEMPLATE_HEADERS[language][field])).toBe(field);
    const csv = buildTemplateCsv(language);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const headers = lines[0]!.split(",");
    expect(headers).toEqual(CANONICAL_FIELDS.map((f) => TEMPLATE_HEADERS[language][f]));
    // The auto-mapping places every column of the template, each field once.
    const suggested = suggestMapping(headers.map((header, i) => ({ columnNumber: i + 1, header })), []).suggested;
    expect(suggested.map((m) => m.target)).toEqual([...CANONICAL_FIELDS]);
  });

  it("the Arabic and English headers differ for every field", () => {
    for (const field of CANONICAL_FIELDS) expect(TEMPLATE_HEADERS.ar[field]).not.toBe(TEMPLATE_HEADERS.en[field]);
  });

  it("carries no data row and a disposition per language", () => {
    expect(buildTemplateCsv("en").split("\r\n").filter((l) => l !== "")).toHaveLength(1);
    expect(templateDisposition("ar")).toContain('filename="import-template-ar.csv"');
    expect(templateDisposition("en")).toContain('filename="import-template-en.csv"');
  });

  it("takes only `headers`, ar or en", () => {
    expect(TemplateQuerySchema.parse({})).toEqual({});
    expect(TemplateQuerySchema.parse({ headers: "en" })).toEqual({ headers: "en" });
    for (const bad of [{ headers: "fr" }, { headers: ["ar", "en"] }, { headers: "ar", x: "1" }]) expect(TemplateQuerySchema.safeParse(bad).success).toBe(false);
  });
});

describe("the error report", () => {
  const columns = [
    { columnNumber: 1, header: "sku", samples: [] },
    { columnNumber: 2, header: "=Name", samples: [] },
    { columnNumber: 3, header: "", samples: [] },
  ];
  const rows: ReportRow[] = [
    {
      rowNumber: 2,
      status: "error",
      issues: [makeIssue("required_field_missing", "name", 2), makeIssue("duplicate_in_file", null, null)],
      cells: ["-5", "Tea, \"green\"", null],
    },
    { rowNumber: 7, status: "needs_review", issues: [makeIssue("ambiguous", null, null)], cells: ["@cmd", { t: "n", v: "12" }, "  x  "] },
  ];

  it("starts with the BOM, lists the fixed columns then the file's headers, and one CRLF line per row", () => {
    const csv = buildErrorReportCsv(columns, rows);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    expect(lines[0]).toBe("row_number,status,issues,sku,'=Name,");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
  });

  it("guards every cell against formula injection, the headers and the issue text included", () => {
    const csv = buildErrorReportCsv(columns, rows);
    expect(csv).toContain("'=Name");
    expect(csv).toContain(",'-5,");
    expect(csv).toContain(",'@cmd,");
    // A guarded cell is the report's text only: the staged cell itself is untouched.
    expect(rows[0]!.cells[0]).toBe("-5");
  });

  it("quotes and doubles what needs it, shows the cells after the trim and a blank one empty", () => {
    const csv = buildErrorReportCsv(columns, rows);
    expect(csv).toContain('"Tea, ""green"""');
    expect(csv).toContain(",12,x\r\n");
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    expect(lines[1]!.endsWith(",")).toBe(true);
  });

  it("names every issue as code, field and message, in order", () => {
    const text = formatIssues(rows[0]!.issues);
    expect(text).toBe(
      `required_field_missing [name]: ${rows[0]!.issues[0]!.message} | duplicate_in_file: ${rows[0]!.issues[1]!.message}`,
    );
    expect(formatIssues([])).toBe("");
  });

  it("has a header line only when no row is left, and a disposition with the batch id", () => {
    expect(buildErrorReportCsv(columns, [])).toBe(`${CSV_BOM}row_number,status,issues,sku,'=Name,\r\n`);
    expect(errorReportDisposition("0192F000-0000-7000-8000-000000000001")).toBe(
      `attachment; filename="import-errors-0192f000-0000-7000-8000-000000000001.csv"; filename*=UTF-8''import-errors-0192f000-0000-7000-8000-000000000001.csv`,
    );
  });

  it("fills a row shorter than the headers with empty cells", () => {
    const csv = buildErrorReportCsv(columns, [{ rowNumber: 2, status: "error", issues: [], cells: ["a"] }]);
    expect(csv.slice(CSV_BOM.length).split("\r\n")[1]).toBe("2,error,,a,,");
  });
});

describe("what a re-upload carries", () => {
  const cols = (...headers: string[]): Array<{ columnNumber: number; header: string }> => headers.map((header, i) => ({ columnNumber: i + 1, header }));

  it("carries an entry whose header is unchanged to the column's NEW number", () => {
    const previous = [
      { columnNumber: 1, target: "sku" as const },
      { columnNumber: 2, target: "name" as const },
      { columnNumber: 3, target: "ignore" as const },
    ];
    expect(carryMapping(previous, cols("Code", "Title", "Notes"), cols("Notes", "Extra", "Title", "Code"))).toEqual([
      { columnNumber: 3, target: "name" },
      { columnNumber: 4, target: "sku" },
      { columnNumber: 1, target: "ignore" },
    ].sort((a, b) => a.columnNumber - b.columnNumber));
  });

  it("never carries an empty header, a repeated header in either file, a changed header or a header with no entry", () => {
    const previous = [
      { columnNumber: 1, target: "sku" as const },
      { columnNumber: 2, target: "name" as const },
      { columnNumber: 3, target: "brand" as const },
      { columnNumber: 4, target: "category" as const },
    ];
    // 1: empty header; 2: repeated in the new file; 3: changed text; 4: repeated in the old file only.
    const before = cols("", "Name", "Brand", "Cat");
    const duplicated = [...before.slice(0, 3), { columnNumber: 4, header: "Cat" }, { columnNumber: 5, header: "Cat" }];
    expect(carryMapping(previous, before, cols("", "Name", "Name", "Brand name", "Cat"))).toEqual([{ columnNumber: 5, target: "category" }]);
    expect(carryMapping([...previous, { columnNumber: 5, target: "plu" as const }], duplicated, cols("", "Name", "Brand", "Cat"))).toEqual([
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "brand" },
    ]);
  });

  it("carries nothing when the batch had no mapping yet", () => {
    expect(carryMapping(null, cols("a"), cols("a"))).toEqual([]);
  });

  it("is exact text: a case or space difference is another header", () => {
    expect(carryMapping([{ columnNumber: 1, target: "sku" }], cols("SKU"), cols("sku"))).toEqual([]);
  });
});

describe("suggestMapping with carried entries", () => {
  it("places the carried entries first and keeps the synonyms off every field they hold, barcode up to 5 in all", () => {
    const columns = [
      { columnNumber: 1, header: "Reference" },
      { columnNumber: 2, header: "Item Code" },
      { columnNumber: 3, header: "Barcode" },
      { columnNumber: 4, header: "EAN" },
      { columnNumber: 5, header: "UPC" },
      { columnNumber: 6, header: "GTIN" },
      { columnNumber: 7, header: "Scan Code" },
      { columnNumber: 8, header: "Barcodes" },
    ];
    // Column 1 was mapped to sku by hand: the synonym `Item Code` (also sku) must not take it again.
    const out = suggestMapping(columns, [], [{ columnNumber: 1, target: "sku" }, { columnNumber: 3, target: "barcode" }]).suggested;
    expect(out.filter((m) => m.target === "sku")).toEqual([{ columnNumber: 1, target: "sku" }]);
    expect(out.find((m) => m.columnNumber === 2)).toBeUndefined();
    expect(out.filter((m) => m.target === "barcode")).toHaveLength(5);
    expect(out[0]).toEqual({ columnNumber: 1, target: "sku" });
  });

  it("is unchanged for a call without carried entries", () => {
    const columns = [{ columnNumber: 1, header: "SKU" }, { columnNumber: 2, header: "Name" }];
    expect(suggestMapping(columns, []).suggested).toEqual(suggestMapping(columns, [], []).suggested);
  });

  it("lets a saved profile place only the columns the carried entries did not", () => {
    const columns = [{ columnNumber: 1, header: "Zeta" }, { columnNumber: 2, header: "Omega" }];
    const profile = { id: "p1", name: "P", updatedAt: new Date(0), entries: { Zeta: "sku", Omega: "name" } };
    const out = suggestMapping(columns, [profile], [{ columnNumber: 1, target: "name" }]);
    // `name` is held by the carried entry, so the profile's Omega -> name is left out; the profile cannot place anything.
    expect(out.suggested).toEqual([{ columnNumber: 1, target: "name" }]);
    expect(out.profileId).toBeNull();
  });
});

describe("the replace query", () => {
  it("takes expected_version as digits, and the file's own options", () => {
    expect(ReplaceQuerySchema.parse({ expected_version: "3" })).toEqual({ expected_version: 3 });
    expect(ReplaceQuerySchema.parse({ expected_version: "2147483647", sheet: "S", delimiter: "tab", file_name: "f.csv" })).toMatchObject({ expected_version: 2147483647 });
  });

  it.each([
    {},
    { expected_version: "0" },
    { expected_version: "-1" },
    { expected_version: "1.5" },
    { expected_version: "2147483648" },
    { expected_version: "12345678901" },
    { expected_version: ["1", "2"] },
    { expected_version: "1", mode: "create" },
    { expected_version: "1", delimiter: "pipe" },
    { expected_version: "1", file_name: "a/b.csv" },
  ])("refuses %j", (query) => {
    expect(ReplaceQuerySchema.safeParse(query).success).toBe(false);
  });
});
