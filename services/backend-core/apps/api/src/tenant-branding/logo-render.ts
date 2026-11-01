/**
 * The decode-and-render stage of the tenant logo pipeline (RT-473 S2, spec
 * 039 FR-08 … FR-13), run in the logo worker thread (RT-1041,
 * logo-worker.ts) so its synchronous pixel work never blocks the API event
 * loop. It imports no Nest or workspace module: only the pipeline config,
 * the refusals, the in-repo codecs and raster code, sharp and node:crypto.
 *
 *   1. A libvips decode of a checked PNG (the upload, or the SVG child's
 *      render) with a pixel limit, converted to sRGB with every metadata
 *      chunk dropped.
 *   2. Trim (FR-08), shape checks on the trimmed box (FR-09), 8% clear
 *      space, capped master.
 *   3. Renditions (FR-10, FR-12), warnings (contract §6), presentation
 *      (FR-11) and the content version (FR-13).
 *
 * Steps 2–3 are in-repo integer code with a fixed PNG encoder, so the same
 * upload gives the same master, renditions and version. The worker runs the
 * same Node binary as the API, so `process.versions.zlib` (part of the
 * version) is the same on both threads.
 */
import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  CANONICAL_RENDITION_CONFIG,
  MASTER_MAX_SIDE_PX,
  MAX_ASPECT,
  MAX_PIXELS,
  MIN_HORIZONTAL_HEIGHT_PX,
  MIN_SQUARE_SIDE_PX,
  PIPELINE_VERSION,
  RECEIPT_DPI,
  RECEIPT_MAX_H_PX,
  RECEIPT_MAX_W_PX,
  SCALES,
  SLOT_BOXES,
  SLOTS,
  type Scale,
  type Slot,
} from "./logo-config";
import { LogoRejectedError, reject, type LogoRejectionCode, type SvgUnsafeConstruct } from "./logo-refusal";
import { encodeBilevelPng, encodeRgbaPng } from "./png-codec";
import {
  containSize,
  contentBox,
  cropWithClearSpace,
  floydSteinberg,
  grayOnWhite,
  hasHighBlackCoverage,
  hasThinStrokes,
  isLowContrast,
  isOpaque,
  resizeGray,
  resizeRgba,
  type Box,
  type Rgba,
} from "./raster-ops";

export const LOGO_WARNINGS = ["low_contrast", "receipt_high_black_coverage", "receipt_thin_strokes"] as const;
export type LogoWarning = (typeof LOGO_WARNINGS)[number];

export interface ScreenRenditionImage {
  readonly slot: Slot;
  readonly scale: Scale;
  readonly width: number;
  readonly height: number;
  readonly png: Buffer;
}

export interface ReceiptRenditionImage {
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
  readonly png: Buffer;
}

export interface ProcessedLogo {
  readonly version: string;
  readonly presentationCard: boolean;
  readonly warnings: readonly LogoWarning[];
  readonly master: { readonly width: number; readonly height: number; readonly png: Buffer };
  readonly screen: readonly ScreenRenditionImage[];
  readonly receipt: ReceiptRenditionImage;
}

/** libvips decode of a PNG to straight-alpha 8-bit sRGB RGBA, metadata dropped. */
async function decodePng(bytes: Buffer): Promise<Rgba> {
  try {
    const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: MAX_PIXELS, pages: 1 })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4 || data.length !== info.width * info.height * 4) reject("image_malformed");
    return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  } catch (err) {
    if (err instanceof LogoRejectedError) throw err;
    return reject("image_malformed");
  }
}

/** FR-09 on the trimmed content box (OD-4), for PNG and rasterized SVG alike. */
function checkShape(box: Box): void {
  if (box.width < box.height || box.width > MAX_ASPECT * box.height) reject("aspect_ratio_out_of_range");
  const squareIsh = box.width * 4 < box.height * 5;
  const bigEnough = squareIsh
    ? box.width >= MIN_SQUARE_SIDE_PX && box.height >= MIN_SQUARE_SIDE_PX
    : box.height >= MIN_HORIZONTAL_HEIGHT_PX;
  if (!bigEnough) reject("image_too_small");
}

