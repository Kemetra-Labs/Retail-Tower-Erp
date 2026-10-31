/**
 * The tenant logo pipeline (RT-473 S2, spec 039 FR-03 … FR-13).
 *
 *   1. Type by magic bytes only (FR-03): PNG signature, or an SVG prolog /
 *      `<svg` root. Anything else is `file_type_not_allowed`.
 *   2. PNG: the in-repo chunk walk (header bomb guard, CRC, nothing after
 *      IEND), then a libvips decode with a pixel limit, converted to sRGB
 *      with every metadata chunk dropped. SVG: the in-repo gate, then resvg
 *      in a killable child process at a fixed size (svg-rasterize.ts). The
 *      SVG itself is never kept.
 *   3. Trim (FR-08), shape checks on the trimmed box (FR-09), 8% clear
 *      space, capped master.
 *   4. Renditions (FR-10, FR-12), warnings (contract §6), presentation
 *      (FR-11) and the content version (FR-13).
 *
 * Steps 3–4 are in-repo integer code with a fixed PNG encoder, so the same
 * upload gives the same master, renditions and version.
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
import { LogoRejectedError, reject } from "./logo-refusal";
import { encodeBilevelPng, encodeRgbaPng, hasPngSignature, inspectPng } from "./png-codec";
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
import { rasterizeCheckedSvg } from "./svg-rasterize";
import { hasSvgSignature, scanSvg } from "./svg-scan";

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

async function rasterizeSvg(bytes: Buffer): Promise<Rgba> {
  return decodePng(await rasterizeCheckedSvg(scanSvg(bytes)));
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

async function decode(bytes: Buffer): Promise<Rgba> {
  if (hasPngSignature(bytes)) {
    inspectPng(bytes);
    return decodePng(bytes);
  }
  if (hasSvgSignature(bytes)) return rasterizeSvg(bytes);
  return reject("file_type_not_allowed");
}

/** Validates, normalizes and renders an upload; throws `LogoRejectedError` on a §5 refusal. */
export async function processLogo(bytes: Buffer): Promise<ProcessedLogo> {
  const raster = await decode(bytes);
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
