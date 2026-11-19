/**
 * RT-1484 (RT-282 PR-09a) — the pure parts of the Price Books and Zones runtime: request
 * schemas (against the contract's rules and the 0121 CHECKs), the projections (validated against
 * the contract schemas with AJV 2020-12) and the zone-stores keyset cursor. No DB, no HTTP.
 */
import "reflect-metadata";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import {
  CreatePriceBookBodySchema,
  CreatePriceZoneBodySchema,
  isRfc3339Instant,
  RetirePriceZoneBodySchema,
  StoreMembershipsQuerySchema,
  ZoneStoresQuerySchema,
} from "../../src/pricing/structure/price-structure.dto";
import {
  decodeZoneStoresCursor,
  encodeZoneStoresCursor,
  toMembershipBody,
  toPriceBookBody,
  toPriceZoneBody,
  ZoneStoresCursorError,
  type PriceBookRow,
  type PriceZoneRow,
} from "../../src/pricing/structure/price-structure.projections";
import { allContracts, contractDocument } from "../_helpers/openapi-contract";

const BOOK = "0192f000-0000-7000-8000-0000000b0001";
const ZONE = "0192f000-0000-7000-8000-0000000b0002";
const USER = "0192f000-0000-7000-8000-0000000b0003";
const STORE = "0192f000-0000-7000-8000-0000000b0004";
const AT = new Date("2026-11-19T10:00:00.000Z");

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
beforeAll(() => {
  ajv.addSchema(contractDocument(allContracts(), "price-structure") as object, "price-structure");
});
function expectSchema(name: string, body: unknown): void {
  const v = ajv.getSchema(`price-structure#/components/schemas/${name}`);
  if (!v) throw new Error(`no schema ${name}`);
  if (!v(body)) throw new Error(`${name}: ${JSON.stringify(v.errors)}`);
}

const zoneRow = (over: Partial<PriceZoneRow> = {}): PriceZoneRow => ({
  id: ZONE,
  price_book_id: BOOK,
  code: "DEFAULT",
  name: "Default",
  is_default: true,
  retired_at: null,
  retire_reason: null,
  created_by_user_id: USER,
  created_at: AT,
  ...over,
});
const bookRow: PriceBookRow = {
  id: BOOK,
  code: "RETAIL",
  name: "Retail",
  currency_code: "EGP",
  tax_price_basis: "inclusive",
  pricing_context: "retail",
  is_default: true,
  retired_at: null,
  created_by_user_id: USER,
  created_at: AT,
};