function renderScreen(master: Rgba): ScreenRenditionImage[] {
  return SLOTS.flatMap((slot) =>
    SCALES.map((scale) => {
      const box = SLOT_BOXES[slot];
      const size = containSize(master.width, master.height, box.width * scale, box.height * scale);
      const image = resizeRgba(master, size.width, size.height);
      return { slot, scale, width: size.width, height: size.height, png: encodeRgbaPng(image.data, size.width, size.height) };
    }),
  );
}

function renderReceipt(master: Rgba): { image: ReceiptRenditionImage; black: Uint8Array } {
  const gray = grayOnWhite(master);
  const size = containSize(gray.width, gray.height, RECEIPT_MAX_W_PX, RECEIPT_MAX_H_PX);
  const black = floydSteinberg(resizeGray(gray, size.width, size.height));
  return {
    image: { width: size.width, height: size.height, dpi: RECEIPT_DPI, png: encodeBilevelPng(black, size.width, size.height) },
    black,
  };
}

/** FR-13: SHA-256 over master PNG ‖ pipeline version ‖ canonical rendition config. */
export function logoVersion(masterPng: Buffer): string {
  return createHash("sha256").update(masterPng).update(PIPELINE_VERSION, "utf8").update(CANONICAL_RENDITION_CONFIG, "utf8").digest("hex");
}

/** Decodes and renders a checked PNG; throws `LogoRejectedError` on a §5 refusal. */
export async function renderLogo(png: Buffer): Promise<ProcessedLogo> {
  const raster = await decodePng(png);
  const opaque = isOpaque(raster);
  const box = contentBox(raster, opaque);
  if (box === null) reject("image_empty");
  checkShape(box);

  const padded = cropWithClearSpace(raster, box, opaque);
  const capped = containSize(padded.width, padded.height, MASTER_MAX_SIDE_PX, MASTER_MAX_SIDE_PX);
  const master = resizeRgba(padded, capped.width, capped.height);
  const masterPng = encodeRgbaPng(master.data, master.width, master.height);

  const lowContrast = isLowContrast(master);
  const receipt = renderReceipt(master);
  const warnings: LogoWarning[] = [];
  if (lowContrast) warnings.push("low_contrast");
  if (hasHighBlackCoverage(receipt.black)) warnings.push("receipt_high_black_coverage");
  if (hasThinStrokes(receipt.black, receipt.image.width, receipt.image.height)) warnings.push("receipt_thin_strokes");

  return {
    version: logoVersion(masterPng),
    presentationCard: opaque || lowContrast,
    warnings,
    master: { width: master.width, height: master.height, png: masterPng },
    screen: renderScreen(master),
    receipt: receipt.image,
  };
}

/**
 * The worker's reply to one job. Structured clone turns every Buffer into a
 * plain Uint8Array and drops error classes, so a refusal travels as its code.
 */
export type LogoReply =
  | { readonly ok: true; readonly logo: ProcessedLogo }
  | { readonly ok: false; readonly refusal: { readonly code: LogoRejectionCode; readonly construct: SvgUnsafeConstruct | null } }
  | { readonly ok: false; readonly refusal: null; readonly error: string };

/** The worker side: renders `png` and never throws (every outcome is a reply). */
export async function renderReply(png: Uint8Array): Promise<LogoReply> {
  try {
    return { ok: true, logo: await renderLogo(Buffer.from(png.buffer, png.byteOffset, png.byteLength)) };
  } catch (err) {
    if (err instanceof LogoRejectedError) return { ok: false, refusal: { code: err.code, construct: err.construct } };
    return { ok: false, refusal: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The API side: the logo of a reply, or its refusal (`LogoRejectedError`) or failure (→ 500) thrown. */
export function fromReply(reply: LogoReply): ProcessedLogo {
  if (reply.ok) {
    const { logo } = reply;
    return {
      ...logo,
      master: { ...logo.master, png: asBuffer(logo.master.png) },
      screen: logo.screen.map((image) => ({ ...image, png: asBuffer(image.png) })),
      receipt: { ...logo.receipt, png: asBuffer(logo.receipt.png) },
    };
  }
  if (reply.refusal !== null) throw new LogoRejectedError(reply.refusal.code, reply.refusal.construct);
  throw new Error(`logo worker: ${reply.error}`);
}
