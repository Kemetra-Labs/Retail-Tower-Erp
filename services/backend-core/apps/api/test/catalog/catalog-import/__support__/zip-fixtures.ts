/**
 * RT-1505: hand-built ZIP and XLSX fixtures for the import tests, on `node:zlib`
 * and `Buffer` only (the lockfile has no zip writer in the test graph). The
 * builder can LIE on purpose: every size, flag, name and the entry count can
 * be overridden in the central directory, the local header or the end record,
 * which is how the hostile fixtures of the zip guard are made.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface HeaderFacts {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipEntrySpec {
  readonly name: string;
  readonly data: Buffer | string;
  /** 0 stored, 8 deflate (default). */
  readonly method?: 0 | 8;
  /** Written as the entry's compressed bytes instead of the computed ones (a stream that lies). */
  readonly rawCompressed?: Buffer;
  /** Overrides of what the central directory says. */
  readonly central?: Partial<HeaderFacts>;
  /** Overrides of what the local header says. */
  readonly local?: Partial<HeaderFacts> & { name?: string };
  /** A data descriptor after the data (sets bit 3 in both headers unless overridden). */
  readonly descriptor?: "plain" | "signed";
  /** Bytes between the local header and the data. */
  readonly localExtra?: Buffer;
}

export interface ZipOptions {
  /** Overrides of the end-of-central-directory record. */
  readonly eocd?: { totalEntries?: number; thisDisk?: number; centralDisk?: number; disk?: number };
  readonly comment?: Buffer;
  /** Bytes inserted before the central directory but not covered by any entry (a hidden gap). */
  readonly gap?: Buffer;
  /** Write a zip64 end-of-central-directory locator before the end record. */
  readonly zip64Locator?: boolean;
}

function facts(spec: ZipEntrySpec, data: Buffer, comp: Buffer): HeaderFacts {
  const method = spec.method ?? 8;
  return {
    flags: spec.descriptor === undefined ? 0 : 0x0008,
    method,
    crc: crc32(data),
    compressedSize: comp.length,
    uncompressedSize: data.length,
  };
}

function localHeader(name: Buffer, f: HeaderFacts, extra: Buffer): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(f.flags, 6);
  h.writeUInt16LE(f.method, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(0x21, 12);
  h.writeUInt32LE(f.crc >>> 0, 14);
  h.writeUInt32LE(f.compressedSize >>> 0, 18);
  h.writeUInt32LE(f.uncompressedSize >>> 0, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, name, extra]);
}

function centralHeader(name: Buffer, f: HeaderFacts, offset: number): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(f.flags, 8);
  h.writeUInt16LE(f.method, 10);
  h.writeUInt16LE(0, 12);
  h.writeUInt16LE(0x21, 14);
  h.writeUInt32LE(f.crc >>> 0, 16);
  h.writeUInt32LE(f.compressedSize >>> 0, 20);
  h.writeUInt32LE(f.uncompressedSize >>> 0, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function descriptor(kind: "plain" | "signed", f: HeaderFacts): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(f.crc >>> 0, 0);
  body.writeUInt32LE(f.compressedSize >>> 0, 4);
  body.writeUInt32LE(f.uncompressedSize >>> 0, 8);
  if (kind === "plain") return body;
  const sig = Buffer.alloc(4);
  sig.writeUInt32LE(0x08074b50, 0);
  return Buffer.concat([sig, body]);
}