describe("price structure request schemas", () => {
  const book = { code: "RETAIL", name: "Retail", currencyCode: "EGP", taxPriceBasis: "inclusive" };

  it("accepts a contract-valid Book create, with or without a default Zone name", () => {
    expect(CreatePriceBookBodySchema.safeParse(book).success).toBe(true);
    expect(CreatePriceBookBodySchema.safeParse({ ...book, defaultZoneName: "Main" }).success).toBe(true);
  });

  it.each([
    ["a lower-case code", { ...book, code: "retail" }],
    ["a 33-character code", { ...book, code: "A".repeat(33) }],
    ["an empty name", { ...book, name: "" }],
    ["a 121-character name", { ...book, name: "n".repeat(121) }],
    ["a currency with no known minor unit", { ...book, currencyCode: "XXX" }],
    ["a lower-case currency", { ...book, currencyCode: "egp" }],
    ["an unknown tax-price basis", { ...book, taxPriceBasis: "gross" }],
    ["an unknown key", { ...book, isDefault: false }],
    ["a missing currency", { code: "R", name: "R", taxPriceBasis: "inclusive" }],
  ])("refuses %s", (_label, body) => {
    expect(CreatePriceBookBodySchema.safeParse(body).success).toBe(false);
  });

  it("Zone create and retire are strict and bounded", () => {
    expect(CreatePriceZoneBodySchema.safeParse({ code: "NORTH", name: "North" }).success).toBe(true);
    expect(CreatePriceZoneBodySchema.safeParse({ code: "NORTH", name: "North", isDefault: true }).success).toBe(false);
    expect(RetirePriceZoneBodySchema.safeParse({ reason: "r" }).success).toBe(true);
    expect(RetirePriceZoneBodySchema.safeParse({ reason: "" }).success).toBe(false);
    expect(RetirePriceZoneBodySchema.safeParse({ reason: "r".repeat(501) }).success).toBe(false);
    expect(RetirePriceZoneBodySchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["2026-11-19T10:00:00Z", true],
    ["2026-11-19T10:00:00.123456+02:00", true],
    ["2028-02-29T00:00:00Z", true],
    ["2026-02-29T00:00:00Z", false],
    ["2026-02-31T00:00:00Z", false],
    ["2026-11-19T24:00:00Z", false],
    ["2026-11-19T10:00:00", false],
    ["2026-11-19 10:00:00Z", false],
    ["2026-11-19T10:00:00.1234567Z", false],
  ])("`at` %s is valid: %s", (value, ok) => {
    expect(isRfc3339Instant(value)).toBe(ok);
  });

  it("parses the query parameters and refuses malformed ones", () => {
    expect(ZoneStoresQuerySchema.parse({ as_of_revision: "3", page_size: "200" })).toEqual({
      as_of_revision: 3,
      page_size: 200,
    });
    for (const bad of [{ as_of_revision: "0" }, { as_of_revision: "-1" }, { page_size: "0" }, { page_size: "201" }, { cursor: "a+b" }]) {
      expect(ZoneStoresQuerySchema.safeParse(bad).success).toBe(false);
    }
    expect(StoreMembershipsQuerySchema.safeParse({ as_of_revision: "x" }).success).toBe(false);
  });
});

describe("price structure projections", () => {
  it("a Book with its default Zone matches the contract's PriceBook", () => {
    const body = toPriceBookBody(bookRow, zoneRow());
    expectSchema("PriceBook", body);
    expect(body).toMatchObject({ currencyCode: "EGP", pricingContext: "retail", retiredAt: null, created: { userId: USER } });
    expectSchema("PriceBookList", { items: [body] });
    expectSchema("PriceBookDetail", { book: body, zones: [body.defaultZone] });
  });

  it("a retired Zone carries its instant and reason", () => {
    const body = toPriceZoneBody(
      zoneRow({ is_default: false, code: "NORTH", retired_at: AT, retire_reason: "merged" }),
    );
    expectSchema("PriceZone", body);
    expect(body).toMatchObject({ retiredAt: AT.toISOString(), retireReason: "merged", isDefault: false });
  });

  it("a membership row matches PriceZoneMembership, the revision as a number", () => {
    const body = toMembershipBody({
      id: ZONE,
      price_zone_id: ZONE,
      effective_from: AT,
      effective_to: null,
      published_in_revision: "7",
      carried_forward: false,
    });
    expectSchema("PriceZoneMembership", body);
    expect(body.publishedInRevision).toBe(7);
  });
});

describe("zone-stores cursor", () => {
  const cursor = { zoneId: ZONE, at: "2026-11-19T10:00:00.000000Z", revision: 4, after: STORE };

  it("round-trips and fits the contract's cursor pattern", () => {
    const raw = encodeZoneStoresCursor(cursor);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    expect(decodeZoneStoresCursor(raw, ZONE)).toEqual(cursor);
    expect(decodeZoneStoresCursor(encodeZoneStoresCursor({ ...cursor, revision: null }), ZONE).revision).toBeNull();
  });

  it("refuses a cursor of another Zone, a forged one and garbage", () => {
    const raw = encodeZoneStoresCursor(cursor);
    expect(() => decodeZoneStoresCursor(raw, BOOK)).toThrow(ZoneStoresCursorError);
    const forged = Buffer.from(JSON.stringify({ v: 1, z: ZONE, at: "now", r: 1, k: STORE })).toString("base64url");
    expect(() => decodeZoneStoresCursor(forged, ZONE)).toThrow(ZoneStoresCursorError);
    expect(() => decodeZoneStoresCursor("abc", ZONE)).toThrow(ZoneStoresCursorError);
  });
});
