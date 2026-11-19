/**
 * RT-1151 (RT-282 PR-07) — the captureSale line `pricingProvenance` boundary,
 * Docker-free (contract `pos-sales/sales.yaml` 1.25.0-draft
 * `CaptureSaleLine.pricingProvenance`, `PricingProvenance`).
 *
 *   - accepted on every capture schema, both variants, optional;
 *   - shape rules are 400: the discriminator, v1 enums (book/zone/store,
 *     regular; legacy_tenant/legacy_store), a uuid event id, a positive
 *     revision, a bounded cursor, no unknown key and no mixed variant;
 *   - a body without it hashes exactly as before; a body with it hashes
 *     differently, and so does any change to it (so a replay with a different
 *     provenance is an idempotency conflict, owner D3).
 */
import { sha256CanonicalHex } from "../../../../src/common/hashing/payload-hash";
import {
  CAPTURE_SCHEMA_VARIANTS,
  clearTenderFlags,
  expectCapture400 as expect400,
  parseCapture as parse,
} from "./__capture-dto-support";

const EVENT = "0192f000-0000-7000-8000-000000001151";

const PRICING = { origin: "pricing", sourceScope: "zone", priceEventId: EVENT, priceKind: "regular", pricingRevision: 418 };
const LEGACY = { origin: "legacy", sourceScope: "legacy_store", catalogCursor: "c:1042" };

function body(provenance?: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: "ext-rt1151-dto",
    currencyCode: "EGP",
    posTotal: "90.00",
    occurredAt: "2026-11-19T10:00:00.000Z",
    lines: [
      {
        lineName: "Panadol Extra 24",
        unitPrice: "45.00",
        currencyCode: "EGP",
        quantity: "2",
        lineAmount: "90.00",
        unit: "box",
        ...(provenance === undefined ? {} : { pricingProvenance: provenance }),
      },
    ],
  };
}

const lineOf = (parsed: Record<string, unknown>): Record<string, unknown> =>
  (parsed["lines"] as Array<Record<string, unknown>>)[0]!;

afterEach(clearTenderFlags);

describe("RT-1151 — pricingProvenance is accepted on every capture schema", () => {
  it.each(CAPTURE_SCHEMA_VARIANTS)("%s: both variants parse unchanged", (_name, env) => {
    Object.assign(process.env, env);
    expect(lineOf(parse(body(PRICING)))["pricingProvenance"]).toEqual(PRICING);
    expect(lineOf(parse(body(LEGACY)))["pricingProvenance"]).toEqual(LEGACY);
  });

  it("is optional: a line without it parses with no key", () => {
    expect(lineOf(parse(body()))).not.toHaveProperty("pricingProvenance");
  });

  it("normalizes the event id to lower case", () => {
    const parsed = parse(body({ ...PRICING, priceEventId: EVENT.toUpperCase() }));
    expect((lineOf(parsed)["pricingProvenance"] as Record<string, unknown>)["priceEventId"]).toBe(EVENT);
  });

  it.each(["book", "zone", "store"])("pricing sourceScope %p is accepted", (sourceScope) => {
    expect(() => parse(body({ ...PRICING, sourceScope }))).not.toThrow();
  });

  it.each(["legacy_tenant", "legacy_store"])("legacy sourceScope %p is accepted", (sourceScope) => {
    expect(() => parse(body({ ...LEGACY, sourceScope }))).not.toThrow();
  });
});

describe("RT-1151 — PricingProvenance shape rules (400 validation_error)", () => {
  it.each([
    ["an unknown origin", { ...PRICING, origin: "erp" }],
    ["a legacy scope on the pricing variant", { ...PRICING, sourceScope: "legacy_store" }],
    ["a pricing scope on the legacy variant", { ...LEGACY, sourceScope: "store" }],
    ["a price kind other than regular (v1)", { ...PRICING, priceKind: "clearance" }],
    ["a non-uuid event id", { ...PRICING, priceEventId: "evt-1" }],
    ["revision 0", { ...PRICING, pricingRevision: 0 }],
    ["a fractional revision", { ...PRICING, pricingRevision: 1.5 }],
    ["a string revision", { ...PRICING, pricingRevision: "418" }],
    ["a missing revision", { origin: "pricing", sourceScope: "book", priceEventId: EVENT, priceKind: "regular" }],
    ["an empty cursor", { ...LEGACY, catalogCursor: "" }],
    ["a 129-character cursor", { ...LEGACY, catalogCursor: "c".repeat(129) }],
    ["a NUL in the cursor", { ...LEGACY, catalogCursor: "c\u00001" }],
    ["a mixed variant (legacy with an event id)", { ...LEGACY, priceEventId: EVENT }],
    ["a mixed variant (pricing with a cursor)", { ...PRICING, catalogCursor: "c:1" }],
    ["an unknown key", { ...PRICING, price: "45.00" }],
    ["a non-object", "pricing"],
  ])("%s", (_name, provenance) => {
    expect400(body(provenance as Record<string, unknown>));
  });
});

describe("RT-1151 — pricingProvenance is part of the payload hash", () => {
  it("a body without it hashes as before; with it, and with any change to it, differently", () => {
    const plain = sha256CanonicalHex(parse(body()));
    const pricing = sha256CanonicalHex(parse(body(PRICING)));
    const changed = sha256CanonicalHex(parse(body({ ...PRICING, pricingRevision: 419 })));
    const legacy = sha256CanonicalHex(parse(body(LEGACY)));
    expect(new Set([plain, pricing, changed, legacy]).size).toBe(4);
    // Without it, the parsed body carries no key at all, so existing payload hashes are unchanged.
    expect(JSON.stringify(parse(body()))).not.toContain("pricingProvenance");
  });
});
