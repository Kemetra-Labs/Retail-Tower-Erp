/**
 * In-repo SVG gate (RT-473 S2, spec 039 FR-03, FR-07, contract §5).
 *
 * A strict, non-validating XML tokenizer: no DTD, no external entity, no
 * resource is ever resolved. It refuses, in document order:
 *   - `image_malformed`: not UTF-8, or not well-formed (unbalanced tags, bad
 *     attribute syntax, an unknown entity, a second root, stray text);
 *   - `svg_unsafe_content` (`details.construct`, FR-07): a DOCTYPE or any
 *     `<!` declaration (`entity`); `<script>` / `<handler>` (`script`);
 *     `<foreignObject>`; `<iframe>` / `<embed>` / `<object>`
 *     (`embedded_content`); `<image>` (`image_element`); any `on*`
 *     attribute (`event_handler`); any `href` that is not `#fragment`, or a
 *     CSS `url(` that is not `#fragment` (`external_reference`); `@import`
 *     or an `<?xml-stylesheet?>` instruction (`css_import`). Names match on
 *     their local part in any namespace and any case; attribute values are
 *     entity-decoded and CSS-unescaped before matching;
 *   - `svg_unsupported`: no `<svg>` root, more than SVG_MAX_ELEMENTS elements
 *     or SVG_MAX_DEPTH nesting, neither a usable `viewBox` nor a positive
 *     absolute `width` and `height`, or a rasterizer work bound exceeded:
 *     fragment references (`<use href="#a">`, `url(#p)`) expand to more than
 *     SVG_MAX_EXPANDED_NODES nodes or form a cycle (a `<use>` / pattern fan-out
 *     is exponential in the nesting), or `feTurbulence` asks for more than
 *     SVG_MAX_TURBULENCE_OCTAVES octaves.
 *
 * Passing this gate is required before the bytes reach the rasterizer, which
 * itself runs with resource loading off (defence in depth).
 */
import { SVG_MAX_DEPTH, SVG_MAX_ELEMENTS, SVG_MAX_EXPANDED_NODES, SVG_MAX_TURBULENCE_OCTAVES } from "./logo-config";
import { reject, rejectUnsafe, type SvgUnsafeConstruct } from "./logo-refusal";

const BOM = "﻿";
const NAME_START = "A-Za-z_:\\u00C0-\\uFFFF";
const NAME_RE = new RegExp(`^[${NAME_START}][${NAME_START}0-9.\\-]*`);
const WS_RE = /^[ \t\r\n]*/;

const UNSAFE_ELEMENTS: ReadonlyMap<string, SvgUnsafeConstruct> = new Map([
  ["script", "script"],
  ["handler", "script"],
  ["foreignobject", "foreign_object"],
  ["iframe", "embedded_content"],
  ["embed", "embedded_content"],
  ["object", "embedded_content"],
  ["image", "image_element"],
]);

const PREDEFINED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** True when the bytes look like SVG by FR-03: optional BOM and whitespace, then `<?xml` or `<svg`. */
export function hasSvgSignature(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("latin1");
  const start = head.startsWith("\xEF\xBB\xBF") ? 3 : 0;
  const rest = head.slice(start).replace(WS_RE, "");
  return /^<\?xml[ \t\r\n]/.test(rest) || /^<svg[ \t\r\n/>]/.test(rest);
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1).toLowerCase();
}

function codePoint(text: string, radix: number): string {
  const value = Number.parseInt(text, radix);
  const valid =
    Number.isFinite(value) &&
    (value === 0x9 || value === 0xa || value === 0xd || (value >= 0x20 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0x10ffff)) &&
    value !== 0xfffe &&
    value !== 0xffff;
  if (!valid) reject("image_malformed");
  return String.fromCodePoint(value);
}

