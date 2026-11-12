import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as brandQueries from "@/lib/brand-queries";
import * as offerQueries from "@/lib/offer-queries";
import { describe, expect, test } from "vitest";

/**
 * RT-1338 boundary. The offers and brands screens call Backend-Core only, through the generated-client
 * wrappers of `offers.openapi.yaml` and the brand operations of `console-catalog.yaml`. They hold no
 * hand-rolled fetch, no browser storage, no ERP or Frappe call, and no evaluation logic: the Console is
 * a control surface (spec 048 §10), and Backend-Core is the authority for the eligible set, conflicts,
 * the simulation and the Offer Pack.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}
const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
const sourceOf = (dir: string) =>
  filesUnder(join(process.cwd(), dir))
    .map((f) => stripComments(readFileSync(f, "utf8")))
    .join("\n");

const offerSrc = sourceOf("src/offers");
const brandSrc = sourceOf("src/brands");

describe("offer wrappers", () => {
  test("exactly the ten Console operations are wrapped; the POS pack read is not", () => {
    const wrapped = Object.keys(offerQueries).filter((k) => /^console[A-Z]/.test(k));
    expect(wrapped.sort()).toEqual([
      "consoleArchiveOffer",
      "consoleCreateOfferDraft",
      "consoleEndOffer",
      "consoleGetOffer",
      "consoleListOfferVersions",
      "consoleListOffers",
      "consolePauseOffer",
      "consolePreviewOffer",
      "consolePublishOffer",
      "consoleResumeOffer",
      "consoleUpdateOfferDraft",
    ]);
    expect(read("src/lib/offer-queries.ts")).not.toContain("offer-pack");
  });

  test("they call the generated offer paths, never a hand-rolled fetch", () => {
    const src = read("src/lib/offer-queries.ts");
    for (const path of [
      '"/api/v1/offers"',
      '"/api/v1/offers/{offer_id}"',
      '"/api/v1/offers/{offer_id}/draft"',
      '"/api/v1/offers/{offer_id}/preview"',
      '"/api/v1/offers/{offer_id}/publish"',
      '"/api/v1/offers/{offer_id}/pause"',
      '"/api/v1/offers/{offer_id}/resume"',
      '"/api/v1/offers/{offer_id}/end"',
      '"/api/v1/offers/{offer_id}/archive"',
      '"/api/v1/offers/{offer_id}/versions"',
    ]) {
      expect(src).toContain(path);
    }
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });

  test("every write but the preview sends an Idempotency-Key", () => {
    const src = read("src/lib/offer-queries.ts");
    expect(src.match(/"Idempotency-Key"/g)?.length).toBe(7);
  });
});

describe("brand wrappers", () => {
  test("the three brand operations, on the generated brand paths", () => {
    expect(Object.keys(brandQueries).sort()).toEqual([
      "consoleCreateCatalogBrand",
      "consoleListCatalogBrands",
      "consoleRenameCatalogBrand",
    ]);
    const src = read("src/lib/brand-queries.ts");
    expect(src).toContain('"/api/v1/catalog/brands"');
    expect(src).toContain('"/api/v1/catalog/brands/{brandId}"');
    expect(src).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("the screens' own code", () => {
  test("reaches Backend-Core only through the wrappers, and never ERPNext", () => {
    for (const src of [offerSrc, brandSrc]) {
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/XMLHttpRequest|axios/);
      expect(src).not.toMatch(/\/api\/resource|\/api\/method|frappe|erpnext/i);
      expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });

  test("calls only the offers and brands wrappers (plus the catalog reads the pickers need)", () => {
    const names = new Set(`${offerSrc}\n${brandSrc}`.match(/\bconsole[A-Z]\w+(?=\()/g) ?? []);
    expect([...names].sort()).toEqual([
      "consoleArchiveOffer",
      "consoleCreateCatalogBrand",
      "consoleCreateOfferDraft",
      "consoleEndOffer",
      "consoleGetCatalogProduct",
      "consoleGetOffer",
      "consoleListCatalogBrands",
      "consoleListOfferVersions",
      "consoleListOffers",
      "consolePauseOffer",
      "consolePreviewOffer",
      "consolePublishOffer",
      "consoleRenameCatalogBrand",
      "consoleResumeOffer",
      "consoleUpdateOfferDraft",
    ]);
  });

  test("holds no evaluation logic: no eligible-set, price or discount arithmetic in the Console", () => {
    expect(offerSrc).not.toMatch(/Math\.(round|floor|ceil)|parseFloat|toFixed/);
    expect(offerSrc).not.toMatch(/eligibleProductIds|packRevision|resolveEligib|computeEligib/);
  });
});
