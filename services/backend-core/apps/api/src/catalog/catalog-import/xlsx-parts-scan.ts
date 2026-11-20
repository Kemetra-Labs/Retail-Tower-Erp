/**
 * RT-1505 (security review of PR #761, round 3): the styles and the shared
 * strings of an XLSX, re-serialized like the sheet (xlsx-sheet-scan.ts). After
 * this, NO uploaded part reaches `read-excel-file` byte for byte: the library
 * reads only XML this code wrote itself, from tokens it understood with the
 * strict tokenizer (xml-tags.ts).
 *
 * Why it matters: the library runs a regular expression over each number
 * format code that is quadratic (`[[[[…`: 40,000 characters took 1.2 s, 4
 * million hours), and builds one object per `<xf/>` (9 million of them, a 67 KB
 * upload, took 9 s on the main thread). So only what the library reads is kept,
 * and every count and length is capped.
 *
 * Styles (`parseStyles.js`): `<numFmt numFmtId formatCode>` (the code at most
 * 255 characters, Excel's limit), `<cellStyleXfs>` and `<cellXfs>` with their
 * `<xf numFmtId xfId>` (at most 64,000 each, Excel's limit; `xfId` only in
 * `cellXfs`, the only place the library reads it). Order is kept, because the
 * library looks a number format up when it reaches an `<xf>`.
 *
 * Shared strings (`parseSharedStrings.js`): per `<si>`, the text of its `<t>` and
 * `<r><t>` runs by the library's own rule (a direct `<t>` replaces the string, a
 * run's `<t>` appends, `<rPh>` is ignored), written back as one `<t>`. At most
 * 250,000 strings (5,000 rows of 50 columns) of at most 32,767 characters
 * (Excel's limit).
 */
import {
  MAX_FORMAT_CODE_CHARS,
  MAX_SHARED_STRING_CHARS,
  MAX_SHARED_STRINGS,
  MAX_STYLE_ENTRIES,
} from "./catalog-import.limits";
import { ImportFileRejectedError } from "./import-file-rejected";
import { charCount } from "./import-text";
import { decodeXmlText, escapeXmlAttribute, escapeXmlText, tagAttributes, tokenizeXml, type XmlTag, type XmlToken } from "./xml-tags";

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const ID = /^\d{1,9}$/;

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");

function document(root: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${MAIN_NS}">${body}</${root}>`;
}

// ---- styles ---------------------------------------------------------------------------------------

type StyleList = "cellStyleXfs" | "cellXfs";

class StylesScanner {
  private readonly out: string[] = [];
  private list: StyleList | null = null;
  private numFmts = 0;
  private readonly xfs: Record<StyleList, number> = { cellStyleXfs: 0, cellXfs: 0 };

  scan(xml: string): string {
    if (!tokenizeXml(xml, (token) => this.onToken(token))) throw unreadable();
    if (this.list !== null) throw unreadable();
    return document("styleSheet", this.out.join(""));
  }

  private onToken(token: XmlToken): void {
    if (token.kind !== "tag") return;
    if (token.name === "numFmt" && !token.closing) this.numFmt(token);
    else if (token.name === "cellStyleXfs" || token.name === "cellXfs") this.listTag(token, token.name);
    else if (token.name === "xf" && !token.closing) this.xf(token);
  }

  private numFmt(tag: XmlTag): void {
    const a = tagAttributes(tag, true);
    const id = a.get("numFmtId");
    const code = a.get("formatCode");
    // The library keys its table by `Number(numFmtId)`: an id that is not a plain number is refused.
    if (id === undefined || !ID.test(id)) throw unreadable();
    if (code !== undefined && charCount(code) > MAX_FORMAT_CODE_CHARS) throw unreadable();
    this.numFmts += 1;
    if (this.numFmts > MAX_STYLE_ENTRIES) throw unreadable();
    this.out.push(`<numFmt numFmtId="${id}"${code === undefined ? "" : ` formatCode="${escapeXmlAttribute(code)}"`}/>`);
  }

  private listTag(tag: XmlTag, name: StyleList): void {
    if (tag.closing) {
      if (this.list !== name) throw unreadable();
      this.list = null;
      this.out.push(`</${name}>`);
      return;
    }
    // The library tracks the two lists with flags; a list inside the other is ambiguous.
    if (this.list !== null) throw unreadable();
    this.out.push(`<${name}>`);
    if (tag.selfClosing) this.out.push(`</${name}>`);
    else this.list = name;
  }

