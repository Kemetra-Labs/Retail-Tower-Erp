/**
 * RT-473 S2 — synthetic logo inputs for the tenant-branding specs: plain
 * RGBA canvases encoded with the in-repo encoder, and hand-built PNG chunk
 * streams for the structure, bomb and polyglot cases.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { encodeRgbaPng, PNG_SIGNATURE } from "../../../src/tenant-branding/png-codec";

export type Colour = readonly [number, number, number, number];

export const TRANSPARENT: Colour = [0, 0, 0, 0];
export const NAVY: Colour = [16, 32, 96, 255];
export const PALE_YELLOW: Colour = [255, 255, 160, 255];
export const WHITE: Colour = [255, 255, 255, 255];
export const BLACK: Colour = [0, 0, 0, 255];

export interface Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function canvas(width: number, height: number, fill: Colour = TRANSPARENT): Canvas {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, colour: Colour): Canvas {
  for (let row = y; row < y + h; row += 1) {
    for (let col = x; col < x + w; col += 1) c.data.set(colour, (row * c.width + col) * 4);
  }
  return c;
}

export function toPng(c: Canvas): Buffer {
  return encodeRgbaPng(c.data, c.width, c.height);
}

/** A PNG of a `w` × `h` content block of `colour`, with a transparent `margin` on every side. */
export function logoPng(w: number, h: number, options: { margin?: number; colour?: Colour; background?: Colour } = {}): Buffer {
  const margin = options.margin ?? 20;
  const c = canvas(w + 2 * margin, h + 2 * margin, options.background ?? TRANSPARENT);
  return toPng(fillRect(c, margin, margin, w, h, options.colour ?? NAVY));
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

export function ihdr(width: number, height: number, bitDepth = 8, colourType = 6): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colourType;
  return pngChunk("IHDR", data);
}

/** The chunk list of a PNG: [type, data] pairs (no CRC check). */
export function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let at = PNG_SIGNATURE.length; at + 12 <= png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({ type: png.subarray(at + 4, at + 8).toString("latin1"), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

/** Re-assembles a PNG from chunks, inserting `extra` before IEND. */
export function withChunkBeforeIend(png: Buffer, extra: Buffer): Buffer {
  const iendAt = png.length - 12;
  return Buffer.concat([png.subarray(0, iendAt), extra, png.subarray(iendAt)]);
}

/**
 * A header-only bomb: a valid IHDR for `width` × `height` and a tiny IDAT
 * that could never decode to that size. Refusing it as too large proves the
 * header is checked before any decode.
 */
export function headerBomb(width: number, height: number): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(width, height),
    pngChunk("IDAT", deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A local-file ZIP header and a little payload: what a PNG/ZIP polyglot appends. */
export const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("polyglot payload")]);

/** The IHDR fields and decoded sample rows of a non-interlaced PNG (no filtering undone). */
export function pngHeader(png: Buffer): { width: number; height: number; bitDepth: number; colourType: number } {
  const header = chunks(png)[0]!.data;
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4), bitDepth: header[8]!, colourType: header[9]! };
}

/** The inflated IDAT stream of a PNG (filter bytes included). */
export function idatStream(png: Buffer): Buffer {
  return inflateSync(Buffer.concat(chunks(png).filter((c) => c.type === "IDAT").map((c) => c.data)));
}

export const SVG_ROOT = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"`;

export const svg = (body: string, root = SVG_ROOT): Buffer => Buffer.from(`<svg ${root}>${body}</svg>`, "utf8");

/** A 3:1 navy block, well inside the 1:1 … 4:1 range after anti-aliasing. */
export const RECT = `<rect x="50" y="50" width="300" height="100" fill="#102060"/>`;
