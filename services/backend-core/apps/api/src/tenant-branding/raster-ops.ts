/**
 * In-repo raster operations of the tenant logo pipeline (RT-473 S2, spec 039
 * FR-08 … FR-12, contract §6). Integer arithmetic only (every intermediate
 * stays below 2^53), so the same pixels give the same result on any host.
 *
 * Images are straight-alpha 8-bit RGBA (`Rgba`) or 8-bit gray (`Gray`),
 * row-major, no padding.
 */
import {
  CLEAR_SPACE_PERCENT,
  INK_ALPHA_MIN,
  LOW_CONTRAST_MIN_RATIO,
  RECEIPT_BLACK_COVERAGE_MAX_PERCENT,
  RECEIPT_THIN_MAX_PERCENT,
  TRIM_TOLERANCE,
} from "./logo-config";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Gray {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** True when every pixel has alpha 255. */
export function isOpaque(image: Rgba): boolean {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) return false;
  return true;
}

/** Whether a pixel is margin: alpha 0, or (opaque image) within TRIM_TOLERANCE of `bg`. */
function marginTest(image: Rgba, opaque: boolean): (offset: number) => boolean {
  const d = image.data;
  if (!opaque) return (o) => d[o + 3] === 0;
  const [r, g, b] = [d[0]!, d[1]!, d[2]!];
  return (o) =>
    Math.abs(d[o]! - r) <= TRIM_TOLERANCE && Math.abs(d[o + 1]! - g) <= TRIM_TOLERANCE && Math.abs(d[o + 2]! - b) <= TRIM_TOLERANCE;
}

/** FR-08: the content bounding box (margins trimmed), or null when nothing is left (`image_empty`). */
export function contentBox(image: Rgba, opaque: boolean): Box | null {
  const isMargin = marginTest(image, opaque);
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (isMargin((y * image.width + x) * 4)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  if (right < 0) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** `round(value × percent / 100)` in integers. */
function percentOf(value: number, percent: number): number {
  return Math.floor((value * percent * 2 + 100) / 200);
}

/**
 * FR-08: the content box cropped out, with the clear space added on each
 * side (8% of the width left and right, 8% of the height top and bottom).
 * The padding is transparent, or the margin colour of an opaque image.
 */
export function cropWithClearSpace(image: Rgba, box: Box, opaque: boolean): Rgba {
  const padX = Math.max(1, percentOf(box.width, CLEAR_SPACE_PERCENT));
  const padY = Math.max(1, percentOf(box.height, CLEAR_SPACE_PERCENT));
  const width = box.width + 2 * padX;
  const height = box.height + 2 * padY;
  const data = new Uint8Array(width * height * 4);
  if (opaque) {
    const fill = image.data.subarray(0, 4);
    for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  }
  for (let y = 0; y < box.height; y += 1) {
    const from = ((box.top + y) * image.width + box.left) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), ((padY + y) * width + padX) * 4);
  }
  return { width, height, data };
}

/** `round(a / b)` for non-negative integers. */
function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/**
 * The size of a `contain` fit of (w, h) inside (boxW, boxH), never upscaled
 * (FR-10). Integer rounding; the result never exceeds the box.
 */
export function containSize(w: number, h: number, boxW: number, boxH: number): { width: number; height: number } {
  if (w <= boxW && h <= boxH) return { width: w, height: h };
  if (w * boxH >= h * boxW) return { width: boxW, height: Math.max(1, Math.min(boxH, roundDiv(h * boxW, w))) };
  return { width: Math.max(1, Math.min(boxW, roundDiv(w * boxH, h))), height: boxH };
}

interface Tap {
  readonly src: number;
  readonly weight: number;
}

/**
 * Area-average taps for a downscale from `srcLen` to `dstLen` pixels. In
 * units where a source pixel is `dstLen` long and a destination pixel is
 * `srcLen` long, each tap's weight is the integer overlap, and every
 * destination pixel's weights sum to `srcLen`.
 */
function taps(srcLen: number, dstLen: number): Tap[][] {
  const out: Tap[][] = [];
  for (let i = 0; i < dstLen; i += 1) {
    const start = i * srcLen;
    const end = start + srcLen;
    const row: Tap[] = [];
    for (let j = Math.floor(start / dstLen); j * dstLen < end; j += 1) {
      const weight = Math.min(end, (j + 1) * dstLen) - Math.max(start, j * dstLen);
      if (weight > 0) row.push({ src: j, weight });
    }
    out.push(row);
  }
  return out;
}

/**
 * Exact area-average resample of `channels`-wide pixels (downscale or same
 * size only). `weigh` converts a source pixel into the sums it contributes;
 * `emit` turns the destination sums back into pixel values. Streams one
 * source row at a time, so memory is two destination rows of sums.
 */