  private xf(tag: XmlTag): void {
    // The library ignores an `<xf>` outside the two lists.
    if (this.list === null) return;
    const a = tagAttributes(tag, true);
    const numFmtId = a.get("numFmtId");
    const xfId = this.list === "cellXfs" ? a.get("xfId") : undefined;
    if ((numFmtId !== undefined && !ID.test(numFmtId)) || (xfId !== undefined && !ID.test(xfId))) throw unreadable();
    this.xfs[this.list] += 1;
    if (this.xfs[this.list] > MAX_STYLE_ENTRIES) throw unreadable();
    this.out.push(`<xf${numFmtId === undefined ? "" : ` numFmtId="${numFmtId}"`}${xfId === undefined ? "" : ` xfId="${xfId}"`}/>`);
  }
}

/** The canonical styles part, from the uploaded one. Throws `file_unreadable` for anything ambiguous or over a limit. */
export function canonicalStyles(xml: string): string {
  return new StylesScanner().scan(xml);
}

// ---- shared strings -------------------------------------------------------------------------------

/** The canonical shared strings and the length of each string, in order (the sheet scan needs them to bound the staged text). */
export interface SharedStrings {
  readonly xml: string;
  readonly lengths: readonly number[];
}

class SharedStringsScanner {
  private readonly out: string[] = [];
  private readonly lengths: number[] = [];
  private inSi = false;
  private inT = false;
  private inRun = false;
  private text = "";
  private skipName: string | null = null;
  private skipDepth = 0;

  scan(xml: string): SharedStrings {
    if (!tokenizeXml(xml, (token) => this.onToken(token))) throw unreadable();
    if (this.inSi) throw unreadable();
    return { xml: document("sst", this.out.join("")), lengths: this.lengths };
  }

  private onToken(token: XmlToken): void {
    if (!this.inSi) {
      if (token.kind === "tag" && token.name === "si" && !token.closing) this.openSi(token);
      return;
    }
    if (this.skipName !== null) return this.inSkipped(token);
    if (token.kind === "text") return this.addText(decodeXmlText(token.text));
    if (token.kind === "markup") return this.markup(token);
    if (token.closing) return this.close(token);
    this.open(token);
  }

  private openSi(tag: XmlTag): void {
    this.text = "";
    if (tag.selfClosing) this.endSi();
    else this.inSi = true;
  }

  private inSkipped(token: XmlToken): void {
    if (token.kind !== "tag" || token.name !== this.skipName || token.selfClosing) return;
    this.skipDepth += token.closing ? -1 : 1;
    if (this.skipDepth === 0) this.skipName = null;
  }

  /** The library's own rule: text counts only inside a `<t>`; a run's text appends, a direct `<t>` replaces. */
  private addText(text: string): void {
    if (!this.inT) return;
    this.text = this.inRun ? this.text + text : text;
    if (this.text.length > MAX_SHARED_STRING_CHARS * 2) throw unreadable();
  }

  private markup(token: XmlToken): void {
    if (token.kind !== "markup" || token.construct === "pi") return;
    // CDATA is text; a comment inside a string is ambiguous.
    if (token.construct === "cdata") this.addText(token.body);
    else throw unreadable();
  }

  private open(tag: XmlTag): void {
    if (tag.name === "t") this.inT = !tag.selfClosing;
    else if (tag.name === "r" && !this.inRun) this.inRun = !tag.selfClosing;
    else if (tag.name === "rPh" || tag.name === "phoneticPr" || (tag.name === "rPr" && this.inRun)) {
      if (!tag.selfClosing) {
        this.skipName = tag.name;
        this.skipDepth = 1;
      }
    } else throw unreadable();
  }

  private close(tag: XmlTag): void {
    if (tag.name === "t" && this.inT) this.inT = false;
    else if (tag.name === "r" && this.inRun && !this.inT) this.inRun = false;
    else if (tag.name === "si" && !this.inT && !this.inRun) this.endSi();
    else throw unreadable();
  }

  private endSi(): void {
    this.inSi = false;
    const length = this.text.length > MAX_SHARED_STRING_CHARS ? charCount(this.text) : this.text.length;
    if (length > MAX_SHARED_STRING_CHARS || this.lengths.length >= MAX_SHARED_STRINGS) throw unreadable();
    this.lengths.push(this.text.length);
    this.out.push(`<si><t>${escapeXmlText(this.text)}</t></si>`);
    this.text = "";
  }
}

/** The canonical shared strings part, from the uploaded one. Throws `file_unreadable` for anything ambiguous or over a limit. */
export function canonicalSharedStrings(xml: string): SharedStrings {
  return new SharedStringsScanner().scan(xml);
}
