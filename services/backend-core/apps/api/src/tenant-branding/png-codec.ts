/**
 * In-repo PNG structure check and encoders (RT-473 S2, spec 039 FR-05,
 * FR-06, FR-12, FR-13).
 *
 * `inspectPng` walks the chunk layout BEFORE any pixel decode:
 *   - the signature, then IHDR as the first chunk, whose dimensions are
 *     checked against the 4000 px / 16 MP bomb guard straight away;
 *   - every chunk's length and CRC;
 *   - IEND last, with no byte after it (a PNG/ZIP polyglot is refused).
 * Pixel decoding is left to libvips, which runs with its own pixel limit.
 *
 * The encoders write only IHDR, IDAT and IEND (no metadata chunk can exist)
 * with fixed filter and zlib settings, so the same pixels give the same bytes.
 */
import { crc32, deflateSync, constants as zlibConstants } from "node:zlib";

import { MAX_PIXELS, MAX_SIDE_PX } from "./logo-config";
import { reject } from "./logo-refusal";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the bytes start with the PNG signature. */
export function hasPngSignature(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export interface PngHeader {
  readonly width: number;
  readonly height: number;
}

/** Valid (colour type → bit depths) pairs of the PNG specification. */
const BIT_DEPTHS: ReadonlyMap<number, readonly number[]> = new Map([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);

const CHUNK_TYPE_RE = /^[A-Za-z]{4}$/;

function readIhdr(data: Buffer): PngHeader {
  if (data.length !== 13) reject("image_malformed");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8]!;
  const colourType = data[9]!;
  if (width === 0 || height === 0) reject("image_malformed");
  if (!(BIT_DEPTHS.get(colourType) ?? []).includes(bitDepth)) reject("image_malformed");
  if (data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) reject("image_malformed");
  return { width, height };
}

/** FR-05: refused from the header alone, before any decode. */
function checkDimensions(header: PngHeader): void {
  if (header.width > MAX_SIDE_PX || header.height > MAX_SIDE_PX || header.width * header.height > MAX_PIXELS) {
    reject("image_dimensions_too_large");
  }
}

interface Chunk {
  readonly type: string;
  readonly data: Buffer;
  readonly end: number;
}

/** The chunk at `offset`, with its length and CRC checked. */
function readChunk(bytes: Buffer, offset: number): Chunk {
  if (offset + 12 > bytes.length) reject("image_malformed");
  const length = bytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (length > 0x7fffffff || end > bytes.length) reject("image_malformed");
  const typeAndData = bytes.subarray(offset + 4, offset + 8 + length);
  const type = typeAndData.subarray(0, 4).toString("latin1");
  if (!CHUNK_TYPE_RE.test(type)) reject("image_malformed");
  if (crc32(typeAndData) !== bytes.readUInt32BE(offset + 8 + length)) reject("image_malformed");
  return { type, data: typeAndData.subarray(4), end };
}

/**
 * The PNG's header, after the structure checks above. Throws a
 * `LogoRejectedError` (`image_malformed` or `image_dimensions_too_large`).
 */
export function inspectPng(bytes: Buffer): PngHeader {
  if (!hasPngSignature(bytes)) reject("file_type_not_allowed");
  const first = readChunk(bytes, PNG_SIGNATURE.length);
  if (first.type !== "IHDR") reject("image_malformed");
  const header = readIhdr(first.data);
  checkDimensions(header);

  let offset = first.end;
  let sawIdat = false;
  for (;;) {
    const chunk = readChunk(bytes, offset);
    if (chunk.type === "IHDR") reject("image_malformed");
    if (chunk.type === "IDAT") sawIdat = true;
    if (chunk.type === "IEND") {
      if (chunk.data.length !== 0 || chunk.end !== bytes.length || !sawIdat) reject("image_malformed");
      return header;
    }
    offset = chunk.end;
  }
}

/** Fixed zlib settings: the same filtered rows always deflate to the same bytes. */
const DEFLATE_OPTIONS = {
  level: 9,
  memLevel: 9,
  windowBits: 15,
  strategy: zlibConstants.Z_DEFAULT_STRATEGY,
} as const;

function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

function png(width: number, height: number, bitDepth: number, colourType: number, filtered: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered, DEFLATE_OPTIONS)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** An 8-bit RGBA PNG (colour type 6), every row Paeth-filtered. */
export function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const out = y * (stride + 1);
    filtered[out] = 4;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? rgba[row + i - 4]! : 0;
      const b = y > 0 ? rgba[row - stride + i]! : 0;
      const c = i >= 4 && y > 0 ? rgba[row - stride + i - 4]! : 0;
      filtered[out + 1 + i] = (rgba[row + i]! - paeth(a, b, c)) & 0xff;
    }
  }
  return png(width, height, 8, 6, filtered);
}

/**
 * A 1-bit grayscale PNG (colour type 0, bit depth 1). `black[i]` is 1 for a
 * black dot; PNG sample 0 is black and 1 is white. Padding bits are 0.
 */
export function encodeBilevelPng(black: Uint8Array, width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const filtered = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const out = y * (rowBytes + 1);
    for (let x = 0; x < width; x += 1) {
      if (black[y * width + x] !== 0) continue;
      const at = out + 1 + (x >> 3);
      filtered[at] = filtered[at]! | (0x80 >> (x & 7));
    }
  }
  return png(width, height, 1, 0, filtered);
}
