/**
 * The tenant logo pipeline configuration (RT-473 S2, spec 039).
 *
 * The content `version` (FR-13) is SHA-256 over the master PNG,
 * `PIPELINE_VERSION` and `CANONICAL_RENDITION_CONFIG`. The values that shape
 * the output are in that config, so changing one changes every new version;
 * bump `PIPELINE_VERSION` for any other pipeline change that can alter the
 * output (the request limits below do not).
 * Logos stored before such a change keep their old renditions and version;
 * re-rendering them is the OD-8 re-render job (not shipped in S2).
 *
 *   - Slot boxes (OD-7): owner sign-off 2026-10-23, RT-473 comment 13662 /
 *     RT-832 comment 13661. CSS px, the 8% clear space included.
 *   - Receipt (OD-8): owner decision 2026-10-31 accepting the Windows driver
 *     reading (RT-473 comments 14342, 14883): BIXOLON SRP-B300, 203 dpi,
 *     576-dot line. The rendition bound is 48 × 15 mm at that dpi.
 */

/** Bumped whenever the pipeline's output for the same input can change. */
export const PIPELINE_VERSION = "rt473-s2.1";

/** FR-04: the upload cap, enforced while streaming, before any parsing. */
export const MAX_UPLOAD_BYTES = 1024 * 1024;

/** FR-05: either side of the raw image, and the pixel count, checked from the header. */
export const MAX_SIDE_PX = 4000;
export const MAX_PIXELS = MAX_SIDE_PX * MAX_SIDE_PX;

/** FR-09 (OD-4) on the trimmed content box. Square-ish = aspect below 1.25 (width × 4 < height × 5). */
export const MIN_SQUARE_SIDE_PX = 512;
export const MIN_HORIZONTAL_HEIGHT_PX = 256;
/** Aspect (width ÷ height) must lie in [1, 4]. */
export const MAX_ASPECT = 4;

/**
 * FR-08 clear space: 8% of the content width on the left and right, 8% of its
 * height on the top and bottom. Per-axis keeps the content aspect, which is
 * what the RT-832 fit table assumes (a 4:1 logo fills 240 × 60 of the boot box).
 */
export const CLEAR_SPACE_PERCENT = 8;

/**
 * Trim: an opaque image's margin is the top-left colour, within this
 * per-channel tolerance; a non-opaque image's margin is alpha 0.
 */
export const TRIM_TOLERANCE = 10;

/**
 * The stored master is capped to this box (area-averaged, never upscaled).
 * The largest consumer is the 2x boot rendition (480 × 240), so the cap
 * loses nothing and bounds the stored bytes and the per-request work.
 */
export const MASTER_MAX_SIDE_PX = 1024;

/**
 * A rasterized SVG's fixed height (FR-09), width-capped at MAX_SIDE_PX. The
 * FR-09 size minimum is still checked on the trimmed box, so an SVG whose
 * content fills only a corner of its canvas is `image_too_small`.
 */
export const SVG_RASTER_HEIGHT_PX = 960;

/** FR-07 rasterizer limits (`svg_unsupported`). */
export const SVG_MAX_ELEMENTS = 5000;
export const SVG_MAX_DEPTH = 64;
/** Nodes the rasterizer may visit once fragment references are expanded (`<use>` / pattern fan-out). */
export const SVG_MAX_EXPANDED_NODES = 2_000;
/** `feTurbulence` work is pixels × octaves. */
export const SVG_MAX_TURBULENCE_OCTAVES = 10;
/** The rasterizer child is killed after this; the upload is `svg_unsupported`. */
export const SVG_RENDER_TIMEOUT_MS = 8_000;
/** Renders running or waiting per API process; one more gets a retryable 429, so a wait is at most this × the timeout. */
export const SVG_MAX_PENDING_RENDERS = 4;
/**
 * RT-1041: logo jobs (decode and render in the logo worker) running or
 * waiting per API process; one more gets the same retryable 429. Only the
 * running job holds pixels: the decoded raster, its padded copy and the
 * master, about 150 MB at MAX_PIXELS.
 */
export const LOGO_MAX_PENDING_JOBS = 4;
/** A worker job with no reply by then is failed (→ 500) and its worker replaced, so a lost reply cannot hold the queue. */
export const LOGO_JOB_TIMEOUT_MS = 30_000;

export const SLOTS = ["boot", "pairing", "sign_in", "lock"] as const;
export type Slot = (typeof SLOTS)[number];
export const SCALES = [1, 2] as const;
export type Scale = (typeof SCALES)[number];

/** OD-7 slot boxes, CSS px at 1x. */
export const SLOT_BOXES: Readonly<Record<Slot, { readonly width: number; readonly height: number }>> = {
  boot: { width: 240, height: 120 },
  pairing: { width: 200, height: 80 },
  sign_in: { width: 128, height: 32 },
  lock: { width: 200, height: 80 },
};

/** OD-8. */
export const RECEIPT_DPI = 203;
export const RECEIPT_MAX_WIDTH_MM = 48;
export const RECEIPT_MAX_HEIGHT_MM = 15;
/** `floor(mm / 25.4 × dpi)`, in integers: floor(mm × dpi × 10 / 254). */
export const RECEIPT_MAX_W_PX = Math.floor((RECEIPT_MAX_WIDTH_MM * RECEIPT_DPI * 10) / 254);
export const RECEIPT_MAX_H_PX = Math.floor((RECEIPT_MAX_HEIGHT_MM * RECEIPT_DPI * 10) / 254);

/** Contract §6 warning thresholds. */
export const LOW_CONTRAST_MIN_RATIO = 3;
export const INK_ALPHA_MIN = 128;
export const RECEIPT_BLACK_COVERAGE_MAX_PERCENT = 35;
export const RECEIPT_THIN_MAX_PERCENT = 10;

/**
 * The canonical rendition configuration hashed into `version` (FR-13):
 * a fixed key order and no whitespace. The master PNG's deflate bytes come
 * from Node's bundled zlib, so its version is part of the input too: a Node
 * upgrade that could change those bytes changes the version visibly instead
 * of silently.
 */
export const CANONICAL_RENDITION_CONFIG = JSON.stringify({
  clear_space_percent: CLEAR_SPACE_PERCENT,
  deflate: `zlib-${process.versions.zlib}`,
  master_max_side_px: MASTER_MAX_SIDE_PX,
  receipt: { dpi: RECEIPT_DPI, max_height_px: RECEIPT_MAX_H_PX, max_width_px: RECEIPT_MAX_W_PX },
  slots: SLOTS.map((slot) => ({ slot, width: SLOT_BOXES[slot].width, height: SLOT_BOXES[slot].height })),
  scales: SCALES,
  trim_tolerance: TRIM_TOLERANCE,
  warnings: {
    ink_alpha_min: INK_ALPHA_MIN,
    low_contrast_min_ratio: LOW_CONTRAST_MIN_RATIO,
    receipt_black_coverage_max_percent: RECEIPT_BLACK_COVERAGE_MAX_PERCENT,
    receipt_thin_max_percent: RECEIPT_THIN_MAX_PERCENT,
  },
});
