/**
 * RT-1505: the one small, linear, fail-closed XML tokenizer of the XLSX import,
 * shared by the package readers (`xlsx-package.ts`) and the sheet pre-scan
 * (`xlsx-sheet-scan.ts`).
 *
 * The sheet is re-serialized from this tokenizer's own tokens before the
 * library sees it (xlsx-sheet-scan.ts), so what the library reads is exactly
 * what was understood here (security review of PR #761, round 2: a sheet the
 * library's SAX parser reads differently from a tokenizer fooled the scan). This
 * tokenizer therefore refuses, as `file_unreadable`, anything that two XML
 * readers could disagree about, instead of guessing:
 *
 *   - `<!` that is not a comment or CDATA (a DOCTYPE, an entity declaration);
 *   - a start tag longer than 8 KiB (a hostile run of characters in one tag);
 *   - an attribute that is not `name="value"` or `name='value'`, attributes not
 *     separated by whitespace, a repeated attribute name, a `<` in a value;
 *   - an entity other than the five named ones and well-formed `&#NNN;` /
 *     `&#xHH;` for a legal XML character (so `&AMP;`, `&#X41;`, 8-digit
 *     references and a bare `&` are refused).
 *
 * Every scan is a single left-to-right pass with `indexOf` and character
 * loops: no regular expression runs over attacker text (an attribute-name
 * regex was quadratic, security review blocker 2).
 *
 * Comments, CDATA and processing instructions are skipped; a `>` inside a quoted
 * attribute value does not end a tag; the namespace prefix of an element and of
 * an attribute is ignored (`x:f`, `r:id`) and `xmlns` declarations are not
 * attributes.
 */
import { ImportFileRejectedError } from "./import-file-rejected";

/** A start tag longer than this is refused. Real cells and workbook tags are a few hundred bytes. */
const MAX_TAG_CHARS = 8192;

/** A tag with more attributes than this is refused (the duplicate check is a set lookup, but a flood is never a real file). */
const MAX_TAG_ATTRIBUTES = 64;

const NAME = /^(\/?)(?:[\w.-]+:)?([\w.-]+)/;

/** One element tag of the document. */
export interface XmlTag {
  readonly kind: "tag";
  /** A closing tag (`</c>`). */
  readonly closing: boolean;
  /** The local name (no namespace prefix). */
  readonly name: string;
  /** The tag text after `<`, up to and including `>`. */
  readonly text: string;
  /** An empty-element tag (`<c .../>`). */
  readonly selfClosing: boolean;
}

/** Raw (still entity-encoded) text between tags. */
interface XmlText {
  readonly kind: "text";
  readonly text: string;
}

/** A comment, a CDATA section (`body` is its raw content) or a processing instruction. */
interface XmlMarkup {
  readonly kind: "markup";
  readonly construct: "comment" | "cdata" | "pi";
  readonly body: string;
}

export type XmlToken = XmlTag | XmlText | XmlMarkup;

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");

/** The index of the `>` that ends the start tag at `at` (a `<`), ignoring `>` inside quotes; -1 when it is missing, or the tag is over the length cap. */
function findTagEnd(xml: string, at: number): number {
  const limit = Math.min(xml.length, at + MAX_TAG_CHARS);
  let quote = 0;
  for (let i = at + 1; i < limit; i += 1) {
    const c = xml.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 0x22 || c === 0x27) quote = c;
    else if (c === 0x3e) return i;
  }
  return -1;
}

/**
 * Calls `onToken` for every token of `xml`, in order. Returns false when the
 * document cannot be tokenized (an unterminated construct or tag, a refused
 * `<!`, an over-long tag); `onToken` may throw to stop early.
 */
export function tokenizeXml(xml: string, onToken: (token: XmlToken) => void): boolean {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      onToken({ kind: "text", text: xml.slice(pos) });
      return true;
    }
    if (lt > pos) onToken({ kind: "text", text: xml.slice(pos, lt) });
    const next = tokenizeConstruct(xml, lt, onToken);
    if (next === -1) return false;
    pos = next;
  }
  return true;
}

/** Tokenizes the construct that starts at `lt`; returns the index after it, or -1 when it is malformed or refused. */
function tokenizeConstruct(xml: string, lt: number, onToken: (token: XmlToken) => void): number {
  if (xml.startsWith("<!--", lt)) return markup(xml, lt, 4, "-->", "comment", onToken);
  if (xml.startsWith("<![CDATA[", lt)) return markup(xml, lt, 9, "]]>", "cdata", onToken);
  if (xml.startsWith("<?", lt)) return markup(xml, lt, 2, "?>", "pi", onToken);
  // A DOCTYPE or any other `<!` declaration: two readers can disagree about its quoting, so it is refused.
  if (xml.startsWith("<!", lt)) return -1;
  const end = findTagEnd(xml, lt);
  if (end === -1) return -1;
  const text = xml.slice(lt + 1, end + 1);
  const named = NAME.exec(text);
  if (named === null) return -1;
  onToken({ kind: "tag", closing: named[1] === "/", name: named[2] as string, text, selfClosing: text.charCodeAt(text.length - 2) === 0x2f });
  return end + 1;
}

