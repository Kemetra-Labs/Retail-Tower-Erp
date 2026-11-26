/**
 * RT-1151 (RT-282 PR-07) — `pos-sales/sales.yaml` 1.25.0-draft: the optional
 * `CaptureSaleLine.pricingProvenance` and the `PricingProvenance` union.
 * `[GATED: contract, migration]`, owner authorization on RT-1151 (D1, D3, D4,
 * comment 17783). Structural / load-only plus AJV fixtures; no app boot.
 *
 * Pins:
 *   1. the version and the info note (verbatim storage, never refused,
 *      migration 0122, not echoed, `pricingCapture` / `pricingContext` left to
 *      RT-1486);
 *   2. the line property is optional and references the union;
 *   3. the union has the SAME wire shape as the copy in
 *      `pricing/price-inquiry.yaml` (contracts are self-contained files);
 *   4. no response schema echoes it;
 *   5. the strict capture DTO and the contract agree on the variants.
 */
import "reflect-metadata";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { CaptureSaleLinePricingProvenanceSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { allContracts, contractDocument, contractReader, type ContractReader, type OpenApiDocument } from "../../../_helpers/openapi-contract";

let sales: OpenApiDocument;
let salesApi: ContractReader;
let inquiryApi: ContractReader;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  sales = contractDocument(contracts, "sales");
  salesApi = contractReader(sales);
  inquiryApi = contractReader(contractDocument(contracts, "price-inquiry"));
  ajv.addSchema(sales as object, "sales");
});

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`sales#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const flat = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ");
const EVENT = "0192f000-0000-7000-8000-000000001151";
const PRICING = { origin: "pricing", sourceScope: "store", priceEventId: EVENT, priceKind: "regular", pricingRevision: 7 };
const LEGACY = { origin: "legacy", sourceScope: "legacy_tenant", catalogCursor: "c:9" };

describe("pos-sales/sales.yaml — RT-1151 sale-line pricing provenance", () => {
  it("bumped to 1.25.0-draft (since 1.26.0-draft, RT-1403, 1.27.0-draft, RT-1544, 1.28.0-draft, RT-1548, 1.29.0-draft, RT-1565, and 1.30.0-draft, RT-1571) with a note citing the owner decisions, the storage rule and migration 0122", () => {
    const info = sales as unknown as { info: { version: string; description: string } };
    expect(info.info.version).toBe("1.30.0-draft");
    const note = flat(info.info.description);
    expect(note).toContain("RT-1151 (1.25.0-draft; [GATED: contract, migration] owner authorization on RT-1151");
    expect(note).toContain("never recomputes or checks it against the price");
    expect(note).toContain("Migration 0122 (`sale_line_pricing_provenance`)");
    expect(note).toContain("NOT echoed in any response");
    expect(note).toContain("`pricingCapture` / `pricingContext` (spec 043 G4-11) are RT-1486's (D4)");
  });

  it("CaptureSaleLine.pricingProvenance is optional and references the union", () => {
    const line = salesApi.schema("CaptureSaleLine");
    const props = line["properties"] as Record<string, { $ref?: string }>;
    expect(props["pricingProvenance"]).toEqual({ $ref: "#/components/schemas/PricingProvenance" });
    expect(line.required ?? []).not.toContain("pricingProvenance");
  });

  it.each(["PricingProvenance", "PricingProvenancePricing", "PricingProvenanceLegacy"])(
    "%s has the same wire shape as pricing/price-inquiry.yaml",
    (name) => {
      const strip = (v: unknown): unknown => {
        const shaped = v as Record<string, unknown>;
        // `x-shared-with` names the other copies, so it legitimately differs per file.
        const { ["x-shared-with"]: _shared, ...rest } = shaped;
        return rest;
      };
      expect(strip(salesApi.shape(salesApi.schema(name)))).toEqual(strip(inquiryApi.shape(inquiryApi.schema(name))));
    },
  );

  it("no response schema echoes it", () => {
    const text = JSON.stringify(sales.components?.schemas ?? {});
    const references = text.match(/#\/components\/schemas\/PricingProvenance(Pricing|Legacy)?"/g) ?? [];
    // The union once, by the request line only; each variant twice, both inside the union (oneOf + discriminator mapping).
    expect(references.sort()).toEqual([
      "#/components/schemas/PricingProvenance\"",
      "#/components/schemas/PricingProvenanceLegacy\"",
      "#/components/schemas/PricingProvenanceLegacy\"",
      "#/components/schemas/PricingProvenancePricing\"",
      "#/components/schemas/PricingProvenancePricing\"",
    ]);
  });

  it("the contract and the strict capture DTO accept and refuse the same variants", () => {
    const v = validator("PricingProvenance");
    const cases: ReadonlyArray<[unknown, boolean]> = [
      [PRICING, true],
      [LEGACY, true],
      [{ ...PRICING, sourceScope: "legacy_store" }, false],
      [{ ...LEGACY, priceEventId: EVENT }, false],
      [{ ...PRICING, pricingRevision: 0 }, false],
      [{ ...PRICING, priceKind: "clearance" }, false],
      [{ origin: "pricing", sourceScope: "book" }, false],
      [{ ...LEGACY, catalogCursor: "" }, false],
    ];
    for (const [value, ok] of cases) {
      expect([value, v(value)]).toEqual([value, ok]);
      expect([value, CaptureSaleLinePricingProvenanceSchema.safeParse(value).success]).toEqual([value, ok]);
    }
  });
});
