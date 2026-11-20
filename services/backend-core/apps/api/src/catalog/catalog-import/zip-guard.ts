/**
 * RT-1505 (spec 049 §8.5, RT-1504 comments 17944 / 17946 / 17947): the ZIP
 * guard of an XLSX upload. It runs BEFORE `read-excel-file`, which enforces
 * none of the limits: on its own it inflated a 124 KB file to 120 MiB for
 * 62 s, accepted 305 entries and a `vbaProject.bin`, and walked local headers
 * without ever reading the central directory.
 *
 * In-house on `node:zlib` and `Buffer` (no dependency), on the in-memory
 * upload (at most 5 MiB):
 *
 *   1. Find the end-of-central-directory record (the one whose comment ends the
 *      file). Refuse zip64 and multi-disk archives (a 5 MiB workbook needs
 *      neither).
 *   2. Refuse more than 200 entries BEFORE iterating the central directory.
 *   3. Per central record: refuse a `vbaProject*` entry, an encrypted entry and
 *      a method other than stored / deflate; refuse a duplicate name; sum the
 *      declared uncompressed sizes and refuse above 50 MiB.
 *   4. Cross-check the local headers the library actually walks: the entries
 *      must tile the file exactly from byte 0 to the central directory (name,
 *      method and, with no data descriptor, sizes and CRC equal to the central
 *      record; a descriptor equal to it), so a lying central directory and a
 *      hidden local entry are both refused.
 *   5. Inflate every entry the library inflates (`*.xml`, `*.xml.rels`) with
 *      `inflateRaw` and `maxOutputLength`: the real stream must end exactly at
 *      its declared compressed size, produce exactly its declared size and
 *      match its CRC. A header that lies is refused after at most the declared
 *      size of work (and the declared sizes sum to at most 50 MiB).
 *
 * Codes: a limit (entries, declared size) is `xlsx_limits_exceeded`; a macro
 * part, encryption, zip64, multi-disk or an exotic method is
 * `file_type_unsupported`; anything that does not agree with itself (a lying
 * header, a truncated or trailing stream, a bad CRC) is `file_unreadable`.
 */
import { crc32, inflateRaw } from "node:zlib";

import { MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from "./catalog-import.limits";
import { ImportFileRejectedError, type ImportFileRejectionCode } from "./import-file-rejected";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const DESCRIPTOR_SIG = 0x08074b50;

const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const refuse = (code: ImportFileRejectionCode): ImportFileRejectedError => new ImportFileRejectedError(code);

/** One central-directory record, the facts the rest of the import relies on. */
interface ZipEntry {
  readonly name: string;
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** A guarded archive: the entries that passed, and a reader for the ones the import needs. */
export interface InspectedZip {
  readonly names: readonly string[];
  /** The inflated bytes of an entry that passed the guard, or `null` when the archive has none by that name. */
  read(name: string): Promise<Buffer | null>;
}

interface Eocd {
  readonly totalEntries: number;
  readonly centralSize: number;
  readonly centralOffset: number;
  readonly offset: number;
}

function findEocd(buf: Buffer): Eocd {
  const lowest = Math.max(0, buf.length - EOCD_SIZE - 0xffff);
  for (let at = buf.length - EOCD_SIZE; at >= lowest; at -= 1) {
    if (buf.readUInt32LE(at) !== EOCD_SIG) continue;
    // The comment must end the file: a comment that holds another signature cannot move the record.
    if (at + EOCD_SIZE + buf.readUInt16LE(at + 20) !== buf.length) continue;
    return {
      totalEntries: buf.readUInt16LE(at + 10),
      centralSize: buf.readUInt32LE(at + 12),
      centralOffset: buf.readUInt32LE(at + 16),
      offset: at,
    };
  }
  throw refuse("file_unreadable");
}

function checkEocd(buf: Buffer, eocd: Eocd): void {
  const at = eocd.offset;
  const disk = buf.readUInt16LE(at + 4);
  const centralDisk = buf.readUInt16LE(at + 6);
  const onThisDisk = buf.readUInt16LE(at + 8);
  if (disk !== 0 || centralDisk !== 0 || onThisDisk !== eocd.totalEntries) throw refuse("file_type_unsupported");
  const zip64 =
    eocd.totalEntries === 0xffff ||
    eocd.centralSize === 0xffffffff ||
    eocd.centralOffset === 0xffffffff ||
    (at >= 20 && buf.readUInt32LE(at - 20) === ZIP64_LOCATOR_SIG);
  if (zip64 || eocd.totalEntries === 0) throw refuse("file_type_unsupported");
  // Before the central directory is iterated at all.
  if (eocd.totalEntries > MAX_ZIP_ENTRIES) throw refuse("xlsx_limits_exceeded");
  if (eocd.centralOffset + eocd.centralSize !== at) throw refuse("file_unreadable");
}

function parseCentralRecord(buf: Buffer, at: number, limit: number): { entry: ZipEntry; next: number } {
  if (at + CENTRAL_SIZE > limit || buf.readUInt32LE(at) !== CENTRAL_SIG) throw refuse("file_unreadable");
  const nameLength = buf.readUInt16LE(at + 28);
  const next = at + CENTRAL_SIZE + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  if (next > limit) throw refuse("file_unreadable");
  const nameBytes = Buffer.from(buf.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength));
  const entry: ZipEntry = {
    name: nameBytes.toString("utf8"),
    nameBytes,
    flags: buf.readUInt16LE(at + 8),
    method: buf.readUInt16LE(at + 10),
    crc: buf.readUInt32LE(at + 16),
    compressedSize: buf.readUInt32LE(at + 20),
    uncompressedSize: buf.readUInt32LE(at + 24),
    localOffset: buf.readUInt32LE(at + 42),
  };
  if (buf.readUInt16LE(at + 34) !== 0) throw refuse("file_type_unsupported");
  return { entry, next };
}

function checkEntryKind(entry: ZipEntry): void {
  const base = entry.name.split("/").pop() ?? "";
  if (/^vbaproject/i.test(base)) throw refuse("file_type_unsupported");
  if ((entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0) throw refuse("file_type_unsupported");
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) throw refuse("file_type_unsupported");
  if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) throw refuse("file_type_unsupported");
  if (entry.method === METHOD_STORED && entry.compressedSize !== entry.uncompressedSize) throw refuse("file_unreadable");
  if (entry.name.includes("\u0000")) throw refuse("file_unreadable");
}

function readCentralDirectory(buf: Buffer, eocd: Eocd): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let declared = 0;
  let at = eocd.centralOffset;
  for (let i = 0; i < eocd.totalEntries; i += 1) {
    const parsed = parseCentralRecord(buf, at, eocd.offset);
    checkEntryKind(parsed.entry);
    if (names.has(parsed.entry.name)) throw refuse("file_unreadable");
    names.add(parsed.entry.name);
    declared += parsed.entry.uncompressedSize;
    if (declared > MAX_UNCOMPRESSED_BYTES) throw refuse("xlsx_limits_exceeded");
    entries.push(parsed.entry);
    at = parsed.next;
  }
  if (at !== eocd.offset) throw refuse("file_unreadable");
  return entries;
}

/** The start of an entry's data, after its local header, once the header agrees with the central record. */
function localDataStart(buf: Buffer, entry: ZipEntry): number {
  const at = entry.localOffset;
  if (at + LOCAL_SIZE > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) throw refuse("file_unreadable");
  const flags = buf.readUInt16LE(at + 6);
  const nameLength = buf.readUInt16LE(at + 26);
  const start = at + LOCAL_SIZE + nameLength + buf.readUInt16LE(at + 28);
  const sameFlags = (flags & FLAG_DESCRIPTOR) === (entry.flags & FLAG_DESCRIPTOR) && (flags & FLAG_ENCRYPTED) === 0;
  const sameName = buf.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLength).equals(entry.nameBytes);
  if (!sameFlags || !sameName || buf.readUInt16LE(at + 8) !== entry.method || start > buf.length) throw refuse("file_unreadable");
  if ((entry.flags & FLAG_DESCRIPTOR) === 0) {
    const same =
      buf.readUInt32LE(at + 14) === entry.crc &&
      buf.readUInt32LE(at + 18) === entry.compressedSize &&
      buf.readUInt32LE(at + 22) === entry.uncompressedSize;
    if (!same) throw refuse("file_unreadable");
  }
  return start;
}

