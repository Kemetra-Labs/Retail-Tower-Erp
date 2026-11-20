/**
 * RT-1505: the one small XML tag tokenizer of the XLSX import, shared by the
 * package readers (`xlsx-package.ts`) and the sheet pre-scan
 * (`xlsx-sheet-scan.ts`) so they read XML the way `read-excel-file`'s SAX
 * parser does (security review of PR #761, B2 / B3):
 *
 *   - comments, CDATA, processing instructions and declarations are skipped,
 *     never read as tags (a commented-out `<sheet>` is not a sheet);
 *   - a `>` inside a quoted attribute value does not end a tag;
 *   - the namespace prefix of an element and of an attribute is ignored
 *     (`x:f`, `r:id`), `xmlns` declarations are not attributes, and for a
 *     repeated attribute the LAST value wins;
 *   - attribute values are entity-decoded, so `r="&#65;1"` is `A1`.
 *
 * Attribute scanning is over the tag's own text, so `<c q='r="A1"' r="B2">`
 * has `q` = `r="A1"` and `r` = `B2`; text inside another attribute's value is
 * never an attribute.
 */

/** A tag, up to its closing `>`; a `>` inside a quoted attribute value does not end it. */
const TAG_END = /[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;
const NAME = /^(\/?)(?:[\w.-]+:)?([\w.-]+)/;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** One element tag of the document. */
export interface XmlTag {
  /** A closing tag (`</c>`). */
  readonly closing: boolean;
  /** The local name (no namespace prefix). */
  readonly name: string;
  /** The tag text after `<`, up to and including `>`. */
  readonly text: string;
  /** An empty-element tag (`<c .../>`). */
  readonly selfClosing: boolean;
}

/** The index just past a construct that starts at `at` and ends with `terminator`, or -1 when it never ends. */
function skipPast(xml: string, at: number, terminator: string): number {
  const end = xml.indexOf(terminator, at);
  return end === -1 ? -1 : end + terminator.length;
}

/** The index after a non-element construct (comment, CDATA, processing instruction, declaration) at `at`, `at` for an element, -1 when it never ends. */
function skipMarkup(xml: string, at: number): number {
  if (xml.startsWith("<!--", at)) return skipPast(xml, at + 4, "-->");
  if (xml.startsWith("<![CDATA[", at)) return skipPast(xml, at + 9, "]]>");
  if (xml.startsWith("<?", at)) return skipPast(xml, at + 2, "?>");
  if (xml.startsWith("<!", at)) return skipPast(xml, at + 2, ">");
  return at;
}

/**
 * Calls `onTag` for every element tag of `xml`, in order. Returns false when
 * the document is not well formed enough to tokenize (an unterminated comment
 * or tag); `onTag` may throw to stop early.
 */
export function forEachTag(xml: string, onTag: (tag: XmlTag) => void): boolean {
  let at = xml.indexOf("<");
  while (at !== -1) {
    const afterMarkup = skipMarkup(xml, at);
    if (afterMarkup === -1) return false;
    if (afterMarkup !== at) {
      at = xml.indexOf("<", afterMarkup);
      continue;
    }
    TAG_END.lastIndex = at + 1;
    const matched = TAG_END.exec(xml);
    if (matched === null) return false;
    const text = matched[0];
    const named = NAME.exec(text);
    if (named !== null) {
      onTag({ closing: named[1] === "/", name: named[2] as string, text, selfClosing: text.slice(0, -1).trimEnd().endsWith("/") });
    }
    at = xml.indexOf("<", at + 1 + text.length);
  }
  return true;
}

/** Decodes the five predefined entities and numeric character references. A reference to NUL or a surrogate decodes to nothing. */
function decodeXmlText(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/g, (_m, hex?: string, dec?: string, named?: string) => {
    if (named !== undefined) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named] as string;
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

/** The attributes of a tag by local name: prefixes dropped, `xmlns` declarations left out, the last of a repeated attribute wins, values decoded. */
export function tagAttributes(tag: XmlTag): Map<string, string> {
  const found = new Map<string, string>();
  const start = tag.text.search(/[\s/>]/);
  const body = start === -1 ? "" : tag.text.slice(start);
  for (const m of body.matchAll(ATTRIBUTE)) {
    const key = m[1] as string;
    if (key === "xmlns" || key.startsWith("xmlns:")) continue;
    found.set(key.slice(key.lastIndexOf(":") + 1), decodeXmlText((m[2] ?? m[3]) as string));
  }
  return found;
}

/** Decodes the `_xHHHH_` escapes of an Excel string (ECMA-376 §22.9.2.19), as the library does for a sheet name. */
export function unescapeXlsxString(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
