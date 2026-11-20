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

describe("scanSheet reads a cell address like the library's SAX parser (security review of PR #761, B3)", () => {
  it("takes r from the cell's own attribute, never from text inside another attribute's value", () => {
    const scan = scanSheet(sheet(`<row r="2"><c q='r="Z9"' r="A2"><f>1</f><v>1</v></c><c q="r='B9'" r="C2"><f>2</f></c></row>`));
    expect([...scan.formulaCells].sort()).toEqual(["2:1", "2:3"]);
    expect(scan).toMatchObject({ maxValuedRow: 2, maxValuedColumn: 3 });
    expect(scanSheet(sheet(`<row r="3000"><c q='r="A1"' r="XFD3000"><v>1</v></c></row>`)).maxValuedColumn).toBe(16384);
  });

  it("decodes entities in r, and does not mistake an xmlns declaration for an attribute", () => {
    const scan = scanSheet(sheet(`<row r="3"><c r="&#65;3"><f>1</f></c><c xmlns:r="urn:x" r="D3"><f>1</f></c></row>`));
    expect([...scan.formulaCells].sort()).toEqual(["3:1", "3:4"]);
  });

  it("refuses an address that is not A1 syntax, or an entity that decodes to nothing", () => {
    for (const ref of ['r="A1B"', 'r="1"', 'r="&#0;1"', 'r=""']) {
      expect(code(() => scanSheet(sheet(`<row r="1"><c ${ref}><v>1</v></c></row>`)))).toBe("file_unreadable");
    }
  });

  it("refuses more valued rows than the header plus 5,000 data rows, before any library runs", () => {
    const cell = (r: number): string => `<row r="${r}"><c r="A${r}"><v>1</v></c></row>`;
    const rows = (n: number): string => Array.from({ length: n }, (_v, i) => cell(i + 1)).join("");
    expect(code(() => scanSheet(sheet(rows(5001))))).toBe("none");
    expect(code(() => scanSheet(sheet(rows(5002))))).toBe("too_many_rows");
    // Empty (styled) cells are not valued rows.
    expect(code(() => scanSheet(sheet(Array.from({ length: 8000 }, (_v, i) => `<row r="${i + 1}"><c r="A${i + 1}" s="1"/></row>`).join(""))))).toBe("none");
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

describe("scanSheet fails closed where two XML readers could disagree (security review of PR #761, round 2: N1, N2, N3)", () => {
  const refused = (cells: string): string => code(() => scanSheet(sheet(`<row r="2000">${cells}</row>`)));

  it("N1: refuses a repeated attribute (a SAX parser keeps the first value, this tokenizer would keep the last)", () => {
    expect(refused(`<c r="XFD2000" r="A1"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" r="XFD2000"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" x:r="XFD2000"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c t="s" t="n" r="A1"><v>1</v></c>`)).toBe("file_unreadable");
  });

  it("N2: refuses attributes with no whitespace between them, a bare attribute, an unquoted value", () => {
    expect(refused(`<c r="XFD2000" q="1"r="A1"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" q><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r=A1><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" q="a<b"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r = "A1" ><v>1</v></c>`)).toBe("none");
  });

  it("N3: refuses a <! declaration (its quoting hides a tag from one reader and not the other), for the extent and for F1", () => {
    expect(refused(`<c r="XFD2000"><!x '><c r="A1">'><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A2" t="str"><!x '><c r="Z9">'><f>1+1</f><v>FROMFORMULA</v></c>`)).toBe("file_unreadable");
    expect(code(() => scanSheet(`<!DOCTYPE x [<!ENTITY a "b">]><worksheet><sheetData/></worksheet>`))).toBe("file_unreadable");
  });

  it("refuses entities that readers decode differently, and a bare ampersand", () => {
    for (const bad of ["&AMP;", "&#X41;", "&#00000065;", "&#1;", "&#xD800;", "&#0;", "&unknown;", "a & b", "&#65"]) {
      expect(refused(`<c r="A1" t="inlineStr"><is><t>${bad}</t></is></c>`)).toBe("file_unreadable");
    }
    expect(refused(`<c r="A1" t="inlineStr"><is><t>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&#128512;</t></is></c>`)).toBe("none");
  });

  it("refuses a comment or a processing instruction inside a value, and unexpected elements in a cell", () => {
    expect(refused(`<c r="A1"><v>1<!-- x -->2</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1"><v>1<b/>2</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1"><x/></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1"><v>1</v><v>2</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1"><c r="B1"/></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" t="bogus"><v>1</v></c>`)).toBe("file_unreadable");
    expect(refused(`<c r="A1" s="x"><v>1</v></c>`)).toBe("file_unreadable");
  });

  it("refuses an unbalanced document and a second sheetData", () => {
    expect(code(() => scanSheet(`<worksheet><sheetData><row r="1"><c r="A1"><v>1</v>`))).toBe("file_unreadable");
    expect(code(() => scanSheet(`<worksheet><sheetData><row r="1">`))).toBe("file_unreadable");
    expect(code(() => scanSheet(`<worksheet><sheetData></sheetData><sheetData></sheetData></worksheet>`))).toBe("file_unreadable");
  });
});

describe("scanSheet re-serializes the sheet: the library reads only what the scan understood", () => {
  it("keeps rows, cells, types, styles, values, inline strings and runs, drops everything else, and escapes text itself", () => {
    const scan = scanSheet(
      `<?xml version="1.0"?><worksheet xmlns="x" xmlns:r="y"><dimension ref="A1:XFD9"/><sheetViews><sheetView/></sheetViews>` +
        `<sheetData><row r="2" spans="1:2" ht="9"><c r="A2" s="3" t="n" cm="1"><v>1.5E3</v></c>` +
        `<c r="B2" t="str"><f t="shared" si="0">SUM(A1)</f><v>a &amp; b &lt;c&gt;</v></c>` +
        `<c r="C2" t="inlineStr"><is><r><rPr><b/></rPr><t>one </t></r><r><t><![CDATA[<two>]]></t></r><rPh><t>ignored</t></rPh></is></c><c r="D2"/><c r="E2" t="inlineStr"><is><t/></is></c></row>` +
        `<row r="3"/></sheetData><mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells></worksheet>`,
    );
    expect(scan.canonicalXml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
        `<row r="2"><c r="A2" t="n" s="3"><v>1.5E3</v></c>` +
        `<c r="B2" t="str"><v>a &amp; b &lt;c&gt;</v></c>` +
        `<c r="C2" t="inlineStr"><is><r><t>one </t></r><r><t>&lt;two&gt;</t></r></is></c><c r="D2"></c><c r="E2" t="inlineStr"><is><t></t></is></c></row>` +
        `<row r="3"></row></sheetData></worksheet>`,
    );
    expect([...scan.formulaCells]).toEqual(["2:2"]);
  });

  it("never lets anything outside a cell reach the canonical sheet", () => {
    const scan = scanSheet(sheet(`<row r="1"><c r="A1"><v>1</v></c></row><!-- <c r="XFD9"><v>9</v></c> --><extLst><ext><c2 r="XFD9"/></ext></extLst>`));
    expect(scan.canonicalXml).not.toContain("XFD");
    expect(scan.maxValuedColumn).toBe(1);
  });

  it("is idempotent: scanning the canonical sheet gives the same sheet", () => {
    const first = scanSheet(sheet(`<row r="1"><c r="A1" t="str"><f>1</f><v>x &amp; y</v></c><c r="C1" t="inlineStr"><is><t>z</t></is></c></row>`));
    expect(scanSheet(first.canonicalXml).canonicalXml).toBe(first.canonicalXml);
  });
});

describe("scanSheet and the tokenizer are linear on hostile input (security review of PR #761, blocker 2)", () => {
  const timed = (fn: () => unknown): number => {
    const started = process.hrtime.bigint();
    try {
      fn();
    } catch {
      // A refusal is the expected outcome; only the time matters here.
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  it("refuses a 1,000,000-character attribute name run in well under a second (an attribute regex took 9 s at 80,000)", () => {
    const run = "a".repeat(1_000_000);
    expect(code(() => scanSheet(sheet(`<row r="1"><c ${run} r="A1"><v>1</v></c></row>`)))).toBe("file_unreadable");
    expect(timed(() => scanSheet(sheet(`<row r="1"><c ${run} r="A1"><v>1</v></c></row>`)))).toBeLessThan(1000);
  });

  it("refuses a start tag over 8 KiB, whatever it is made of, quickly", () => {
    for (const filler of [`q="${"x".repeat(9000)}"`, "a ".repeat(5000), "a=\"b\" ".repeat(2000), `q='${"\"".repeat(9000)}'`]) {
      const xml = sheet(`<row r="1"><c r="A1" ${filler}><v>1</v></c></row>`);
      expect(code(() => scanSheet(xml))).toBe("file_unreadable");
      expect(timed(() => scanSheet(xml))).toBeLessThan(1000);
    }
    // A tag just under the cap is fine.
    expect(code(() => scanSheet(sheet(`<row r="1"><c r="A1" q="${"x".repeat(8000)}"><v>1</v></c></row>`)))).toBe("none");
  });

  it("refuses a 1,000,000-character run of attributes and of unterminated quotes quickly", () => {
    const many = " a=\"1\"".repeat(150_000);
    const quotes = `<c r="A1" q="${"'".repeat(1_000_000)}`;
    for (const xml of [sheet(`<row r="1"><c r="A1"${many}><v>1</v></c></row>`), sheet(`<row r="1">${quotes}`)]) {
      expect(code(() => scanSheet(xml))).toBe("file_unreadable");
      expect(timed(() => scanSheet(xml))).toBeLessThan(1000);
    }
  });

  it("scans 5,001 normal rows of 50 cells (a sanity bound, not a benchmark: CI runs under coverage)", () => {
    const row = (r: number): string => `<row r="${r}">${Array.from({ length: 50 }, (_v, c) => `<c r="${c < 26 ? String.fromCharCode(65 + c) : `A${String.fromCharCode(65 + c - 26)}`}${r}" t="inlineStr"><is><t>v${r}</t></is></c>`).join("")}</row>`;
    const xml = sheet(Array.from({ length: 5001 }, (_v, i) => row(i + 1)).join(""));
    expect(timed(() => scanSheet(xml))).toBeLessThan(30000);
  });
});

describe("scanSheet caps the attributes of a tag and the staged text (security review of PR #761, round 3)", () => {
  const cellWith = (n: number): string => `<row r="1"><c r="A1" ${Array.from({ length: n }, (_v, i) => `a${i}="1"`).join(" ")}><v>1</v></c></row>`;

  it("accepts a tag with up to 64 attributes and refuses more (a duplicate check per attribute was quadratic: 17 s on 40 MiB)", () => {
    expect(code(() => scanSheet(sheet(cellWith(63))))).toBe("none");
    expect(code(() => scanSheet(sheet(cellWith(64))))).toBe("file_unreadable");
    const hostile = sheet(Array.from({ length: 5226 }, (_v, i) => `<row r="${i + 1}"><c r="A${i + 1}" ${Array.from({ length: 1150 }, (_w, j) => `a${j}="1"`).join(" ")}><v>1</v></c></row>`).join(""));
    const started = process.hrtime.bigint();
    expect(code(() => scanSheet(hostile))).toBe("file_unreadable");
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000);
  });

  it("counts what a shared-string cell adds to the batch and refuses past 8,000,000 characters before any library runs", () => {
    const cells = (n: number): string => `<row r="1">${Array.from({ length: n }, (_v, i) => `<c r="${i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`}1" t="s"><v>0</v></c>`).join("")}</row>`;
    const rows = (count: number): string => Array.from({ length: count }, (_v, r) => cells(50).replace(/1"/g, `${r + 1}"`)).join("");
    expect(code(() => scanSheet(sheet(rows(40)), [2000]))).toBe("none");
    const started = process.hrtime.bigint();
    expect(code(() => scanSheet(sheet(rows(100)), [2000]))).toBe("xlsx_limits_exceeded");
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(1000);
    // A string that is short, however often it is used, is fine.
    expect(code(() => scanSheet(sheet(rows(100)), [10]))).toBe("none");
  });
});
