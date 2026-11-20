/**
 * RT-1505 (spec 049 §8.5): what the import needs from the package parts of an
 * XLSX, read from the guarded zip (`zip-guard.ts`) before the library runs:
 *
 *   - the type, from `[Content_Types].xml` and never from the file name or the
 *     `Content-Type` header (spec 039 FR-03): a workbook part declared
 *     `…spreadsheetml.sheet.main+xml` is XLSX; a macro-enabled, template or
 *     binary workbook type, or no workbook part at all, is
 *     `file_type_unsupported`;
 *   - the sheet names, in workbook order, and each sheet's part path, so the
 *     sheet to read (`sheet`, default the first) is known and its XML can be
 *     pre-scanned (`xlsx-sheet-scan.ts`).
 *
 * The XML is read with small attribute scanners, not a general parser: the
 * parts are bounded (verified by the zip guard) and only a few attributes of
 * a few elements matter.
 */
import type { InspectedZip } from "./zip-guard";
import { ImportFileRejectedError } from "./import-file-rejected";

const WORKBOOK_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
/** A content type that names a workbook the import never reads. */
const REFUSED_TYPE = /macroenabled|spreadsheetml\.template|ms-excel\.sheet\.binary|vbaproject/i;

/** One sheet of the workbook, in `<sheets>` order. */
export interface WorkbookSheet {
  readonly name: string;
  /** The part path inside the zip, no leading slash. */
  readonly path: string;
}

const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) found.set(m[1] as string, decodeXmlText((m[2] ?? m[3]) as string));
  return found;
}

/** The start tags named `element` (any namespace prefix) of `xml`. */
function startTags(xml: string, element: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${element}\\b[^>]*>`, "g"))].map((m) => m[0]);
}

/** Decodes the five predefined entities and numeric character references of an XML attribute value. */
function decodeXmlText(value: string): string {
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/g, (_m, hex?: string, dec?: string, named?: string) => {
    if (named !== undefined) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named] as string;
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");
const unsupported = (): ImportFileRejectedError => new ImportFileRejectedError("file_type_unsupported");

async function readText(zip: InspectedZip, name: string): Promise<string | null> {
  const bytes = await zip.read(name);
  return bytes === null ? null : bytes.toString("utf8");
}

/** The workbook part path of an archive whose content types declare a plain XLSX workbook; else `file_type_unsupported`. */
async function workbookPart(zip: InspectedZip): Promise<string> {
  const types = await readText(zip, "[Content_Types].xml");
  if (types === null) throw unsupported();
  let workbook: string | null = null;
  for (const tag of [...startTags(types, "Override"), ...startTags(types, "Default")]) {
    const a = attributes(tag);
    const type = a.get("ContentType") ?? "";
    if (REFUSED_TYPE.test(type)) throw unsupported();
    const part = a.get("PartName");
    if (type === WORKBOOK_MAIN && part !== undefined && workbook === null) workbook = part.replace(/^\//, "");
  }
  if (workbook === null) throw unsupported();
  return workbook;
}

/** `Target` of a relationship, resolved against the directory of the part that owns the relationships. */
function resolveTarget(ownerDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${ownerDir}${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/**
 * The sheets of the workbook, in order. Throws `file_type_unsupported` for a
 * package that is not a plain XLSX and `file_unreadable` for one with no
 * readable workbook.
 */
export async function readWorkbookSheets(zip: InspectedZip): Promise<WorkbookSheet[]> {
  const part = await workbookPart(zip);
  const dir = part.includes("/") ? part.slice(0, part.lastIndexOf("/") + 1) : "";
  const base = part.slice(dir.length);
  const workbook = await readText(zip, part);
  const rels = await readText(zip, `${dir}_rels/${base}.rels`);
  if (workbook === null || rels === null) throw unreadable();
  const targets = new Map<string, string>();
  for (const tag of startTags(rels, "Relationship")) {
    const a = attributes(tag);
    const id = a.get("Id");
    const target = a.get("Target");
    if (id !== undefined && target !== undefined && a.get("TargetMode") !== "External") targets.set(id, resolveTarget(dir, target));
  }
  const sheets: WorkbookSheet[] = [];
  for (const tag of startTags(workbook, "sheet")) {
    const a = attributes(tag);
    const name = a.get("name");
    const id = [...a].find(([key]) => key === "r:id" || key.endsWith(":id"))?.[1];
    const path = id === undefined ? undefined : targets.get(id);
    if (name === undefined || path === undefined) throw unreadable();
    sheets.push({ name, path });
  }
  if (sheets.length === 0) throw unreadable();
  return sheets;
}
