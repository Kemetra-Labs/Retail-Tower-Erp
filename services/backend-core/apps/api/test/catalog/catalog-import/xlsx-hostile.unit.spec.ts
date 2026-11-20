/**
 * RT-1505, security review of PR #761 (B1, B2, B3): regression fixtures for the
 * ways an upload could make `read-excel-file` parse something other than what
 * the guards checked. Every fixture is built at run time. The root cause was
 * that the library re-parses the ORIGINAL bytes with rules of its own (local
 * headers, the FIXED paths `xl/workbook.xml` and `xl/_rels/workbook.xml.rels`,
 * a SAX parser); the import now hands it only an archive rebuilt from the
 * parts the guard verified, at the library's own paths.
 */
import { ImportFileRejectedError, type ImportFileRefusalCode } from "../../../src/catalog/catalog-import/import-file-rejected";
import { parseImportFile, type ParsedImportFile } from "../../../src/catalog/catalog-import/import-file-parser";
import type { StagedCell } from "../../../src/catalog/catalog-import/staged-cell";
import { buildZip, localEntryBytes, sheetXml, type XlsxCell, type ZipEntrySpec } from "./__support__/zip-fixtures";

const MIB = 1024 * 1024;
const NONE = { sheet: null, delimiter: null } as const;
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

const rows = (word: string): XlsxCell[][] => [["sku", "name"], [word, "x"]];

interface BookParts {
  readonly workbook: string;
  readonly rels: string;
  /** Part path to its XML (the sheets, the shared strings, the styles). */
  readonly parts: Readonly<Record<string, string>>;
  readonly types?: string;
  readonly extra?: readonly ZipEntrySpec[];
}

function typesXml(workbookPart = "/xl/workbook.xml"): string {
  return `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${workbookPart}" ContentType="${MAIN_TYPE}"/></Types>`;
}

const wbXml = (sheets: string, pr = ""): string =>
  `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}">${pr}<sheets>${sheets}</sheets></workbook>`;
const relsXml = (rels: string): string => `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">${rels}</Relationships>`;
const rel = (id: string, kind: string, target: string): string => `<Relationship Id="${id}" Type="${OFFICE_REL}/${kind}" Target="${target}"/>`;

function book(parts: BookParts): Buffer {
  const entries: ZipEntrySpec[] = [
    { name: "[Content_Types].xml", data: parts.types ?? typesXml() },
    { name: "xl/workbook.xml", data: parts.workbook },
    { name: "xl/_rels/workbook.xml.rels", data: parts.rels },
    ...Object.entries(parts.parts).map(([name, data]) => ({ name, data })),
    ...(parts.extra ?? []),
  ];
  return buildZip(entries);
}

async function outcome(bytes: Buffer, options: { sheet: string | null; delimiter: null } = NONE): Promise<ImportFileRefusalCode | ParsedImportFile> {
  try {
    return await parseImportFile(bytes, options);
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code;
    throw err;
  }
}

const cellsOf = (parsed: ImportFileRefusalCode | ParsedImportFile): StagedCell[][] => {
  if (typeof parsed === "string") throw new Error(`refused: ${parsed}`);
  return parsed.grid.rows.map((r) => r.cells);
};

/** Two sheets: `a` first holding "WRONG", `b` second holding "RIGHT". */
const TWO_SHEETS_PARTS = {
  "xl/worksheets/sheet1.xml": sheetXml(rows("WRONG")),
  "xl/worksheets/sheet2.xml": sheetXml(rows("RIGHT")),
};
const TWO_RELS = relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "worksheet", "worksheets/sheet2.xml"));

