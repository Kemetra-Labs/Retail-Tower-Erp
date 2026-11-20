/**
 * RT-1505 (RT-1504 finding F1): the sheet-XML pre-scan names formula cells and
 * the extent of the valued cells.
 */
import { ImportFileRejectedError } from "../../../src/catalog/catalog-import/import-file-rejected";
import { scanSheet } from "../../../src/catalog/catalog-import/xlsx-sheet-scan";

const sheet = (body: string): string =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code;
    throw err;
  }
  return "none";
}

describe("scanSheet formulas", () => {
  it("names a formula with and without a cached value, a shared formula and an array formula", () => {
    const scan = scanSheet(
      sheet(
        `<row r="2"><c r="A2" t="str"><f>1+1</f><v>00123</v></c><c r="B2"><f>2+2</f></c></row>` +
          `<row r="3"><c r="A3"><f t="shared" si="0"/><v>4</v></c><c r="C3"><f t="array" ref="C3:C4">SUM(A1)</f><v>1</v></c></row>`,
      ),
    );
    expect([...scan.formulaCells].sort()).toEqual(["2:1", "2:2", "3:1", "3:3"]);
  });

  it("does not count text that only looks like a formula (escaped, CDATA, comment)", () => {
    const scan = scanSheet(
      sheet(
        `<row r="1"><c r="A1" t="inlineStr"><is><t>&lt;f&gt;1&lt;/f&gt;</t></is></c>` +
          `<c r="B1" t="inlineStr"><is><t><![CDATA[<f>1</f>]]></t></is></c>` +
          `<c r="C1" t="inlineStr"><is><t>x</t></is></c><!-- <c r="D1"><f>1</f></c> --></row>`,
      ),
    );
    expect(scan.formulaCells.size).toBe(0);
  });

  it("ignores an <f> outside a cell and a namespace prefix", () => {
    const scan = scanSheet(
      `<worksheet><conditionalFormatting><x14:f>1</x14:f></conditionalFormatting><sheetData><row r="1"><c r="A1"><x:f>1</x:f><v>1</v></c></row></sheetData></worksheet>`,
    );
    expect([...scan.formulaCells]).toEqual(["1:1"]);
  });

  it("reads a tag whose attribute value holds a > character", () => {
    const scan = scanSheet(sheet(`<row r="1" note="a>b"><c r="A1" s="1" x="y>z"><f>1</f></c></row>`));
    expect([...scan.formulaCells]).toEqual(["1:1"]);
  });

  it("handles single-quoted attributes and a self-closing cell", () => {
    const scan = scanSheet(sheet(`<row r='4'><c r='B4' s='1'/><c r='C4'><f>1</f></c></row>`));
    expect([...scan.formulaCells]).toEqual(["4:3"]);
    expect(scan.maxValuedColumn).toBe(3);
  });
});

describe("scanSheet extent", () => {
  it("measures valued cells only: a styled empty cell at XFD1 does not widen the sheet", () => {
    const scan = scanSheet(sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="XFD1" s="1"/></row>`));
    expect(scan).toMatchObject({ maxValuedRow: 1, maxValuedColumn: 1 });
  });

  it("measures a valued cell at XFD (column 16384)", () => {
    const scan = scanSheet(sheet(`<row r="1"><c r="XFD1"><v>1</v></c></row>`));
    expect(scan.maxValuedColumn).toBe(16384);
  });

  it("is empty for a sheet with no valued cell", () => {
    expect(scanSheet(sheet(""))).toMatchObject({ maxValuedRow: 0, maxValuedColumn: 0 });
  });
});

describe("scanSheet refusals", () => {
  it("refuses a row past the sheet maximum", () => {
    expect(code(() => scanSheet(sheet(`<row r="1048577"><c r="A1048577"><v>1</v></c></row>`)))).toBe("file_too_many_rows");
  });

  it("refuses more physical rows than the sheet maximum", () => {
    const rows = "<row/>".repeat(1_048_577);
    expect(code(() => scanSheet(sheet(rows)))).toBe("file_too_many_rows");
  });

  it("accepts exactly the sheet maximum of rows", () => {
    expect(code(() => scanSheet(sheet("<row/>".repeat(1_048_576))))).toBe("none");
  });

  it("refuses a cell with no address (the library cannot place it)", () => {
    expect(code(() => scanSheet(sheet(`<row r="1"><c><v>1</v></c></row>`)))).toBe("file_unreadable");
  });

  it("refuses markup that never ends", () => {
    expect(code(() => scanSheet(`<worksheet><!-- never closed`))).toBe("file_unreadable");
    expect(code(() => scanSheet(`<worksheet><row r="1"`))).toBe("file_unreadable");
  });
});