function resample(
  src: { width: number; height: number; data: Uint8Array },
  width: number,
  height: number,
  sumsPerPixel: number,
  weigh: (data: Uint8Array, offset: number, out: Float64Array, at: number) => void,
  emit: (sums: Float64Array, at: number, area: number, out: Uint8Array, offset: number) => void,
  channels: number,
): Uint8Array {
  const xTaps = taps(src.width, width);
  const yTaps = taps(src.height, height);
  const area = src.width * src.height;
  const out = new Uint8Array(width * height * channels);
  const pixel = new Float64Array(sumsPerPixel);
  const hRows = new Map<number, Float64Array>();
  const hRow = (y: number): Float64Array => {
    let row = hRows.get(y);
    if (row !== undefined) return row;
    row = new Float64Array(width * sumsPerPixel);
    for (let x = 0; x < width; x += 1) {
      for (const t of xTaps[x]!) {
        weigh(src.data, (y * src.width + t.src) * channels, pixel, 0);
        for (let k = 0; k < sumsPerPixel; k += 1) row[x * sumsPerPixel + k]! += pixel[k]! * t.weight;
      }
    }
    hRows.set(y, row);
    return row;
  };
  const sums = new Float64Array(width * sumsPerPixel);
  for (let y = 0; y < height; y += 1) {
    sums.fill(0);
    for (const t of yTaps[y]!) {
      const row = hRow(t.src);
      for (let i = 0; i < sums.length; i += 1) sums[i]! += row[i]! * t.weight;
    }
    for (const key of [...hRows.keys()]) if (key < (yTaps[y + 1]?.[0]?.src ?? Infinity)) hRows.delete(key);
    for (let x = 0; x < width; x += 1) emit(sums, x * sumsPerPixel, area, out, (y * width + x) * channels);
  }
  return out;
}

/** Area-average RGBA resample with premultiplied alpha (straight alpha in and out). */
export function resizeRgba(image: Rgba, width: number, height: number): Rgba {
  if (width === image.width && height === image.height) return image;
  const data = resample(
    image,
    width,
    height,
    4,
    (d, o, out) => {
      const a = d[o + 3]!;
      out[0] = d[o]! * a;
      out[1] = d[o + 1]! * a;
      out[2] = d[o + 2]! * a;
      out[3] = a;
    },
    (s, at, area, out, o) => {
      const alphaSum = s[at + 3]!;
      out[o + 3] = Math.min(255, roundDiv(alphaSum, area));
      if (alphaSum === 0) return;
      for (let k = 0; k < 3; k += 1) out[o + k] = Math.min(255, roundDiv(s[at + k]!, alphaSum));
    },
    4,
  );
  return { width, height, data };
}

/** Area-average gray resample. */
export function resizeGray(image: Gray, width: number, height: number): Gray {
  if (width === image.width && height === image.height) return image;
  const data = resample(
    image,
    width,
    height,
    1,
    (d, o, out) => {
      out[0] = d[o]!;
    },
    (s, at, area, out, o) => {
      out[o] = Math.min(255, roundDiv(s[at]!, area));
    },
    1,
  );
  return { width, height, data };
}

/** FR-12 steps 1–2: composite onto white, then BT.709 integer luma. */
export function grayOnWhite(image: Rgba): Gray {
  const data = new Uint8Array(image.width * image.height);
  const d = image.data;
  for (let i = 0, o = 0; o < data.length; i += 4, o += 1) {
    const a = d[i + 3]!;
    const r = roundDiv(d[i]! * a + 255 * (255 - a), 255);
    const g = roundDiv(d[i + 1]! * a + 255 * (255 - a), 255);
    const b = roundDiv(d[i + 2]! * a + 255 * (255 - a), 255);
    data[o] = Math.floor((2126 * r + 7152 * g + 722 * b + 5000) / 10000);
  }
  return { width: image.width, height: image.height, data };
}

/**
 * FR-12 step 4 (OD-6): integer Floyd–Steinberg, left to right, threshold 128.
 * Returns 1 for a black dot, 0 for white.
 */
export function floydSteinberg(image: Gray): Uint8Array {
  const { width, height } = image;
  const work = Int32Array.from(image.data);
  const black = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const old = work[i]!;
      const isBlack = old < 128;
      black[i] = isBlack ? 1 : 0;
      const err = old - (isBlack ? 0 : 255);
      if (x + 1 < width) work[i + 1]! += (err * 7) >> 4;
      if (y + 1 < height) {
        if (x > 0) work[i + width - 1]! += (err * 3) >> 4;
        work[i + width]! += (err * 5) >> 4;
        if (x + 1 < width) work[i + width + 1]! += err >> 4;
      }
    }
  }
  return black;
}

/** WCAG relative luminance of each 8-bit sRGB channel value. */
const LINEAR: readonly number[] = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** Contract §6.1: fewer than 50% of the ink pixels (alpha ≥ 128) reach 3:1 against #ffffff. */
export function isLowContrast(image: Rgba): boolean {
  let ink = 0;
  let passing = 0;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < INK_ALPHA_MIN) continue;
    ink += 1;
    const luminance = 0.2126 * LINEAR[d[i]!]! + 0.7152 * LINEAR[d[i + 1]!]! + 0.0722 * LINEAR[d[i + 2]!]!;
    if (1.05 / (luminance + 0.05) >= LOW_CONTRAST_MIN_RATIO) passing += 1;
  }
  return passing * 2 < ink || ink === 0;
}

/** Contract §6: more than 35% of the receipt rendition is black. */
export function hasHighBlackCoverage(black: Uint8Array): boolean {
  let count = 0;
  for (const dot of black) count += dot;
  return count * 100 > black.length * RECEIPT_BLACK_COVERAGE_MAX_PERCENT;
}

/** Contract §6.2: more than 10% of black dots belong to no fully black 2 × 2 block. */
export function hasThinStrokes(black: Uint8Array, width: number, height: number): boolean {
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height && black[y * width + x] === 1;
  const solid = (x: number, y: number): boolean => at(x, y) && at(x + 1, y) && at(x, y + 1) && at(x + 1, y + 1);
  let blackCount = 0;
  let thin = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!at(x, y)) continue;
      blackCount += 1;
      if (!(solid(x - 1, y - 1) || solid(x, y - 1) || solid(x - 1, y) || solid(x, y))) thin += 1;
    }
  }
  return thin * 100 > blackCount * RECEIPT_THIN_MAX_PERCENT;
}
