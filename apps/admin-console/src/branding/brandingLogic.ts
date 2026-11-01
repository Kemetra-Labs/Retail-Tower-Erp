/**
 * RT-474 pure logic for the tenant logo page. Nothing here validates an image:
 * Backend-Core decides (type by magic bytes, dimensions, aspect, SVG safety).
 * This module only maps the server's closed codes to message keys (UX-12.33),
 * classifies a response, and does the arithmetic the contract states for
 * showing the renditions truthfully.
 */
import type { MessageKey } from "@/i18n";
import type {
  LogoRejectionCode,
  LogoWarning,
  ReceiptRendition,
  ScreenRendition,
  ScreenSlot,
} from "@/lib/tenant-branding-queries";

/** The contract's upload bound: 1 MiB. Larger bodies get `413 file_too_large`. */
export const LOGO_MAX_BYTES = 1_048_576;

/** The closed 422 set (`LogoRejectionCode`, spec 039 contracts §5). */
export const LOGO_REFUSAL_CODES = [
  "file_type_not_allowed",
  "image_malformed",
  "image_dimensions_too_large",
  "image_too_small",
  "aspect_ratio_out_of_range",
  "image_empty",
  "svg_unsafe_content",
  "svg_unsupported",
] as const satisfies readonly LogoRejectionCode[];

/** The closed warning set (`LogoWarning`). Warnings never block saving. */
export const LOGO_WARNINGS = [
  "low_contrast",
  "receipt_high_black_coverage",
  "receipt_thin_strokes",
] as const satisfies readonly LogoWarning[];

/** The POS slots in the brief's preview order (largest box first). */
export const LOGO_SLOTS = [
  "boot",
  "pairing",
  "lock",
  "sign_in",
] as const satisfies readonly ScreenSlot[];

const REFUSAL_KEYS: Record<LogoRejectionCode, MessageKey> = {
  file_type_not_allowed: "branding.refusal.file_type_not_allowed",
  image_malformed: "branding.refusal.image_malformed",
  image_dimensions_too_large: "branding.refusal.image_dimensions_too_large",
  image_too_small: "branding.refusal.image_too_small",
  aspect_ratio_out_of_range: "branding.refusal.aspect_ratio_out_of_range",
  image_empty: "branding.refusal.image_empty",
  // One message for every `details.construct`; the construct is never shown.
  svg_unsafe_content: "branding.refusal.svg_unsafe_content",
  svg_unsupported: "branding.refusal.svg_unsupported",
};

const WARNING_KEYS: Record<LogoWarning, MessageKey> = {
  low_contrast: "branding.warning.low_contrast",
  receipt_high_black_coverage: "branding.warning.receipt_high_black_coverage",
  receipt_thin_strokes: "branding.warning.receipt_thin_strokes",
};

export function warningKey(warning: LogoWarning): MessageKey {
  return WARNING_KEYS[warning];
}

function isRefusalCode(code: unknown): code is LogoRejectionCode {
  return typeof code === "string" && Object.hasOwn(REFUSAL_KEYS, code);
}

/** One response of any of the four operations, as the page acts on it. */
export type BrandingOutcome<T> =
  | { kind: "ok"; data: T }
  /** Inline on the upload field; the current logo is unchanged. */
  | { kind: "refused"; messageKey: MessageKey }
  /** 409 `logo_changed_concurrently`: the revision moved since the page loaded. */
  | { kind: "conflict" }
  /** 429: the shared Retry-After clock already holds the wait (src/lib/rate-limit.ts). */
  | { kind: "rateLimited" }
  /** The non-disclosing 404: wrong role, another tenant or unknown tenant. */
  | { kind: "noAccess" }
  | { kind: "session" }
  /** 400, 403 `origin_rejected`, 500, or no answer: generic error with the request id. */
  | { kind: "failed"; status: number; requestId?: string };

interface Envelope {
  error?: { code?: unknown; request_id?: unknown };
}

function envelopeOf(error: unknown): Envelope["error"] {
  return (error as Envelope | undefined)?.error;
}

/** Classify a wrapper result. The server's `message` is never carried. */
export function classifyBrandingWrite<T>(res: {
  status: number;
  data?: T;
  error?: unknown;
}): BrandingOutcome<T> {
  const { status } = res;
  if (status >= 200 && status < 300 && res.data !== undefined)
    return { kind: "ok", data: res.data };
  const inner = envelopeOf(res.error);
  const code = inner?.code;
  if (status === 422) {
    return {
      kind: "refused",
      messageKey: isRefusalCode(code) ? REFUSAL_KEYS[code] : "branding.refusal.unknown",
    };
  }
  if (status === 413) return { kind: "refused", messageKey: "branding.refusal.file_too_large" };
  if (status === 409 && code === "logo_preview_mismatch") {
    return { kind: "refused", messageKey: "branding.refusal.logo_preview_mismatch" };
  }
  if (status === 409) return { kind: "conflict" };
  if (status === 429) return { kind: "rateLimited" };
  if (status === 404) return { kind: "noAccess" };
  if (status === 401) return { kind: "session" };
  const requestId = typeof inner?.request_id === "string" ? inner.request_id : undefined;
  return { kind: "failed", status, ...(requestId ? { requestId } : {}) };
}

/**
 * Fast feedback before the upload: only the size, against the exact server
 * bound. The type is not pre-checked, because the server decides it by magic
 * bytes and a correct file with an odd extension or MIME type is accepted.
 */
export function precheckLogoFile(file: { size: number }): MessageKey | undefined {
  return file.size > LOGO_MAX_BYTES ? "branding.refusal.file_too_large" : undefined;
}

/** The printed size the contract states: `width_px / dpi × 25.4` mm. */
export function receiptSizeMm(receipt: ReceiptRendition): { widthMm: number; heightMm: number } {
  return {
    widthMm: (receipt.width_px / receipt.dpi) * 25.4,
    heightMm: (receipt.height_px / receipt.dpi) * 25.4,
  };
}

export function renditionFor(
  screen: readonly ScreenRendition[],
  slot: ScreenSlot,
  scale: 1 | 2,
): ScreenRendition | undefined {
  return screen.find((r) => r.slot === slot && r.scale === scale);
}

/** The rendition a browser `srcset` with 1x and 2x candidates would pick. */
export function scaleForPixelRatio(ratio: number): 1 | 2 {
  return ratio > 1 ? 2 : 1;
}
