/**
 * RT-1337 — the Offer Pack ETag (`offers.openapi.yaml` `ETag`): the strong
 * SHA-256 of the canonical JSON (keys sorted, no whitespace) of the body
 * without `issuedAt`, so it changes when the Pack changes and never because
 * time passed.
 */
import { canonicalJson, packEtag, type OfferPackBody } from "../../src/offers/offer-pack.service";

const pack = (over: Partial<OfferPackBody> = {}): OfferPackBody => ({
  packRevision: 7,
  issuedAt: "2026-12-01T10:00:00.000Z",
  freshnessWindowHours: 24,
  storeTimezone: "Africa/Cairo",
  currencyCode: "EGP",
  offers: [],
  ...over,
});

describe("canonicalJson", () => {
  it("sorts keys at every depth, keeps array order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("packEtag", () => {
  it("is a quoted 64-hex strong ETag", () => {
    expect(packEtag(pack())).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("does not depend on issuedAt or on key order", () => {
    expect(packEtag(pack({ issuedAt: "2030-01-01T00:00:00.000Z" }))).toBe(packEtag(pack()));
    const reordered = JSON.parse(JSON.stringify({ offers: [], currencyCode: "EGP", storeTimezone: "Africa/Cairo", freshnessWindowHours: 24, issuedAt: "x", packRevision: 7 })) as OfferPackBody;
    expect(packEtag(reordered)).toBe(packEtag(pack()));
  });

  it.each([
    ["the revision", { packRevision: 8 }],
    ["the store's zone", { storeTimezone: "UTC" }],
    ["the freshness window", { freshnessWindowHours: 48 }],
    ["the currency", { currencyCode: "USD" }],
  ])("changes with %s", (_label, over) => {
    expect(packEtag(pack(over as Partial<OfferPackBody>))).not.toBe(packEtag(pack()));
  });
});
