/**
 * RT-1505 (spec 049 §5, §8.5): type detection from content, the CSV and XLSX
 * readers and the limits, end to end through `parseImportFile`.
 */
import { CSV_PARSER_VERSION, XLSX_PARSER_VERSION } from "../../../src/catalog/catalog-import/catalog-import.limits";
import { detectDelimiter } from "../../../src/catalog/catalog-import/csv-reader";
import { ImportFileRejectedError, type ImportFileRefusalCode } from "../../../src/catalog/catalog-import/import-file-rejected";
import { parseImportFile, type ImportParseOptions } from "../../../src/catalog/catalog-import/import-file-parser";
import { stagedCellText, type StagedCell } from "../../../src/catalog/catalog-import/staged-cell";
import { buildXlsx, buildZip, sheetXml, XLSX_MAIN_TYPE, xlsxEntries, type XlsxCell } from "./__support__/zip-fixtures";

const NONE: ImportParseOptions = { sheet: null, delimiter: null };
const csv = (text: string): Buffer => Buffer.from(text, "utf8");

async function refusal(bytes: Buffer, options: ImportParseOptions = NONE): Promise<ImportFileRefusalCode | "accepted"> {
  try {
    await parseImportFile(bytes, options);
    return "accepted";
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code;
    throw err;
  }
}

