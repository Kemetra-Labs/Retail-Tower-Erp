import * as queries from "@/lib/tenant-branding-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-474 boundary. The logo page calls the four Console operations of the
 * tenant-branding contract through the generated client and nothing else: no POS
 * read, no hand-rolled fetch, no Authorization header, no ERP system. All image
 * validation is Backend-Core's. The previews are the server's renditions: the
 * only canvas use is a 1:1 copy of the decoded server PNG in RenditionCanvas;
 * nothing reads pixels back, re-encodes or filters them. Static scan, comments
 * stripped.
 */
const wrapperSrc = readSource("src/lib/tenant-branding-queries.ts");
const feature = sourcesUnder("src/branding");
const all = [wrapperSrc, ...feature.map((f) => f.src)];
const CANVAS_FILE = "src/branding/RenditionCanvas.tsx";

describe("tenant logo boundary (RT-474)", () => {
  test("exactly the four Console wrappers are exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "consoleDeleteTenantLogo",
      "consoleGetTenantLogo",
      "consolePreviewTenantLogo",
      "consolePutTenantLogo",
    ]);
  });

  test("the wrappers use the Console paths only, never the POS read", () => {
    expect(wrapperSrc).toContain('"/api/v1/tenants/{tenant_id}/logo"');
    expect(wrapperSrc).toContain('"/api/v1/tenants/{tenant_id}/logo/preview"');
    for (const src of all) expect(src).not.toMatch(/\/api\/pos\/|posGetTenantBranding/);
  });

  test("the feature calls the wrappers, never the generated client", () => {
    for (const { file, src } of feature) expect(src, file).not.toContain("@/generated/client");
  });

  test("no ERP system, no fetch, no Authorization header", () => {
    for (const src of all) {
      expect(src).not.toMatch(/frappe|\/api\/resource|\/api\/method/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/[Aa]uthorization\s*:/);
    }
  });

  test("no client-side image validation: no pixel, dimension or magic-byte checks", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /naturalWidth|naturalHeight|0x89|\\x89PNG|<svg|aspectRatio\s*[<>]/,
      );
    }
  });

  test("renditions are drawn 1:1 in one component and never read back or re-encoded", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(/getImageData|putImageData|toDataURL|toBlob\(|createObjectURL/);
      expect(src, file).not.toMatch(/\.filter\s*=|imageSmoothingEnabled\s*=\s*true/);
      expect(src, file).not.toMatch(/src=\{?["'`]data:|data:image/);
      if (!file.endsWith(CANVAS_FILE)) {
        expect(src, file).not.toMatch(/createImageBitmap|drawImage|getContext/);
      }
    }
    const canvas = readSource(CANVAS_FILE);
    // drawImage(bitmap, 0, 0): no destination size, so no resampling in the canvas.
    expect(canvas).toMatch(/drawImage\(\s*\w+\s*,\s*0\s*,\s*0\s*\)/);
    expect(canvas).not.toMatch(/drawImage\([^)]*,[^)]*,[^)]*,[^)]*\)/);
  });
});
