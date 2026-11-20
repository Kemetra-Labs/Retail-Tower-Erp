/**
 * RT-1505 (security review of PR #761, B1 / B2): a minimal, honest, stored-only
 * ZIP writer. The import never hands the uploaded bytes to `read-excel-file`
 * (which re-parses a ZIP with rules of its own: local headers, fixed part
 * paths, a SAX parser). It hands it an archive built here from the parts the zip
 * guard verified and inflated, so a hidden entry, a stretched local size or a
 * second workbook in the upload never reaches it.
 *
 * Every entry is stored (no compression), its local header carries the real
 * sizes and CRC, there is no data descriptor, no extra field and no comment.
 */
import { crc32 } from "node:zlib";

/** One part to write. */
export interface StoredPart {
  readonly name: string;
  readonly data: Buffer;
}

/** A ZIP archive of `parts`, stored, in order. */
export function buildStoredZip(parts: readonly StoredPart[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const crc = crc32(part.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(part.data.length, 18);
    local.writeUInt32LE(part.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(part.data.length, 20);
    entry.writeUInt32LE(part.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    chunks.push(local, name, part.data);
    central.push(entry, name);
    offset += local.length + name.length + part.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