/** XML character data with its references decoded; an unknown entity or a bare `&` is malformed. */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&]*);?/g, (match, ref: string) => {
    if (!match.endsWith(";")) reject("image_malformed");
    if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) return codePoint(ref.slice(2), 16);
    if (/^#[0-9]{1,7}$/.test(ref)) return codePoint(ref.slice(1), 10);
    const named = PREDEFINED[ref];
    if (named === undefined) reject("image_malformed");
    return named;
  });
}

/** CSS with comments removed and escapes decoded, lowercased, for matching only. */
export function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, " ")
    .replace(/\\([0-9A-Fa-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/g, (_m, hex: string | undefined, ch: string | undefined) => {
      if (hex === undefined) return ch === "\n" ? "" : (ch ?? "");
      const value = Number.parseInt(hex, 16);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "�";
    })
    .toLowerCase();
}

/** FR-07 CSS rules on any value: `@import` (`css_import`) and a non-fragment `url(` (`external_reference`). */
export function checkCss(value: string): void {
  const css = normalizeCss(value);
  if (css.includes("@import")) rejectUnsafe("css_import");
  const urlRe = /url\(\s*(['"]?)\s*(.?)/g;
  for (let m = urlRe.exec(css); m !== null; m = urlRe.exec(css)) {
    if (m[2] !== "#") rejectUnsafe("external_reference");
  }
}

/** The `#id` targets of the `url(#id)` references in a (CSS) value. */
function cssFragments(value: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*['"]?\s*#([^'")\s]*)/g;
  const css = normalizeCss(value);
  for (let m = re.exec(css); m !== null; m = re.exec(css)) out.push(m[1]!);
  return out;
}

/** FR-07 checks of one attribute; returns the fragment ids it references. */
function checkAttribute(name: string, value: string): string[] {
  const local = localName(name);
  if (local.startsWith("on")) rejectUnsafe("event_handler");
  const refs: string[] = [];
  if (local === "href") {
    const target = value.trim();
    if (!target.startsWith("#")) rejectUnsafe("external_reference");
    refs.push(target.slice(1));
  }
  checkCss(value);
  return [...refs, ...cssFragments(value)];
}

interface StartTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly end: number;
}

/** Attribute pairs of a start tag body; malformed syntax or a duplicate name is refused. */
function parseStartTag(s: string, from: number): StartTag {
  const nameMatch = NAME_RE.exec(s.slice(from, from + 1024));
  if (nameMatch === null) reject("image_malformed");
  const name = nameMatch[0];
  const attributes = new Map<string, string>();
  let pos = from + name.length;
  for (;;) {
    const ws = WS_RE.exec(s.slice(pos, pos + 4096))![0].length;
    pos += ws;
    if (s.startsWith("/>", pos)) return { name, attributes, selfClosing: true, end: pos + 2 };
    if (s[pos] === ">") return { name, attributes, selfClosing: false, end: pos + 1 };
    if (ws === 0) reject("image_malformed");
    const attr = NAME_RE.exec(s.slice(pos, pos + 1024));
    if (attr === null) reject("image_malformed");
    pos += attr[0].length;
    pos += WS_RE.exec(s.slice(pos, pos + 4096))![0].length;
    if (s[pos] !== "=") reject("image_malformed");
    pos += 1;
    pos += WS_RE.exec(s.slice(pos, pos + 4096))![0].length;
    const quote = s[pos];
    if (quote !== '"' && quote !== "'") reject("image_malformed");
    const close = s.indexOf(quote, pos + 1);
    if (close < 0) reject("image_malformed");
    const raw = s.slice(pos + 1, close);
    if (raw.includes("<")) reject("image_malformed");
    if (attributes.has(attr[0])) reject("image_malformed");
    attributes.set(attr[0], decodeXmlText(raw));
    pos = close + 1;
  }
}

/** A positive length with an absolute unit the rasterizer resolves (px, pt, pc, mm, cm, in) or none. */
function isAbsoluteLength(value: string | undefined): boolean {
  if (value === undefined) return false;
  const m = /^\s*([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/.exec(value);
  return m !== null && Number(m[1]) > 0;
}

function hasUsableSize(attributes: ReadonlyMap<string, string>): boolean {
  const viewBox = attributes.get("viewBox");
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) return true;
  }
  return isAbsoluteLength(attributes.get("width")) && isAbsoluteLength(attributes.get("height"));
}

/** An open element: its node count and the fragment references inside it. */
interface Frame {
  readonly name: string;
  readonly id: string | null;
  count: number;
  readonly refs: string[];
}

/** An element with an `id`: what one reference to it costs before expansion. */
interface Target {
  readonly count: number;
  readonly refs: readonly string[];
}

interface ScanState {
  readonly stack: Frame[];
  readonly targets: Map<string, Target>;
  /** Fragment references to expand, with how many times each may be rendered. */
  readonly documentRefs: Array<{ id: string; times: number }>;
  elements: number;
  sawRoot: boolean;
  rootSized: boolean;
  /** Character data inside a `<style>` element, checked when it closes. */
  style: string | null;
}

/** A closed element adds its count and references to its parent and, with an `id`, becomes a target. */
function closeFrame(state: ScanState, frame: Frame): void {
  if (frame.id !== null) state.targets.set(frame.id, { count: frame.count, refs: frame.refs });
  const parent = state.stack.at(-1);
  if (parent !== undefined) {
    parent.count += frame.count;
    parent.refs.push(...frame.refs);
    return;
  }
  for (const id of frame.refs) state.documentRefs.push({ id, times: 1 });
}

function checkTurbulence(tag: StartTag): void {
  if (localName(tag.name) !== "feturbulence") return;
  const octaves = Number(tag.attributes.get("numOctaves") ?? "1");
  if (!Number.isFinite(octaves) || octaves > SVG_MAX_TURBULENCE_OCTAVES) reject("svg_unsupported");
}

function onStartTag(state: ScanState, tag: StartTag): void {
  if (state.stack.length === 0) {
    if (state.sawRoot) reject("image_malformed");
    state.sawRoot = true;
    if (localName(tag.name) !== "svg") reject("svg_unsupported");
    state.rootSized = hasUsableSize(tag.attributes);
  }
  state.elements += 1;
  if (state.elements > SVG_MAX_ELEMENTS || state.stack.length + 1 > SVG_MAX_DEPTH) reject("svg_unsupported");
  const unsafe = UNSAFE_ELEMENTS.get(localName(tag.name));
  if (unsafe !== undefined) rejectUnsafe(unsafe);
  const refs: string[] = [];
  for (const [name, value] of tag.attributes) refs.push(...checkAttribute(name, value));
  checkTurbulence(tag);
  const frame: Frame = { name: tag.name, id: tag.attributes.get("id") ?? null, count: 1, refs };
  if (tag.selfClosing) {
    closeFrame(state, frame);
    return;
  }
  state.stack.push(frame);
  if (localName(tag.name) === "style") state.style = "";
}

function onEndTag(state: ScanState, name: string): void {
  const frame = state.stack.pop();
  if (frame === undefined || frame.name !== name) reject("image_malformed");
  if (state.style !== null && localName(name) === "style") {
    checkCss(state.style);
    // A stylesheet rule may apply to every element: count it that many times.
    for (const id of cssFragments(state.style)) state.documentRefs.push({ id, times: SVG_MAX_ELEMENTS });
    state.style = null;
  }
  closeFrame(state, frame);
}

/**
 * The nodes the rasterizer may visit: every element once, plus each fragment
 * reference expanded (recursively) into its target. A cycle or a total above
 * SVG_MAX_EXPANDED_NODES is refused. Unknown targets render nothing.
 */
function checkExpansion(state: ScanState): void {
  const cost = new Map<string, number>();
  const visiting = new Set<string>();
  const expand = (id: string): number => {
    const known = cost.get(id);
    if (known !== undefined) return known;
    const target = state.targets.get(id);
    if (target === undefined) return 0;
    if (visiting.has(id)) reject("svg_unsupported");
    visiting.add(id);
    let total = target.count;
    for (const ref of target.refs) {
      total += expand(ref);
      if (total > SVG_MAX_EXPANDED_NODES) reject("svg_unsupported");
    }
    visiting.delete(id);
    cost.set(id, total);
    return total;
  };
  let total = state.elements;
  for (const { id, times } of state.documentRefs) {
    total += expand(id) * times;
    if (total > SVG_MAX_EXPANDED_NODES) reject("svg_unsupported");
  }
}

function onText(state: ScanState, raw: string, cdata: boolean): void {
  const text = cdata ? raw : decodeXmlText(raw);
  if (state.stack.length === 0) {
    if (text.trim() !== "") reject("image_malformed");
    return;
  }
  if (state.style !== null) state.style += text;
}

/** `<?target ...?>`: only the leading XML declaration and harmless instructions pass. */
function onInstruction(s: string, pos: number, end: number, state: ScanState): void {
  if (end < 0) reject("image_malformed");
  const target = (NAME_RE.exec(s.slice(pos + 2, pos + 256))?.[0] ?? "").toLowerCase();
  if (target === "xml-stylesheet") rejectUnsafe("css_import");
  if (target === "xml" && (pos !== 0 || state.sawRoot)) reject("image_malformed");
}

function indexOrMalformed(s: string, token: string, from: number): number {
  const at = s.indexOf(token, from);
  if (at < 0) reject("image_malformed");
  return at;
}

/** The markup at `pos` (which starts with `<`); returns where scanning resumes. */
function scanMarkup(s: string, pos: number, state: ScanState): number {
  if (s.startsWith("<!--", pos)) return indexOrMalformed(s, "-->", pos + 4) + 3;
  if (s.startsWith("<![CDATA[", pos)) {
    if (state.stack.length === 0) reject("image_malformed");
    const end = indexOrMalformed(s, "]]>", pos + 9);
    onText(state, s.slice(pos + 9, end), true);
    return end + 3;
  }
  if (s.startsWith("<!", pos)) rejectUnsafe("entity");
  if (s.startsWith("<?", pos)) {
    const end = s.indexOf("?>", pos + 2);
    onInstruction(s, pos, end, state);
    return end + 2;
  }
  if (s.startsWith("</", pos)) {
    const name = NAME_RE.exec(s.slice(pos + 2, pos + 1026))?.[0];
    if (name === undefined) reject("image_malformed");
    const after = pos + 2 + name.length;
    const close = after + WS_RE.exec(s.slice(after, after + 4096))![0].length;
    if (s[close] !== ">") reject("image_malformed");
    onEndTag(state, name);
    return close + 1;
  }
  const tag = parseStartTag(s, pos + 1);
  onStartTag(state, tag);
  return tag.end;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return reject("image_malformed");
  }
}

/**
 * Throws a `LogoRejectedError` unless the SVG passes every rule above.
 * Returns the checked text (BOM and leading whitespace removed): exactly what
 * the rasterizer may read.
 */
export function scanSvg(bytes: Buffer): string {
  let s = decodeUtf8(bytes);
  if (s.startsWith(BOM)) s = s.slice(1);
  s = s.replace(WS_RE, "");
  const state: ScanState = {
    stack: [],
    targets: new Map(),
    documentRefs: [],
    elements: 0,
    sawRoot: false,
    rootSized: false,
    style: null,
  };
  let pos = 0;
  while (pos < s.length) {
    const lt = s.indexOf("<", pos);
    const textEnd = lt < 0 ? s.length : lt;
    if (textEnd > pos) onText(state, s.slice(pos, textEnd), false);
    if (lt < 0) break;
    pos = scanMarkup(s, lt, state);
  }
  if (!state.sawRoot || state.stack.length !== 0) reject("image_malformed");
  if (!state.rootSized) reject("svg_unsupported");
  checkExpansion(state);
  return s;
}
