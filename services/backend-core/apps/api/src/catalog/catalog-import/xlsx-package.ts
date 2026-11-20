/**
 * RT-1505 (spec 049 §8.5): what the import needs from the package parts of an
 * XLSX, read from the guarded zip (`zip-guard.ts`), with the rules of
 * `read-excel-file` itself, so the import and the library cannot disagree
 * about which sheet is which (security review of PR #761, B2):
 *
 *   - the type, from `[Content_Types].xml` and never from the file name or the
 *     `Content-Type` header (spec 039 FR-03): the workbook part the library
 *     reads, `/xl/workbook.xml`, must be declared
 *     `…spreadsheetml.sheet.main+xml`; a macro-enabled, template or binary
 *     workbook type declared anywhere, or no such workbook part, is
 *     `file_type_unsupported`;
 *   - the workbook at its FIXED path `xl/workbook.xml` (the library never reads
 *     another): the sheets in `<sheets>` order, skipping a sheet with no name,
 *     a name with its `_xHHHH_` escapes decoded, the relationship id taken from
 *     the LAST attribute whose local name is `id`; and `date1904`;
 *   - the relationships at `xl/_rels/workbook.xml.rels`: only the library's
 *     relationship types (worksheet, styles, sharedStrings, transitional or
 *     strict), the last relationship of an id and of a kind wins, and a target
 *     is resolved as the library resolves it (`/x` is `x`, else `xl/x`).
 *
 * Tags come from the shared tokenizer (`xml-tags.ts`): a commented-out
 * `<sheet>` is not a sheet.
 */
import { ImportFileRejectedError } from "./import-file-rejected";
import { forEachTag, tagAttributes, unescapeXlsxString } from "./xml-tags";
import type { InspectedZip } from "./zip-guard";

const WORKBOOK_PART = "xl/workbook.xml";
const WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels";
const WORKBOOK_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
/** A content type that names a workbook the import never reads. */
const REFUSED_TYPE = /macroenabled|spreadsheetml\.template|ms-excel\.sheet\.binary|vbaproject/i;

const REL_BASES = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships/", "http://purl.oclc.org/ooxml/officeDocument/relationships/"];

/** One sheet of the workbook, in `<sheets>` order (a sheet with no name is not one). */
interface WorkbookSheet {
  readonly name: string;
  /** The relationship id (`r:id`) that locates its part. */
  readonly relationId: string | undefined;
}

/** What the workbook and its relationships say. */
export interface WorkbookInfo {
  readonly sheets: readonly WorkbookSheet[];
  readonly date1904: boolean;
  /** Relationship id to the part path of a worksheet, no leading slash. */
  readonly sheetPaths: ReadonlyMap<string, string>;
  readonly sharedStringsPath: string | null;
  readonly stylesPath: string | null;
}

const unreadable = (): ImportFileRejectedError => new ImportFileRejectedError("file_unreadable");
const unsupported = (): ImportFileRejectedError => new ImportFileRejectedError("file_type_unsupported");

async function readText(zip: InspectedZip, name: string): Promise<string | null> {
  const bytes = await zip.read(name);
  return bytes === null ? null : bytes.toString("utf8");
}

/** Refuses a package whose content types do not declare `/xl/workbook.xml` a plain workbook, or declare any macro, template or binary type. */
function checkContentTypes(types: string): void {
  let workbookDeclared = false;
  const walked = forEachTag(types, (tag) => {
    if (tag.closing || (tag.name !== "Override" && tag.name !== "Default")) return;
    const a = tagAttributes(tag);
    const type = a.get("ContentType") ?? "";
    if (REFUSED_TYPE.test(type)) throw unsupported();
    if (tag.name === "Override" && type === WORKBOOK_MAIN && a.get("PartName") === `/${WORKBOOK_PART}`) workbookDeclared = true;
  });
  if (!walked || !workbookDeclared) throw unsupported();
}

/** A relationship target as `read-excel-file` resolves it. */
function libraryPath(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
}

function parseWorkbook(xml: string): { sheets: WorkbookSheet[]; date1904: boolean } {
  const sheets: WorkbookSheet[] = [];
  const pr = { seen: false, date1904: false };
  const walked = forEachTag(xml, (tag) => {
    if (tag.closing) return;
    const a = tagAttributes(tag);
    // The library reads the first `workbookPr` only.
    if (tag.name === "workbookPr" && !pr.seen) Object.assign(pr, { seen: true, date1904: a.get("date1904") === "1" });
    if (tag.name !== "sheet") return;
    const name = a.get("name");
    // The library skips a sheet with no name.
    if (name === undefined || name === "") return;
    sheets.push({ name: unescapeXlsxString(name), relationId: a.get("id") });
  });
  if (!walked) throw unreadable();
  return { sheets, date1904: pr.date1904 };
}

function parseRelationships(xml: string): { sheetPaths: Map<string, string>; sharedStringsPath: string | null; stylesPath: string | null } {
  const sheetPaths = new Map<string, string>();
  let sharedStringsPath: string | null = null;
  let stylesPath: string | null = null;
  const walked = forEachTag(xml, (tag) => {
    if (tag.closing || tag.name !== "Relationship") return;
    const a = tagAttributes(tag);
    const type = a.get("Type");
    const target = a.get("Target");
    const base = REL_BASES.find((b) => type?.startsWith(b) === true);
    if (base === undefined || target === undefined || target === "" || type === undefined) return;
    const kind = type.slice(base.length);
    if (kind === "worksheet") sheetPaths.set(a.get("Id") as string, libraryPath(target));
    else if (kind === "sharedStrings") sharedStringsPath = libraryPath(target);
    else if (kind === "styles") stylesPath = libraryPath(target);
  });
  if (!walked) throw unreadable();
  return { sheetPaths, sharedStringsPath, stylesPath };
}

/**
 * The workbook as the library will read it. Throws `file_type_unsupported` for a
 * package that is not a plain XLSX and `file_unreadable` for one the library
 * could not read.
 */
export async function readWorkbookInfo(zip: InspectedZip): Promise<WorkbookInfo> {
  const types = await readText(zip, "[Content_Types].xml");
  if (types === null) throw unsupported();
  checkContentTypes(types);
  const workbook = await readText(zip, WORKBOOK_PART);
  const rels = await readText(zip, WORKBOOK_RELS_PART);
  if (workbook === null || rels === null) throw unreadable();
  const parsed = parseWorkbook(workbook);
  if (parsed.sheets.length === 0) throw unreadable();
  return { ...parsed, ...parseRelationships(rels) };
}
