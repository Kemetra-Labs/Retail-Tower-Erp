/**
 * The closed `422` refusal set of the tenant logo upload (contract §5,
 * `LogoRejectionCode` / `SvgUnsafeConstruct` in tenant-branding.openapi.yaml).
 */

export const LOGO_REJECTION_CODES = [
  "file_type_not_allowed",
  "image_malformed",
  "image_dimensions_too_large",
  "image_too_small",
  "aspect_ratio_out_of_range",
  "image_empty",
  "svg_unsafe_content",
  "svg_unsupported",
] as const;
export type LogoRejectionCode = (typeof LOGO_REJECTION_CODES)[number];

export const SVG_UNSAFE_CONSTRUCTS = [
  "script",
  "event_handler",
  "external_reference",
  "foreign_object",
  "embedded_content",
  "entity",
  "image_element",
  "css_import",
] as const;
export type SvgUnsafeConstruct = (typeof SVG_UNSAFE_CONSTRUCTS)[number];

/** Human-readable summaries. They never echo file content. */
export const REJECTION_MESSAGES: Readonly<Record<LogoRejectionCode, string>> = {
  file_type_not_allowed: "The file is neither a PNG nor an SVG.",
  image_malformed: "The image is damaged or not well-formed.",
  image_dimensions_too_large: "The image is larger than 4000 pixels on a side.",
  image_too_small: "The logo is too small: at least 512 × 512 for a square logo, or 256 pixels tall.",
  aspect_ratio_out_of_range: "The logo must be between 1:1 and 4:1 (width to height).",
  image_empty: "The image has no visible content.",
  svg_unsafe_content: "The SVG contains a construct that is not allowed.",
  svg_unsupported: "The SVG has no usable size or is too complex.",
};

/** An image or content-validation refusal (→ 422 with `error.code`). */
export class LogoRejectedError extends Error {
  constructor(
    readonly code: LogoRejectionCode,
    readonly construct: SvgUnsafeConstruct | null = null,
  ) {
    super(code);
    this.name = "LogoRejectedError";
  }
}

export function reject(code: LogoRejectionCode): never {
  throw new LogoRejectedError(code);
}

export function rejectUnsafe(construct: SvgUnsafeConstruct): never {
  throw new LogoRejectedError("svg_unsafe_content", construct);
}