describe("CSV", () => {
  it("reads the header, the rows, the samples and the version", async () => {
    const parsed = await parseImportFile(csv("sku,name\nA1,Tea\nA2,Coffee\nA3,Milk\nA4,Sugar\n"), NONE);
    expect(parsed).toMatchObject({ kind: "csv", sheetName: null, csvDelimiter: "comma", parserVersion: CSV_PARSER_VERSION });
    expect(parsed.grid.columns).toEqual([
      { columnNumber: 1, header: "sku", samples: ["A1", "A2", "A3"] },
      { columnNumber: 2, header: "name", samples: ["Tea", "Coffee", "Milk"] },
    ]);
    expect(parsed.grid.rows.map((r) => r.rowNumber)).toEqual([2, 3, 4, 5]);
  });

  it("keeps leading zeros, never infers a type and strips a BOM", async () => {
    const parsed = await parseImportFile(csv("\u{FEFF}barcode,qty\n0012345678905,007\n"), NONE);
    expect(parsed.grid.columns[0]?.header).toBe("barcode");
    expect(parsed.grid.rows[0]?.cells).toEqual(["0012345678905", "007"]);
  });

  it("reads Arabic text, quoted commas, quoted line breaks and doubled quotes", async () => {
    const parsed = await parseImportFile(csv('الاسم,وصف\nشاي,"a, b ""c""\nd"\n'), NONE);
    expect(parsed.grid.columns.map((c) => c.header)).toEqual(["الاسم", "وصف"]);
    expect(parsed.grid.rows[0]?.cells).toEqual(["شاي", 'a, b "c"\nd']);
  });

  it("counts a record once however many lines it spans (the row number the merchant sees)", async () => {
    const parsed = await parseImportFile(csv('a,b\n"x\ny\nz",1\nq,2\n'), NONE);
    expect(parsed.grid.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it.each([
    ["comma", "a,b,c\n1,2,3\n", "comma"],
    ["semicolon", "a;b;c\n1;2;3\n", "semicolon"],
    ["tab", "a\tb\tc\n1\t2\t3\n", "tab"],
    ["a delimiter inside quotes does not count", '"a;b;c";d\n1;2\n', "semicolon"],
    ["no delimiter at all", "a\n1\n", "comma"],
    ["a tie goes to comma", "a,b;c\n1,2;3\n", "comma"],
  ] as const)("detects the delimiter: %s", (_label, text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });

  it("uses the delimiter given, even against the detection", async () => {
    const parsed = await parseImportFile(csv("a,b;c\n1,2;3\n"), { sheet: null, delimiter: "semicolon" });
    expect(parsed.csvDelimiter).toBe("semicolon");
    expect(parsed.grid.columns.map((c) => c.header)).toEqual(["a,b", "c"]);
  });

  it("keeps cell text untrimmed and a whitespace-only cell as text; an empty field is null", async () => {
    const parsed = await parseImportFile(csv("a,b,c,d\n x ,\u{a0},,z\n"), NONE);
    expect(parsed.grid.rows[0]?.cells).toEqual([" x ", "\u{a0}", null, "z"]);
  });

  it("does not widen the file for whitespace-only cells at the end of a row", async () => {
    const parsed = await parseImportFile(csv("a,b\nx,y, ,\u{a0}\n"), NONE);
    expect(parsed.grid.columns).toHaveLength(2);
  });

  it("skips a fully blank row, leaving a gap in the row numbers, and never one with a value", async () => {
    const parsed = await parseImportFile(csv("a,b\nx,1\n\n , \n,\ny,2\n"), NONE);
    // Row 3 is empty, row 4 holds two whitespace cells, row 5 two empty fields: all blank, none counted.
    expect(parsed.grid.rows.map((r) => r.rowNumber)).toEqual([2, 6]);
  });

  it("keeps a column that has data but no header, with an empty header", async () => {
    const parsed = await parseImportFile(csv("a\nx,extra\n"), NONE);
    expect(parsed.grid.columns).toEqual([
      { columnNumber: 1, header: "a", samples: ["x"] },
      { columnNumber: 2, header: "", samples: ["extra"] },
    ]);
  });

  it("pads ragged rows and ignores a trailing empty column", async () => {
    const parsed = await parseImportFile(csv("a,b,c,\nx\ny,1,2,\n"), NONE);
    expect(parsed.grid.columns).toHaveLength(3);
    expect(parsed.grid.rows.map((r) => r.cells)).toEqual([["x", null, null], ["y", "1", "2"]]);
  });

  it("trims a header for display and keeps its inner text", async () => {
    const parsed = await parseImportFile(csv("\u{200f} \u{633}\u{639}\u{631} \u{a0},b\nx,y\n"), NONE);
    expect(parsed.grid.columns[0]?.header).toBe("\u{633}\u{639}\u{631}");
  });
});

describe("CSV refusals", () => {
  it("refuses bytes that are not UTF-8", async () => {
    expect(await refusal(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x2c, 0x31, 0x0a]))).toBe("encoding_not_utf8");
    expect(await refusal(Buffer.from([0xc3, 0x28]))).toBe("encoding_not_utf8");
  });

  it("refuses a NUL byte, and UTF-16 text (full of them)", async () => {
    expect(await refusal(Buffer.from("a,b\n1\u00002\n", "utf8"))).toBe("encoding_not_utf8");
    expect(await refusal(Buffer.from("\u{FEFF}a,b\n1,2\n", "utf16le"))).toBe("encoding_not_utf8");
  });

  it("refuses a quoting error", async () => {
    expect(await refusal(csv('a,b\n"x,1\n'))).toBe("file_unreadable");
    expect(await refusal(csv('a,b\nx"y,1\n'))).toBe("file_unreadable");
  });

  it("refuses an empty first line (no header), an empty file and a header with no rows", async () => {
    expect(await refusal(csv("\na,b\n1,2\n"))).toBe("header_missing");
    expect(await refusal(csv(""))).toBe("header_missing");
    expect(await refusal(csv("a,b\n"))).toBe("no_data_rows");
    expect(await refusal(csv("a,b\n\n,\n"))).toBe("no_data_rows");
  });

  it("refuses a `sheet` given with a CSV (400)", async () => {
    expect(await refusal(csv("a\n1\n"), { sheet: "Products", delimiter: null })).toBe("validation_error");
  });
});

describe("CSV limits", () => {
  const rows = (n: number): string => `sku\n${Array.from({ length: n }, (_v, i) => `S${i}`).join("\n")}\n`;
  const wide = (n: number): string => `${Array.from({ length: n }, (_v, i) => `h${i}`).join(",")}\n${Array.from({ length: n }, () => "1").join(",")}\n`;

  it("accepts 5,000 data rows and refuses 5,001", async () => {
    expect(await refusal(csv(rows(5000)))).toBe("accepted");
    expect(await refusal(csv(rows(5001)))).toBe("too_many_rows");
  });

  it("accepts 50 columns and refuses 51", async () => {
    expect(await refusal(csv(wide(50)))).toBe("accepted");
    expect(await refusal(csv(wide(51)))).toBe("too_many_columns");
  });

  it("ignores empty cells past column 50", async () => {
    expect(await refusal(csv(`${wide(50).trimEnd()}${",".repeat(5000)}\n`))).toBe("accepted");
  });

  it("accepts a 2,000-character cell (code points) and refuses 2,001", async () => {
    expect(await refusal(csv(`a\n${"x".repeat(2000)}\n`))).toBe("accepted");
    expect(await refusal(csv(`a\n${"\u{1F600}".repeat(2000)}\n`))).toBe("accepted");
    expect(await refusal(csv(`a\n${"x".repeat(2001)}\n`))).toBe("cell_too_long");
    expect(await refusal(csv(`${"h".repeat(2001)}\n1\n`))).toBe("cell_too_long");
  });

  it("refuses a record far past any legal size", async () => {
    expect(await refusal(csv(`a\n${"x".repeat(1_200_000)}\n`))).toBe("cell_too_long");
  });

  it("refuses more than 1,048,576 physical rows even when nearly all are blank (RT-1503 comment 17873)", async () => {
    // The header, then 1,048,576 blank lines: the 1,048,577th record is past the 0124 row_number bound.
    expect(await refusal(csv(`a\n${"\n".repeat(1_048_576)}`))).toBe("file_too_many_rows");
  });

  it("accepts exactly 1,048,576 physical rows, the last holding the one data row", async () => {
    const parsed = await parseImportFile(csv(`a\n${"\n".repeat(1_048_574)}x\n`), NONE);
    expect(parsed.grid.rows).toEqual([{ rowNumber: 1_048_576, cells: ["x"] }]);
  });
});

describe("type detection from content", () => {
  it("ignores everything but the bytes: a CSV is a CSV whatever it is called", async () => {
    const parsed = await parseImportFile(csv("PK is not at the start\n1\n"), NONE);
    expect(parsed.kind).toBe("csv");
  });

  it("refuses OLE2 (.xls and encrypted workbooks)", async () => {
    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    expect(await refusal(ole2)).toBe("file_type_unsupported");
  });

  it("refuses a ZIP that is not a workbook, an empty archive and a spanned one", async () => {
    expect(await refusal(buildZip([{ name: "readme.txt", data: "hello" }]))).toBe("file_type_unsupported");
    expect(await refusal(Buffer.concat([Buffer.from("PK\u0005\u0006"), Buffer.alloc(18)]))).toBe("file_type_unsupported");
    expect(await refusal(Buffer.from("PK\u0007\u0008 spanned"))).toBe("file_unreadable");
  });

  it("refuses a `delimiter` given with an XLSX (400)", async () => {
    const xlsx = buildXlsx([{ name: "Products", rows: [["a"], ["1"]] }]);
    expect(await refusal(xlsx, { sheet: null, delimiter: "comma" })).toBe("validation_error");
  });
});

const rowsOf = (...rows: XlsxCell[][]): { name: string; rows: XlsxCell[][] } => ({ name: "Products", rows });
const cellsOf = async (bytes: Buffer, options: ImportParseOptions = NONE): Promise<StagedCell[][]> => (await parseImportFile(bytes, options)).grid.rows.map((r) => r.cells);

describe("XLSX", () => {
  it("reads the first sheet by default and names it", async () => {
    const parsed = await parseImportFile(buildXlsx([rowsOf(["sku", "name"], ["A1", "Tea"])]), NONE);
    expect(parsed).toMatchObject({ kind: "xlsx", sheetName: "Products", csvDelimiter: null, parserVersion: XLSX_PARSER_VERSION });
    expect(parsed.grid.columns.map((c) => c.header)).toEqual(["sku", "name"]);
    expect(parsed.grid.rows).toEqual([{ rowNumber: 2, cells: ["A1", "Tea"] }]);
  });

  it("reads the sheet named, and refuses a name the workbook does not have", async () => {
    const book = buildXlsx([rowsOf(["a"], ["first"]), { name: "Second", rows: [["a"], ["second"]] }]);
    expect(await cellsOf(book, { sheet: "Second", delimiter: null })).toEqual([["second"]]);
    expect(await cellsOf(book)).toEqual([["first"]]);
    expect(await refusal(book, { sheet: "second", delimiter: null })).toBe("sheet_not_found");
    expect(await refusal(book, { sheet: "Nope", delimiter: null })).toBe("sheet_not_found");
  });

  it("keeps a text cell byte for byte (leading zeros) and tags a number cell as a number", async () => {
    const book = buildXlsx([rowsOf(["barcode", "plu"], ["0012345678905", { num: "12345678905" }], [{ num: "6.22E+12" }, "x"])]);
    expect(await cellsOf(book)).toEqual([
      ["0012345678905", { t: "n", v: "12345678905" }],
      [{ t: "n", v: "6.22E+12" }, "x"],
    ]);
  });

  it("tags booleans, and keeps untrimmed text with NBSP and bidi marks", async () => {
    const book = buildXlsx([rowsOf(["a", "b"], [{ bool: true }, " \u{a0}x\u{200f} "])]);
    expect(await cellsOf(book)).toEqual([[{ t: "b", v: "true" }, " \u{a0}x\u{200f} "]]);
  });

  it("marks formula cells with their cached value, or none (F1)", async () => {
    const book = buildXlsx([
      rowsOf(
        ["sku", "name", "qty"],
        [{ formula: "1+1", cached: "00123" }, { formula: "A1" }, { formula: "1+2", cached: { num: "3" } }],
        ["plain", "text", { num: "5" }],
      ),
    ]);
    expect(await cellsOf(book)).toEqual([
      [{ t: "f", v: "00123" }, { t: "f", v: null }, { t: "f", v: { t: "n", v: "3" } }],
      ["plain", "text", { t: "n", v: "5" }],
    ]);
  });

  it("numbers rows by the source sheet: blank rows leave gaps, rows above the header are blank", async () => {
    const book = buildXlsx([{ name: "Products", rows: [["a", "b"], ["1", "2"], null, [null, null], ["3", "4"]] }]);
    const parsed = await parseImportFile(book, NONE);
    expect(parsed.grid.rows.map((r) => r.rowNumber)).toEqual([2, 5]);
  });

  it("refuses a sheet whose first row is empty (a header must be row 1)", async () => {
    expect(await refusal(buildXlsx([{ name: "Products", rows: [null, ["a"], ["1"]] }]))).toBe("header_missing");
  });

  it("refuses a header with no data rows", async () => {
    expect(await refusal(buildXlsx([rowsOf(["a", "b"])]))).toBe("no_data_rows");
  });

  it("keeps a data column that has no header and drops trailing empty columns", async () => {
    const parsed = await parseImportFile(buildXlsx([rowsOf(["a", null, null], ["1", null, "extra"])]), NONE);
    expect(parsed.grid.columns.map((c) => c.header)).toEqual(["a", "", ""]);
  });

  it("accepts 5,000 data rows and 50 columns; refuses 5,001 rows and 51 columns", async () => {
    const many = (n: number): XlsxCell[][] => [["sku"], ...Array.from({ length: n }, (_v, i): XlsxCell[] => [`S${i}`])];
    expect(await refusal(buildXlsx([rowsOf(...many(5000))]))).toBe("accepted");
    expect(await refusal(buildXlsx([rowsOf(...many(5001))]))).toBe("too_many_rows");
    const cols = (n: number): XlsxCell[][] => [Array.from({ length: n }, (_v, i) => `h${i}`), Array.from({ length: n }, () => "1")];
    expect(await refusal(buildXlsx([rowsOf(...cols(50))]))).toBe("accepted");
    expect(await refusal(buildXlsx([rowsOf(...cols(51))]))).toBe("too_many_columns");
  });

  it("refuses a sheet with one valued cell at XFD (the library would pad every row to 16,384 columns)", async () => {
    const xml = sheetXml([["a"]]).replace("</row>", '<c r="XFD1"><v>1</v></c></row>');
    expect(await refusal(buildXlsx([rowsOf(["a"])], { sheetXmlOverride: xml }))).toBe("too_many_columns");
  });

  it("refuses a sparse sheet whose valued extent is past what the library may build", async () => {
    const xml = sheetXml([["a"], ["1"]]).replace("</sheetData>", '<row r="600000"><c r="AD600000"><v>1</v></c></row></sheetData>');
    expect(await refusal(buildXlsx([rowsOf(["a"])], { sheetXmlOverride: xml }))).toBe("xlsx_limits_exceeded");
  });

  it("refuses more physical rows than the sheet maximum", async () => {
    const xml = sheetXml([["a"], ["1"]]).replace("</sheetData>", '<row r="1048577"><c r="A1048577"><v>1</v></c></row></sheetData>');
    expect(await refusal(buildXlsx([rowsOf(["a"])], { sheetXmlOverride: xml }))).toBe("file_too_many_rows");
  });

  it("refuses a cell over 2,000 characters", async () => {
    expect(await refusal(buildXlsx([rowsOf(["a"], ["x".repeat(2001)])]))).toBe("cell_too_long");
  });

  it("refuses a sheet whose name the batch cannot store (over 31 characters)", async () => {
    expect(await refusal(buildXlsx([{ name: "x".repeat(32), rows: [["a"], ["1"]] }]))).toBe("file_unreadable");
  });

  it("refuses a macro-enabled workbook type and a template type", async () => {
    const rows = [["a"], ["1"]];
    for (const type of ["application/vnd.ms-excel.sheet.macroEnabled.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml", "application/vnd.ms-excel.sheet.binary.macroEnabled.main"]) {
      expect(await refusal(buildXlsx([{ name: "Products", rows }], { workbookType: type }))).toBe("file_type_unsupported");
    }
    expect(XLSX_MAIN_TYPE).toContain("sheet.main+xml");
  });

  it("refuses any vbaProject.bin entry even in an otherwise plain workbook", async () => {
    const book = buildXlsx([rowsOf(["a"], ["1"])], { extraEntries: [{ name: "xl/vbaProject.bin", data: "macro" }] });
    expect(await refusal(book)).toBe("file_type_unsupported");
  });

  it("refuses a workbook with no content types part", async () => {
    const without = xlsxEntries([["a"], ["1"]]).filter((e) => e.name !== "[Content_Types].xml");
    expect(await refusal(buildZip(without))).toBe("file_type_unsupported");
  });

  it("refuses a workbook whose sheet part is missing", async () => {
    const without = xlsxEntries([["a"], ["1"]]).filter((e) => e.name !== "xl/worksheets/sheet1.xml");
    expect(await refusal(buildZip(without))).toBe("file_unreadable");
  });

  it("stages text for a stagedCellText of every kind", () => {
    expect(stagedCellText(null)).toBeNull();
    expect(stagedCellText("x")).toBe("x");
    expect(stagedCellText({ t: "n", v: "1" })).toBe("1");
    expect(stagedCellText({ t: "f", v: null })).toBeNull();
    expect(stagedCellText({ t: "f", v: "y" })).toBe("y");
    expect(stagedCellText({ t: "f", v: { t: "b", v: "true" } })).toBe("true");
  });
});