/** The length of the data descriptor after an entry's data (0 when it has none), once it agrees with the central record. */
function descriptorLength(buf: Buffer, entry: ZipEntry, dataEnd: number): number {
  if ((entry.flags & FLAG_DESCRIPTOR) === 0) return 0;
  const signed = dataEnd + 4 <= buf.length && buf.readUInt32LE(dataEnd) === DESCRIPTOR_SIG;
  const at = signed ? dataEnd + 4 : dataEnd;
  if (at + 12 > buf.length) throw refuse("file_unreadable");
  const same =
    buf.readUInt32LE(at) === entry.crc &&
    buf.readUInt32LE(at + 4) === entry.compressedSize &&
    buf.readUInt32LE(at + 8) === entry.uncompressedSize;
  if (!same) throw refuse("file_unreadable");
  return at + 12 - dataEnd;
}

/** The data span of every entry, after the local entries are shown to tile the file from byte 0 to the central directory. */
function tileLocalEntries(buf: Buffer, entries: readonly ZipEntry[], centralOffset: number): Map<string, readonly [number, number]> {
  const spans = new Map<string, readonly [number, number]>();
  let expected = 0;
  for (const entry of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    if (entry.localOffset !== expected) throw refuse("file_unreadable");
    const start = localDataStart(buf, entry);
    const end = start + entry.compressedSize;
    if (end > centralOffset) throw refuse("file_unreadable");
    expected = end + descriptorLength(buf, entry, end);
    spans.set(entry.name, [start, end]);
  }
  if (expected !== centralOffset) throw refuse("file_unreadable");
  return spans;
}

/** The entries the library inflates (`read-excel-file`'s own filter), the ones whose real size matters. */
function isInflatedByLibrary(name: string): boolean {
  return name.endsWith(".xml") || name.endsWith(".xml.rels");
}

interface InflateInfo {
  readonly buffer: Buffer;
  readonly engine: { readonly bytesWritten: number };
}

function inflate(data: Buffer, maxOutputLength: number): Promise<InflateInfo> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { info: true, maxOutputLength }, (err, result) => {
      if (err) reject(err);
      else resolve(result as unknown as InflateInfo);
    });
  });
}

/** The verified bytes of one entry: the stream ends exactly where the header says, at exactly the declared size, with the declared CRC. */
async function readVerified(buf: Buffer, entry: ZipEntry, span: readonly [number, number]): Promise<Buffer> {
  const data = buf.subarray(span[0], span[1]);
  let out: Buffer;
  if (entry.method === METHOD_STORED) {
    out = data;
  } else {
    try {
      // One byte over the declared size: a stream that really is bigger fails at once, never after 120 MiB.
      const result = await inflate(data, Math.max(1, entry.uncompressedSize + 1));
      if (result.engine.bytesWritten !== data.length) throw refuse("file_unreadable");
      out = result.buffer;
    } catch (err) {
      if (err instanceof ImportFileRejectedError) throw err;
      throw refuse("file_unreadable");
    }
  }
  if (out.length !== entry.uncompressedSize || crc32(out) !== entry.crc) throw refuse("file_unreadable");
  return out;
}

/**
 * Guards `buf` (an in-memory upload that starts with a ZIP signature) and
 * resolves a reader for its entries. Throws `ImportFileRejectedError`.
 */
export async function inspectZip(buf: Buffer): Promise<InspectedZip> {
  const eocd = findEocd(buf);
  checkEocd(buf, eocd);
  const entries = readCentralDirectory(buf, eocd);
  const spans = tileLocalEntries(buf, entries, eocd.centralOffset);
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  // Every entry the library will inflate, verified before it ever sees the file.
  for (const entry of entries) {
    if (isInflatedByLibrary(entry.name)) await readVerified(buf, entry, spans.get(entry.name) as readonly [number, number]);
  }
  return {
    names: entries.map((e) => e.name),
    async read(name) {
      const entry = byName.get(name);
      return entry === undefined ? null : readVerified(buf, entry, spans.get(name) as readonly [number, number]);
    },
  };
}
