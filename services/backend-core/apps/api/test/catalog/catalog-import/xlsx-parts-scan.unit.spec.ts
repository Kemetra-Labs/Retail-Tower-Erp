/**
 * RT-1505, security review of PR #761 (round 3): the styles and the shared
 * strings are re-serialized like the sheet, so no uploaded part reaches the
 * library byte for byte. Hostile inputs are refused fast; normal ones keep
 * exactly what the library reads.
 */
import { ImportFileRejectedError } from "../../../src/catalog/catalog-import/import-file-rejected";
import { GridBuilder } from "../../../src/catalog/catalog-import/grid-builder";
import { canonicalSharedStrings, canonicalStyles } from "../../../src/catalog/catalog-import/xlsx-parts-scan";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const styles = (body: string): string => `<?xml version="1.0"?><styleSheet ${NS}>${body}</styleSheet>`;
const sst = (body: string): string => `<?xml version="1.0"?><sst ${NS} count="1" uniqueCount="1">${body}</sst>`;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ImportFileRejectedError) return err.code;
    throw err;
  }
  return "none";
}

/** Runs `fn`, returning its refusal code and how long it took in milliseconds. */
function timedCode(fn: () => unknown): { code: string; ms: number } {
  const started = process.hrtime.bigint();
  const result = code(fn);
  return { code: result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

describe("canonicalStyles keeps exactly what the library reads", () => {
  it("keeps number formats, both xf lists in order, numFmtId and (in cellXfs only) xfId; drops everything else", () => {
    const out = canonicalStyles(
      styles(
        `<numFmts count="2"><numFmt numFmtId="164" formatCode="d\\-mmm\\-yy &amp; &quot;x&quot;"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>` +
          `<fonts count="1"><font><b/></font></fonts><cellStyleXfs count="1"><xf numFmtId="0" xfId="9" fontId="0"><alignment/></xf></cellStyleXfs>` +
          `<cellXfs count="3"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"><alignment horizontal="center"/></xf><xf/></cellXfs>` +
          `<xf numFmtId="14"/><dxfs count="0"/>`,
      ),
    );
    expect(out).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmt numFmtId="164" formatCode="d\\-mmm\\-yy &amp; &quot;x&quot;"/><numFmt numFmtId="165" formatCode="0.00"/>` +
        `<cellStyleXfs><xf numFmtId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0"/><xf/></cellXfs></styleSheet>`,
    );
    expect(canonicalStyles(out)).toBe(out);
  });

  it("refuses ambiguity: a list inside a list, an unclosed list, a bad id, a missing numFmtId", () => {
    expect(code(() => canonicalStyles(styles(`<cellXfs><cellStyleXfs></cellStyleXfs></cellXfs>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<cellXfs><xf/>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<cellXfs><xf numFmtId="1e3"/></cellXfs>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<cellXfs><xf xfId="-1"/></cellXfs>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<numFmts><numFmt formatCode="0"/></numFmts>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<numFmt numFmtId="164" numFmtId="165" formatCode="0"/>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(`<!DOCTYPE s [<!ENTITY a "b">]><styleSheet/>`))).toBe("file_unreadable");
  });

  it("accepts a 255-character format code and refuses 256", () => {
    expect(code(() => canonicalStyles(styles(`<numFmt numFmtId="164" formatCode="${"0".repeat(255)}"/>`)))).toBe("none");
    expect(code(() => canonicalStyles(styles(`<numFmt numFmtId="164" formatCode="${"0".repeat(256)}"/>`)))).toBe("file_unreadable");
  });

  it("refuses a format code of '[' characters at once: the library's date check is quadratic on it (40,000 took 1.2 s)", () => {
    for (const size of [40_000, 1_000_000]) {
      const hostile = styles(`<numFmts><numFmt numFmtId="164" formatCode="${"[".repeat(size)}"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs>`);
      const r = timedCode(() => canonicalStyles(hostile));
      expect(r.code).toBe("file_unreadable");
      expect(r.ms).toBeLessThan(1000);
    }
  });

  it("refuses an <xf/> flood: 64,000 per list is Excel's limit, 9 million is not a style table", () => {
    const flood = styles(`<cellXfs>${"<xf/>".repeat(9_000_000)}</cellXfs>`);
    const r = timedCode(() => canonicalStyles(flood));
    expect(r.code).toBe("file_unreadable");
    expect(r.ms).toBeLessThan(2500);
    expect(code(() => canonicalStyles(styles(`<cellXfs>${"<xf/>".repeat(64_000)}</cellXfs>`)))).toBe("none");
    expect(code(() => canonicalStyles(styles(`<cellXfs>${"<xf/>".repeat(64_001)}</cellXfs>`)))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(`<cellStyleXfs>${"<xf/>".repeat(64_001)}</cellStyleXfs>`)))).toBe("file_unreadable");
  });

  it("accepts 1,000 custom number formats (Excel keeps about 250) and refuses 1,001, and a flood of 64,000 quickly", () => {
    const fmt = (n: number, codeText = "0"): string => Array.from({ length: n }, (_v, i) => `<numFmt numFmtId="${i + 164}" formatCode="${codeText}"/>`).join("");
    expect(code(() => canonicalStyles(styles(fmt(1000))))).toBe("none");
    expect(code(() => canonicalStyles(styles(fmt(1001))))).toBe("file_unreadable");
    const r = timedCode(() => canonicalStyles(styles(fmt(64_000))));
    expect(r.code).toBe("file_unreadable");
    expect(r.ms).toBeLessThan(2500);
  });

  it("caps the format-code text in all at 64 KiB: 258 codes of 255 characters is over, 257 is under (review round 4)", () => {
    const fmt = (n: number, size: number): string => Array.from({ length: n }, (_v, i) => `<numFmt numFmtId="${i + 164}" formatCode="${"[".repeat(size)}"/>`).join("");
    expect(code(() => canonicalStyles(styles(fmt(258, 255))))).toBe("file_unreadable");
    expect(code(() => canonicalStyles(styles(fmt(257, 255))))).toBe("none");
    // 64,000 codes of 250 '[' (16,000,000 characters): refused after the first 263 of them, fast.
    // (With the old caps this was 64,000 date checks over 250 characters each: 7.8 s on a 5,000 x 50 sheet, 1.5 MB.)
    const r = timedCode(() => canonicalStyles(styles(fmt(64_000, 250))));
    expect(r.code).toBe("file_unreadable");
    expect(r.ms).toBeLessThan(2500);
  });
});

describe("canonicalSharedStrings keeps what the library reads", () => {
  it("writes each <si> as one <t>, with the library's rule: a direct <t> replaces, a run appends, <rPh> is ignored", () => {
    const out = canonicalSharedStrings(
      sst(
        `<si><t>plain &amp; simple</t></si><si><r><rPr><b/></rPr><t>rich </t></r><r><t><![CDATA[<text>]]></t></r><rPh sb="0"><t>ignored</t></rPh><phoneticPr/></si>` +
          `<si><t>first</t><t>second</t></si><si/><si><t/></si><si><t xml:space="preserve">  kept  </t></si>`,
      ),
    );
    expect(out.xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<si><t>plain &amp; simple</t></si><si><t>rich &lt;text&gt;</t></si><si><t>second</t></si><si><t></t></si><si><t></t></si><si><t>  kept  </t></si></sst>`,
    );
    expect(out.lengths).toEqual([14, 11, 6, 0, 0, 8]);
    expect(canonicalSharedStrings(out.xml).xml).toBe(out.xml);
  });

  it("refuses ambiguity: a comment in a string, an unknown element, a nested run, an unclosed string, a DOCTYPE, a bad entity", () => {
    for (const body of ["<si><t>a<!-- x -->b</t></si>", "<si><x/></si>", "<si><r><r><t>a</t></r></r></si>", "<si><t>a</t>", "<si><t>a &bogus; b</t></si>", "<si><t>a</si>"]) {
      expect(code(() => canonicalSharedStrings(sst(body)))).toBe("file_unreadable");
    }
    expect(code(() => canonicalSharedStrings(`<!DOCTYPE sst [<!ENTITY a "b">]><sst><si><t>&a;</t></si></sst>`))).toBe("file_unreadable");
  });

  it("accepts a 32,767-character string and refuses 32,768, and refuses 250,001 strings", () => {
    expect(code(() => canonicalSharedStrings(sst(`<si><t>${"x".repeat(32_767)}</t></si>`)))).toBe("none");
    expect(code(() => canonicalSharedStrings(sst(`<si><t>${"x".repeat(32_768)}</t></si>`)))).toBe("file_unreadable");
    expect(code(() => canonicalSharedStrings(sst(`<si><t>${"\u{1F600}".repeat(32_767)}</t></si>`)))).toBe("none");
    const many = (n: number): string => sst("<si><t>a</t></si>".repeat(n));
    expect(code(() => canonicalSharedStrings(many(250_000)))).toBe("none");
    const r = timedCode(() => canonicalSharedStrings(many(250_001)));
    expect(r.code).toBe("file_unreadable");
    expect(r.ms).toBeLessThan(4000);
  });

  it("refuses a rich string that grows without bound before it is built", () => {
    const run = "<r><t>" + "y".repeat(40_000) + "</t></r>";
    const r = timedCode(() => canonicalSharedStrings(sst(`<si>${run.repeat(4)}</si>`)));
    expect(r.code).toBe("file_unreadable");
    expect(r.ms).toBeLessThan(1000);
  });
});

describe("GridBuilder bounds the total staged text (security review of PR #761, round 3)", () => {
  it("accepts 8,000,000 characters and refuses more, as rows arrive", () => {
    const row = (n: number): string[] => Array.from({ length: 50 }, () => "x".repeat(n));
    const fits = new GridBuilder();
    fits.add(1, Array.from({ length: 50 }, (_v, i) => `h${i}`));
    for (let r = 2; r <= 801; r += 1) fits.add(r, row(199));
    expect(() => fits.finish()).not.toThrow();
    const over = new GridBuilder();
    over.add(1, ["h"]);
    expect(() => {
      for (let r = 2; r <= 1000; r += 1) over.add(r, row(200));
    }).toThrow(expect.objectContaining({ code: "xlsx_limits_exceeded" }));
  });
});