describe("B1: a hidden bomb behind data-descriptor local sizes", () => {
  it("is refused with the archive's honest central record: the library never sees the upload", async () => {
    const goodBook = book({
      workbook: wbXml('<sheet name="Products" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")) },
    });
    expect(cellsOf(await outcome(goodBook))).toEqual([["A", "x"]]);
    const hidden = localEntryBytes({ name: "xl/hidden.xml", data: Buffer.alloc(80 * MIB, 0x20) });
    const app = "<Properties/>";
    const bName = "docProps/thumbnail.jpeg";
    const stretch = app.length + 16 + 30 + bName.length;
    const hostile = book({
      workbook: wbXml('<sheet name="Products" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")) },
      extra: [
        { name: "docProps/app.xml", data: app, method: 0, descriptor: "signed", local: { compressedSize: stretch, uncompressedSize: stretch } },
        { name: bName, data: hidden, method: 0 },
      ],
    });
    expect(hostile.length).toBeLessThan(1 * MIB);
    const started = Date.now();
    expect(await outcome(hostile)).toBe("file_unreadable");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("B2: the import and the library must read the same workbook", () => {
  it("refuses a package whose content types declare another part the workbook (the library always reads xl/workbook.xml)", async () => {
    const altWorkbook = wbXml('<sheet name="Alt" sheetId="1" r:id="rId1"/>');
    const hostile = book({
      types: typesXml("/alt/book.xml"),
      workbook: wbXml('<sheet name="Products" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")) },
      extra: [{ name: "alt/book.xml", data: altWorkbook }],
    });
    expect(await outcome(hostile)).toBe("file_type_unsupported");
  });

  it("does not count a commented-out sheet: it is neither the first sheet nor findable by name", async () => {
    const hostile = book({
      workbook: wbXml('<!-- <sheet name="X" sheetId="9" r:id="rId9"/> --><sheet name="Real" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId9", "worksheet", "worksheets/sheet9.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("RIGHT")), "xl/worksheets/sheet9.xml": sheetXml(rows("WRONG")) },
    });
    const parsed = await outcome(hostile);
    expect(cellsOf(parsed)).toEqual([["RIGHT", "x"]]);
    expect((parsed as ParsedImportFile).sheetName).toBe("Real");
    expect(await outcome(hostile, { sheet: "X", delimiter: null })).toBe("sheet_not_found");
  });

  it("skips a sheet with no name, as the library does, so the first sheet is the first NAMED one", async () => {
    const hostile = book({
      workbook: wbXml('<sheet name="" sheetId="1" r:id="rId1"/><sheet name="Real" sheetId="2" r:id="rId2"/>'),
      rels: TWO_RELS,
      parts: TWO_SHEETS_PARTS,
    });
    const parsed = await outcome(hostile);
    expect(cellsOf(parsed)).toEqual([["RIGHT", "x"]]);
    expect((parsed as ParsedImportFile).sheetName).toBe("Real");
    expect(cellsOf(await outcome(hostile, { sheet: "Real", delimiter: null }))).toEqual([["RIGHT", "x"]]);
  });

  it("only follows a worksheet relationship: any other type leaves the sheet with no part", async () => {
    const hostile = book({
      workbook: wbXml('<sheet name="Real" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "chartsheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")) },
    });
    expect(await outcome(hostile)).toBe("file_unreadable");
  });

  it("takes the LAST attribute whose local name is id (r:id, ns:id or a plain id), as the library does", async () => {
    const lastWins = book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1" id="rId2"/>'),
      rels: TWO_RELS,
      parts: TWO_SHEETS_PARTS,
    });
    expect(cellsOf(await outcome(lastWins))).toEqual([["RIGHT", "x"]]);
    const reversed = book({
      workbook: wbXml('<sheet name="S" sheetId="1" id="rId2" r:id="rId1"/>'),
      rels: TWO_RELS,
      parts: TWO_SHEETS_PARTS,
    });
    expect(cellsOf(await outcome(reversed))).toEqual([["WRONG", "x"]]);
  });

  it("lets the last relationship of an id win and resolves targets like the library (absolute and relative)", async () => {
    const hostile = book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId1", "worksheet", "/xl/worksheets/sheet2.xml")),
      parts: TWO_SHEETS_PARTS,
    });
    expect(cellsOf(await outcome(hostile))).toEqual([["RIGHT", "x"]]);
  });

  it("decodes _xHHHH_ escapes in a sheet name before it is matched and stored", async () => {
    const book1 = book({
      workbook: wbXml('<sheet name="_x0041_Products" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")) },
    });
    const parsed = await outcome(book1, { sheet: "AProducts", delimiter: null });
    expect((parsed as ParsedImportFile).sheetName).toBe("AProducts");
    expect(await outcome(book1, { sheet: "_x0041_Products", delimiter: null })).toBe("sheet_not_found");
  });

  it("keeps the real shared strings, styles and the 1904 date system through the rebuild", async () => {
    const strings = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>sku</t></si><si><t>0012345678905</t></si></sst>';
    const styles =
      '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const sheet =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>d</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>0</v></c></row></sheetData></worksheet>';
    const hostile = book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1"/>', '<workbookPr date1904="1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "sharedStrings", "/xl/sharedStrings.xml") + rel("rId3", "styles", "styles.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheet, "xl/sharedStrings.xml": strings, "xl/styles.xml": styles },
    });
    const parsed = await outcome(hostile);
    expect((parsed as ParsedImportFile).grid.columns.map((c) => c.header)).toEqual(["sku", "d"]);
    // Text from the shared strings (leading zeros kept); a date-formatted cell in the 1904 system: serial 0 is 1904-01-01.
    expect(cellsOf(parsed)).toEqual([["0012345678905", { t: "d", v: "1904-01-01T00:00:00.000Z" }]]);
  });

  it("never reads a second workbook or a sheet the upload hides under another path", async () => {
    const hostile = book({
      workbook: wbXml('<sheet name="Real" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("RIGHT")) },
      extra: [
        { name: "xl/worksheets/sheet2.xml", data: sheetXml(rows("WRONG")) },
        { name: "alt/xl/workbook.xml", data: wbXml('<sheet name="Real" sheetId="1" r:id="rId1"/>') },
      ],
    });
    expect(cellsOf(await outcome(hostile))).toEqual([["RIGHT", "x"]]);
  });
});

describe("B3: a cell address is the cell's own r attribute", () => {
  const sheetWith = (cells: string): string =>
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c></row>${cells}</sheetData></worksheet>`;
  const bookOf = (sheet: string): Buffer =>
    book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheet },
    });

  it("is not fooled by r=\"...\" inside another attribute's value: a valued cell at XFD3000 is too wide", async () => {
    const sheet = sheetWith(`<row r="3000"><c q='r="A1"' r="XFD3000"><v>1</v></c></row>`);
    expect(await outcome(bookOf(sheet))).toBe("too_many_columns");
  });

  it("is not fooled about the extent: a valued cell far down the sheet is past the memory bound", async () => {
    const sheet = sheetWith(`<row r="600000"><c q='r="Z9"' r="AD600000"><v>1</v></c></row>`);
    expect(await outcome(bookOf(sheet))).toBe("xlsx_limits_exceeded");
  });

  it("is not fooled about a formula: it belongs to the cell whose own r says so", async () => {
    const sheet = sheetWith(`<row r="2"><c q='r="Z9"' r="A2" t="str"><f>1+1</f><v>00123</v></c></row>`);
    expect(cellsOf(await outcome(bookOf(sheet)))).toEqual([[{ t: "f", v: "00123" }]]);
  });

  it("decodes entities in r like the library: r=\"&#65;3\" is A3", async () => {
    const sheet = sheetWith(`<row r="2"><c r="A2" t="str"><f>1</f><v>a</v></c></row><row r="3"><c r="&#65;3" t="inlineStr"><is><t>b</t></is></c></row>`);
    expect(cellsOf(await outcome(bookOf(sheet)))).toEqual([[{ t: "f", v: "a" }], ["b"]]);
  });

  it("refuses a cell address that is not a plain A1 reference", async () => {
    for (const bad of [`<c r="A1;B2"><v>1</v></c>`, `<c r="1A"><v>1</v></c>`, `<c><v>1</v></c>`, `<c r="&#xD800;1"><v>1</v></c>`]) {
      expect(await outcome(bookOf(sheetWith(`<row r="2">${bad}</row>`)))).toBe("file_unreadable");
    }
  });

  it("refuses more valued rows than a file may have, before the library runs (5,001 data rows)", async () => {
    const many = (n: number): string => Array.from({ length: n }, (_v, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>S${i}</t></is></c></row>`).join("");
    expect(await outcome(bookOf(sheetWith(many(5001))))).toBe("too_many_rows");
    expect(cellsOf(await outcome(bookOf(sheetWith(many(5000))))).length).toBe(5000);
  });
});

describe("round 2: a sheet two XML readers could read differently never reaches the library (N1, N2, N3, blocker 2)", () => {
  const sheetWith = (cells: string): string =>
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c></row>${cells}</sheetData></worksheet>`;
  const bookOf = (sheet: string, extra: Partial<BookParts> = {}): Buffer =>
    book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml")),
      parts: { "xl/worksheets/sheet1.xml": sheet },
      ...extra,
    });

  /** Refused as unreadable, and fast: the library (which would pad 2000 x 16384 cells, 800 ms and hundreds of MiB) never ran. */
  async function expectRefusedFast(sheet: string): Promise<void> {
    const bytes = bookOf(sheet);
    const started = Date.now();
    expect(await outcome(bytes)).toBe("file_unreadable");
    expect(Date.now() - started).toBeLessThan(1000);
  }

  it("N1: a repeated r (the library keeps the first, a last-wins reader the last)", async () => {
    await expectRefusedFast(sheetWith(`<row r="2000"><c r="XFD2000" r="A1"><v>1</v></c></row>`));
  });

  it("N2: attributes with no whitespace between them", async () => {
    await expectRefusedFast(sheetWith(`<row r="2000"><c r="XFD2000" q="1"r="A1"><v>1</v></c></row>`));
  });

  it("N3: a <! declaration, for the extent and for F1", async () => {
    await expectRefusedFast(sheetWith(`<row r="2000"><c r="XFD2000"><!x '><c r="A1">'><v>1</v></c></row>`));
    await expectRefusedFast(sheetWith(`<row r="2"><c r="A2" t="str"><!x '><c r="Z9">'><f>1+1</f><v>FROMFORMULA</v></c></row>`));
  });

  it("a long run of characters in an attribute name, in the sheet, the workbook, the relationships and the content types", async () => {
    const run = "a".repeat(1_000_000);
    await expectRefusedFast(sheetWith(`<row r="2"><c ${run} r="A2"><v>1</v></c></row>`));
    const timed = async (bytes: Buffer): Promise<number> => {
      const started = Date.now();
      expect(await outcome(bytes)).toMatch(/^file_/);
      return Date.now() - started;
    };
    const good = sheetXml(rows("A"));
    expect(await timed(bookOf(good, { workbook: wbXml(`<sheet name="S" ${run}="x" sheetId="1" r:id="rId1"/>`) }))).toBeLessThan(1000);
    expect(await timed(bookOf(good, { rels: relsXml(`<Relationship ${run}="x" Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>`) }))).toBeLessThan(1000);
    expect(await timed(bookOf(good, { types: `<Types><Override PartName="/xl/workbook.xml" ${run}="x" ContentType="${MAIN_TYPE}"/></Types>` }))).toBeLessThan(1000);
  });

  it("an over-long tag in a package part", async () => {
    const started = Date.now();
    const bytes = bookOf(sheetXml(rows("A")), { workbook: wbXml(`<sheet name="${"x".repeat(9000)}" sheetId="1" r:id="rId1"/>`) });
    expect(await outcome(bytes)).toBe("file_unreadable");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the library reads the canonical sheet: what it returns is exactly what the scan understood", async () => {
    const sheet = sheetWith(
      `<row r="2" spans="1:2"><c r="A2" t="str" cm="1"><f t="shared" si="0">1+1</f><v>00123 &amp; co</v></c><c r="B2" s="0" t="inlineStr"><is><r><t>a</t></r><r><t> b</t></r></is></c></row>` +
        `<row r="3"><c r="A3"><v>12345678905</v></c></row>`,
    );
    expect(cellsOf(await outcome(bookOf(sheet)))).toEqual([
      [{ t: "f", v: "00123 & co" }, "a b"],
      [{ t: "n", v: "12345678905" }, null],
    ]);
  });

  it("refuses a DOCTYPE or an entity declaration in the shared strings or the styles, which reach the library as they are", async () => {
    const withStrings = (xml: string): Buffer =>
      bookOf(sheetXml(rows("A")), {
        rels: relsXml(rel("rId1", "worksheet", "worksheets/sheet1.xml") + rel("rId2", "sharedStrings", "sharedStrings.xml")),
        parts: { "xl/worksheets/sheet1.xml": sheetXml(rows("A")), "xl/sharedStrings.xml": xml },
      });
    expect(await outcome(withStrings('<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY a "b">]><sst xmlns="x"><si><t>&a;</t></si></sst>'))).toBe("file_unreadable");
    expect(await outcome(withStrings('<?xml version="1.0"?><sst xmlns="x"><si><t>fine</t></si></sst>'))).not.toBe("file_unreadable");
  });
});

describe("round 3: no uploaded part reaches the library byte for byte", () => {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const stylesXml = (body: string): string => `<?xml version="1.0"?><styleSheet ${NS}>${body}</styleSheet>`;
  const sstXml = (body: string): string => `<?xml version="1.0"?><sst ${NS}>${body}</sst>`;

  /** A workbook with a sheet, shared strings and styles. */
  function bookWith(parts: { sheet: string; strings?: string; styles?: string }): Buffer {
    const rels =
      rel("rId1", "worksheet", "worksheets/sheet1.xml") +
      (parts.strings === undefined ? "" : rel("rId2", "sharedStrings", "sharedStrings.xml")) +
      (parts.styles === undefined ? "" : rel("rId3", "styles", "styles.xml"));
    return book({
      workbook: wbXml('<sheet name="S" sheetId="1" r:id="rId1"/>'),
      rels: relsXml(rels),
      parts: {
        "xl/worksheets/sheet1.xml": parts.sheet,
        ...(parts.strings === undefined ? {} : { "xl/sharedStrings.xml": parts.strings }),
        ...(parts.styles === undefined ? {} : { "xl/styles.xml": parts.styles }),
      },
    });
  }

  const simpleSheet = (style = ""): string =>
    `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c></row>` +
    `<row r="2"><c r="A2"${style}><v>45000</v></c></row></sheetData></worksheet>`;

  /** Refused within `limitMs` (1 s: CI runs the suite under coverage, and the quadratic cases this guards against take seconds to hours; a flood of tens of MiB also pays to inflate the upload, so those allow 4 s). */
  async function expectRefusedFast(bytes: Buffer, expected: ImportFileRefusalCode = "file_unreadable", limitMs = 1000): Promise<void> {
    const started = Date.now();
    expect(await outcome(bytes)).toBe(expected);
    expect(Date.now() - started).toBeLessThan(limitMs);
  }

  it("a format code of '[' characters (the library's date check is quadratic on it) is refused before the library runs", async () => {
    const styles = stylesXml(`<numFmts><numFmt numFmtId="164" formatCode="${"[".repeat(1_000_000)}"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs>`);
    await expectRefusedFast(bookWith({ sheet: simpleSheet(' s="0"'), styles }));
  });

  it("an <xf/> flood (9,000,000) and a <numFmt/> flood are refused before the library runs", async () => {
    await expectRefusedFast(bookWith({ sheet: simpleSheet(' s="0"'), styles: stylesXml(`<cellXfs>${"<xf/>".repeat(9_000_000)}</cellXfs>`) }), "file_unreadable", 4000);
    const fmts = Array.from({ length: 64_001 }, (_v, i) => `<numFmt numFmtId="${i + 164}" formatCode="0"/>`).join("");
    await expectRefusedFast(bookWith({ sheet: simpleSheet(), styles: stylesXml(`<numFmts>${fmts}</numFmts>`) }), "file_unreadable", 4000);
  });

  it("a shared-string flood (250,001 strings) is refused before the library runs", async () => {
    await expectRefusedFast(bookWith({ sheet: simpleSheet(), strings: sstXml("<si><t>a</t></si>".repeat(250_001)) }), "file_unreadable", 4000);
  });

  it("many attributes on a tag are refused: thousands of cells of 1,150 attributes (tens of MiB) do not take 17 s", async () => {
    const attrs = Array.from({ length: 1150 }, (_v, i) => `a${i}="1"`).join(" ");
    const cells = Array.from({ length: 3000 },(_v, i) => `<c r="A${i + 2}" ${attrs}><v>1</v></c>`).join("");
    await expectRefusedFast(bookWith({ sheet: `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2">${cells}</row></sheetData></worksheet>` }), "file_unreadable", 4000);
  });

  it("shared-string fan-out: one 2,000-character string used by every cell of 5,000 x 50 is over the staged-text cap, refused before the library runs", async () => {
    const arabic = "\u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}".repeat(286).slice(0, 2000);
    const col = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : `A${String.fromCharCode(65 + c - 26)}`);
    const header = Array.from({ length: 50 }, (_v, c) => `<c r="${col(c)}1" t="inlineStr"><is><t>h${c}</t></is></c>`).join("");
    const rowsXml = Array.from({ length: 5000 }, (_v, r) => `<row r="${r + 2}">${Array.from({ length: 50 }, (_w, c) => `<c r="${col(c)}${r + 2}" t="s"><v>0</v></c>`).join("")}</row>`).join("");
    const sheet = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1">${header}</row>${rowsXml}</sheetData></worksheet>`;
    const bytes = bookWith({ sheet, strings: sstXml(`<si><t>${arabic}</t></si>`) });
    expect(bytes.length).toBeLessThan(600 * 1024);
    await expectRefusedFast(bytes, "xlsx_limits_exceeded");
  });

  it("a normal file still imports: shared strings, a date style, an inline string, a formula with a cached value, a leading-zero text", async () => {
    const strings = sstXml('<si><t>sku</t></si><si><t>name</t></si><si><t>day</t></si><si><t>0012345678905</t></si><si><r><t>Tea </t></r><r><rPr><b/></rPr><t>Bag</t></r></si>');
    const styles = stylesXml(
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="1"><font/></fonts>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs>',
    );
    const sheet =
      `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1:D3"/><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>note</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" s="1"><v>45000</v></c><c r="D2" t="str"><f>UPPER("x")</f><v>X</v></c></row>' +
      '</sheetData><pageMargins left="1"/></worksheet>';
    const parsed = await outcome(bookWith({ sheet, strings, styles }));
    expect((parsed as ParsedImportFile).grid.columns.map((c) => c.header)).toEqual(["sku", "name", "day", "note"]);
    expect(cellsOf(parsed)).toEqual([["0012345678905", "Tea Bag", { t: "d", v: "2023-03-15T00:00:00.000Z" }, { t: "f", v: "X" }]]);
  });
});
