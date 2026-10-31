/**
 * Response bodies of tenant-branding.openapi.yaml: explicit projections,
 * never DB rows (§IV). Rendition bytes are base64 of server re-encoded PNGs.
 */
import { createHash } from "node:crypto";

import type { Scale, Slot } from "./logo-config";
import type { LogoWarning, ProcessedLogo } from "./logo-pipeline";

export interface ScreenRenditionBody {
  readonly slot: Slot;
  readonly scale: Scale;
  readonly width_px: number;
  readonly height_px: number;
  readonly png_base64: string;
}

export interface ReceiptRenditionBody {
  readonly width_px: number;
  readonly height_px: number;
  readonly dpi: number;
  readonly png_base64: string;
}

export interface LogoPreviewBody {
  readonly version: string;
  readonly presentation: { readonly card: boolean };
  readonly warnings: readonly LogoWarning[];
  readonly screen: readonly ScreenRenditionBody[];
  readonly receipt: ReceiptRenditionBody;
}

export interface TenantLogoBody extends LogoPreviewBody {
  readonly updated_at: string;
}

export interface TenantBrandingBody {
  readonly tenant_display_name: string;
  readonly revision: number;
  readonly logo: TenantLogoBody | null;
}

/** A stored logo as the repository reads it (renditions in contract order). */
export interface StoredLogo {
  readonly version: string;
  readonly presentationCard: boolean;
  readonly warnings: readonly LogoWarning[];
  readonly updatedAt: Date;
  readonly screen: ReadonlyArray<{ slot: Slot; scale: Scale; width: number; height: number; png: Buffer }>;
  readonly receipt: { width: number; height: number; dpi: number; png: Buffer };
}

function renditions(logo: Pick<StoredLogo, "screen" | "receipt">): Pick<LogoPreviewBody, "screen" | "receipt"> {
  return {
    screen: logo.screen.map((s) => ({
      slot: s.slot,
      scale: s.scale,
      width_px: s.width,
      height_px: s.height,
      png_base64: s.png.toString("base64"),
    })),
    receipt: {
      width_px: logo.receipt.width,
      height_px: logo.receipt.height,
      dpi: logo.receipt.dpi,
      png_base64: logo.receipt.png.toString("base64"),
    },
  };
}

export function toPreviewBody(logo: ProcessedLogo): LogoPreviewBody {
  return {
    version: logo.version,
    presentation: { card: logo.presentationCard },
    warnings: [...logo.warnings],
    ...renditions(logo),
  };
}

export function toBrandingBody(name: string, revision: number, logo: StoredLogo | null): TenantBrandingBody {
  return {
    tenant_display_name: name,
    revision,
    logo:
      logo === null
        ? null
        : {
            version: logo.version,
            presentation: { card: logo.presentationCard },
            warnings: [...logo.warnings],
            ...renditions(logo),
            updated_at: logo.updatedAt.toISOString(),
          },
  };
}

/** FR-18: `"` + hex SHA-256 of UTF8(tenant_display_name) 0x00 ASCII(decimal revision) + `"`. */
export function brandingEtag(name: string, revision: number): string {
  const input = Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([0]), Buffer.from(String(revision), "ascii")]);
  return `"${createHash("sha256").update(input).digest("hex")}"`;
}