function markup(xml: string, lt: number, open: number, close: string, construct: XmlMarkup["construct"], onToken: (token: XmlToken) => void): number {
  const end = xml.indexOf(close, lt + open);
  if (end === -1) return -1;
  onToken({ kind: "markup", construct, body: xml.slice(lt + open, end) });
  return end + close.length;
}

/** The element tags of `xml` (text and markup are skipped). False when the document cannot be tokenized. */
export function forEachTag(xml: string, onTag: (tag: XmlTag) => void): boolean {
  return tokenizeXml(xml, (token) => {
    if (token.kind === "tag") onTag(token);
  });
}

const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/y;

/** Whether `code` is a character XML 1.0 allows. */
function isXmlChar(code: number): boolean {
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  return (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

/**
 * Decodes entities. Only the five named entities (lower case) and `&#NNN;` / `&#xHH;` for a legal XML character are
 * accepted; anything else (a bare `&`, `&AMP;`, `&#X41;`, a reference to NUL, a surrogate or a control character) is
 * refused as `file_unreadable`, so two readers cannot decode it differently.
 */
export function decodeXmlText(value: string): string {
  if (!value.includes("&")) return value;
  let out = "";
  let from = 0;
  for (let amp = value.indexOf("&"); amp !== -1; amp = value.indexOf("&", from)) {
    out += value.slice(from, amp);
    ENTITY.lastIndex = amp;
    const m = ENTITY.exec(value);
    if (m === null) throw unreadable();
    if (m[3] !== undefined) {
      out += { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[m[3]] as string;
    } else {
      const code = m[1] !== undefined ? Number(m[1]) : parseInt(m[2] as string, 16);
      if (!isXmlChar(code)) throw unreadable();
      out += String.fromCodePoint(code);
    }
    from = amp + m[0].length;
  }
  return out + value.slice(from);
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** The index in `t` after the tag name (and the leading `/` of a closing tag). */
function afterName(t: string): number {
  const named = NAME.exec(t);
  return named === null ? 0 : named[0].length;
}

/** One parsed attribute: the qualified name and the decoded value. */
interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

const NAME_STOP = "=/>\"'<";

/** The index of the first non-whitespace character of `t` at or after `from`. */
function skipSpaces(t: string, from: number): number {
  let i = from;
  while (i < t.length && isSpace(t.charCodeAt(i))) i += 1;
  return i;
}

/** Reads `name = "value"` at `from` (the first character of the name); returns the attribute and the index after it. */
function readAttribute(t: string, from: number): { attribute: RawAttribute; next: number } {
  let i = from;
  while (i < t.length && !isSpace(t.charCodeAt(i)) && !NAME_STOP.includes(t.charAt(i))) i += 1;
  if (i === from) throw unreadable();
  const name = t.slice(from, i);
  i = skipSpaces(t, i);
  if (t.charAt(i) !== "=") throw unreadable();
  i = skipSpaces(t, i + 1);
  const quote = t.charAt(i);
  const close = quote === '"' || quote === "'" ? t.indexOf(quote, i + 1) : -1;
  if (close === -1) throw unreadable();
  const raw = t.slice(i + 1, close);
  if (raw.includes("<")) throw unreadable();
  return { attribute: { name, value: decodeXmlText(raw) }, next: close + 1 };
}

/** Scans the attributes of a tag in one pass; throws `file_unreadable` at the first malformed one. */
function scanAttributes(tag: XmlTag): RawAttribute[] {
  const t = tag.text;
  const found: RawAttribute[] = [];
  const names = new Set<string>();
  let i = afterName(t);
  for (;;) {
    const after = skipSpaces(t, i);
    const c = t.charAt(after);
    if (c === ">") return found;
    if (c === "/") {
      if (t.charAt(after + 1) === ">") return found;
      throw unreadable();
    }
    // Attributes need whitespace before them (`q="1"r="A1"` is read differently by different parsers).
    if (after === i || after >= t.length) throw unreadable();
    const read = readAttribute(t, after);
    if (names.has(read.attribute.name) || found.length >= MAX_TAG_ATTRIBUTES) throw unreadable();
    names.add(read.attribute.name);
    found.push(read.attribute);
    i = read.next;
  }
}

const localName = (qualified: string): string => qualified.slice(qualified.lastIndexOf(":") + 1);

/**
 * The attributes of a tag by local name: prefixes dropped and `xmlns` declarations left out. A repeated qualified name
 * is always refused. A repeated LOCAL name (`r:id` with `id`, `x:r` with `r`) is refused when `distinctLocalNames` is
 * set (the sheet: its attributes are never prefixed), else the last wins (the workbook, as the library does).
 */
export function tagAttributes(tag: XmlTag, distinctLocalNames = false): Map<string, string> {
  const found = new Map<string, string>();
  for (const a of scanAttributes(tag)) {
    if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
    const local = localName(a.name);
    if (distinctLocalNames && found.has(local)) throw unreadable();
    found.set(local, a.value);
  }
  return found;
}

/** Text for an element body: `&`, `<` and `>` escaped. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text for a double-quoted attribute value. */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;");
}

/** Decodes the `_xHHHH_` escapes of an Excel string (ECMA-376 §22.9.2.19), as the library does for a sheet name. */
export function unescapeXlsxString(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