/** A ZIP archive of `entries`, honest unless a spec or option says otherwise. */
export function buildZip(entries: readonly ZipEntrySpec[], options: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of entries) {
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data);
    const method = spec.method ?? 8;
    const comp = spec.rawCompressed ?? (method === 0 ? data : deflateRawSync(data));
    const real = facts(spec, data, comp);
    const centralFacts = { ...real, ...spec.central };
    const localFacts = spec.descriptor === undefined ? { ...real, ...spec.local } : { ...real, crc: 0, compressedSize: 0, uncompressedSize: 0, ...spec.local };
    const nameBytes = Buffer.from(spec.name);
    const localName = Buffer.from(spec.local?.name ?? spec.name);
    const part = Buffer.concat([
      localHeader(localName, localFacts, spec.localExtra ?? Buffer.alloc(0)),
      comp,
      spec.descriptor === undefined ? Buffer.alloc(0) : descriptor(spec.descriptor, real),
    ]);
    centrals.push(centralHeader(nameBytes, centralFacts, offset));
    locals.push(part);
    offset += part.length;
  }
  const gap = options.gap ?? Buffer.alloc(0);
  const central = Buffer.concat(centrals);
  const centralOffset = offset + gap.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.eocd?.disk ?? 0, 4);
  eocd.writeUInt16LE(options.eocd?.centralDisk ?? 0, 6);
  eocd.writeUInt16LE(options.eocd?.thisDisk ?? options.eocd?.totalEntries ?? entries.length, 8);
  eocd.writeUInt16LE(options.eocd?.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE((options.comment ?? Buffer.alloc(0)).length, 20);
  const locator = Buffer.alloc(options.zip64Locator === true ? 20 : 0);
  if (options.zip64Locator === true) locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([...locals, gap, central, locator, eocd, options.comment ?? Buffer.alloc(0)]);
}

const MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** An XLSX cell: text, a number (as the file stores it), a boolean, a formula, or blank. */
export type XlsxCell = string | { num: string } | { bool: boolean } | { formula: string; cached?: string | { num: string } } | null;

export interface XlsxSheetSpec {
  readonly name: string;
  /** Rows by 1-based row number: `rows[0]` is row 1. A `null` row is not written. */
  readonly rows: readonly (readonly XlsxCell[] | null)[];
}

export interface XlsxOptions {
  readonly workbookType?: string;
  readonly extraEntries?: readonly ZipEntrySpec[];
  readonly sheetXmlOverride?: string;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cellXml(ref: string, cell: XlsxCell): string {
  if (cell === null) return "";
  if (typeof cell === "string") {
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
  }
  if ("num" in cell) return `<c r="${ref}"><v>${cell.num}</v></c>`;
  if ("bool" in cell) return `<c r="${ref}" t="b"><v>${cell.bool ? 1 : 0}</v></c>`;
  const f = `<f>${escapeXml(cell.formula)}</f>`;
  if (cell.cached === undefined) return `<c r="${ref}">${f}</c>`;
  if (typeof cell.cached === "string") return `<c r="${ref}" t="str">${f}<v>${escapeXml(cell.cached)}</v></c>`;
  return `<c r="${ref}">${f}<v>${cell.cached.num}</v></c>`;
}

export function sheetXml(rows: XlsxSheetSpec["rows"]): string {
  const body = rows
    .map((row, r) => {
      if (row === null) return "";
      const cells = row.map((cell, c) => cellXml(`${columnLetters(c)}${r + 1}`, cell)).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** A minimal, valid XLSX with the given sheets. */
export function buildXlsx(sheets: readonly XlsxSheetSpec[], options: XlsxOptions = {}): Buffer {
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${options.workbookType ?? MAIN}"/>` +
    sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL}"><sheets>` +
    sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">` +
    sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `</Relationships>`;
  const entries: ZipEntrySpec[] = [
    { name: "[Content_Types].xml", data: types },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: i === 0 && options.sheetXmlOverride !== undefined ? options.sheetXmlOverride : sheetXml(s.rows) })),
    ...(options.extraEntries ?? []),
  ];
  return buildZip(entries);
}

/** The entries of a valid one-sheet workbook, for a test that edits one of them. */
export function xlsxEntries(rows: XlsxSheetSpec["rows"]): ZipEntrySpec[] {
  const bytes = buildXlsx([{ name: "Products", rows }]);
  return readEntries(bytes);
}

/** Splits a fixture built by this module back into its entries (honest archives only). */
function readEntries(zip: Buffer): ZipEntrySpec[] {
  const out: ZipEntrySpec[] = [];
  const eocd = zip.length - 22;
  const total = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i += 1) {
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localAt = zip.readUInt32LE(at + 42);
    const start = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const comp = zip.subarray(start, start + zip.readUInt32LE(at + 20));
    out.push({ name, data: Buffer.from(inflateRawSync(comp)) });
    at += 46 + nameLength;
  }
  return out;
}

export const XLSX_MAIN_TYPE = MAIN;
