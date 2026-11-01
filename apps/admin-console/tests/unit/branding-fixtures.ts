/**
 * RT-474 fixtures: v0.3.3 tenant-branding shapes (contract 1.1.0-draft). The
 * PNG bytes are a 1×1 image; the canvas is stubbed in the unit suite, so only
 * the declared sizes matter.
 */
import type { LogoPreview, ScreenRendition, TenantBranding } from "@/lib/tenant-branding-queries";

export const TENANT_ID = "0190f000-0000-7000-8000-0000000000a1";
export const REQUEST_ID = "0190f000-0000-7000-8000-00000000beef";
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X8Zl0AAAAASUVORK5CYII=";

export const VERSION_A = "a".repeat(64);
export const VERSION_B = "b".repeat(64);

const BOXES = {
  boot: [240, 120],
  pairing: [200, 80],
  sign_in: [128, 32],
  lock: [200, 80],
} as const;

/** The 8 renditions of a 4:1 logo, contain-fitted inside each box × scale. */
export function screenSet(): ScreenRendition[] {
  return (Object.keys(BOXES) as (keyof typeof BOXES)[]).flatMap((slot) =>
    ([1, 2] as const).map((scale) => {
      const [w, h] = BOXES[slot];
      const width = Math.min(w, h * 4) * scale;
      return { slot, scale, width_px: width, height_px: width / 4, png_base64: PNG_1X1 };
    }),
  );
}

export function preview(overrides: Partial<LogoPreview> = {}): LogoPreview {
  return {
    version: VERSION_B,
    presentation: { card: false },
    warnings: [],
    screen: screenSet(),
    receipt: { width_px: 297, height_px: 74, dpi: 203, png_base64: PNG_1X1 },
    ...overrides,
  };
}

export function brandingWithLogo(revision = 3): TenantBranding {
  return {
    tenant_display_name: "النخبة للتجزئة",
    revision,
    logo: {
      ...preview({ version: VERSION_A }),
      updated_at: "2026-10-12T12:05:00Z",
    },
  };
}

export function brandingEmpty(revision = 0): TenantBranding {
  return { tenant_display_name: "النخبة للتجزئة", revision, logo: null };
}

export function refusal(status: number, code: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    error: {
      error: { code, message: "server text never shown", request_id: REQUEST_ID, ...extra },
    },
  };
}

export function pngFile(name = "logo.png", size = 2048): File {
  const file = new File([new Uint8Array(8)], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}
