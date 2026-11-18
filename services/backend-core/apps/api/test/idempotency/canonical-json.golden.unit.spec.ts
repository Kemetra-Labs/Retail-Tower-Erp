/**
 * Golden bytes for the idempotency canonical JSON (sonar S2871 remediation).
 *
 * The serialized string and its sha256 are persisted as idempotency
 * fingerprints, so the key order must never change. The pinned fixture and
 * literals live in `_helpers/canonical-json-golden.ts`.
 */
import { createHash } from "node:crypto";

import { canonicalInstant as revisionInstant, canonicalRevisionJson as revisionJson } from "../../src/ai-entitlements/revision-content";
import { canonicalJson } from "../../src/common/hashing/canonical-json";
import { canonicalJsonPayload } from "../../src/common/hashing/payload-hash";
import { countBody, payloadHash as countPayloadHash } from "../../src/inventory/count-sessions/count-emission";
import { packEtag, type OfferPackBody } from "../../src/offers/offer-pack.service";
import { canonicalInstant as shiftInstant } from "../../src/pos-shifts/shift-money";
import { bodyFingerprint } from "../../src/idempotency/idempotency.interceptor";
import {
  GOLDEN_FIXTURE,
  GOLDEN_SHA256_HEX,
  GOLDEN_STRING,
} from "../_helpers/canonical-json-golden";
import { legacyCountCanonicalJson as countJson, legacyOfferCanonicalJson as offerJson } from "../_helpers/canonical-json-legacy";

describe("idempotency canonicalJson golden bytes", () => {
  it("pins the literal's sha256 (guards the golden constants themselves)", () => {
    expect(createHash("sha256").update(GOLDEN_STRING).digest("hex")).toBe(GOLDEN_SHA256_HEX);
  });

  it("serializes the fixture to the exact golden string", () => {
    expect(canonicalJson(GOLDEN_FIXTURE)).toBe(GOLDEN_STRING);
  });

  it("stores the exact golden fingerprint bytes", () => {
    expect(bodyFingerprint(GOLDEN_FIXTURE).toString("hex")).toBe(GOLDEN_SHA256_HEX);
  });
});

/**
 * RT-1456 A-09, golden vectors across every canonical-JSON copy in apps/api.
 *
 * Written BEFORE the copies were folded, against the five functions as they stood:
 * idempotency `canonicalJson`, payload-hash `canonicalJsonPayload`, count-emission
 * `canonicalJson`, offer-pack `canonicalJson`, ai-entitlements `canonicalJson`.
 * Every persisted hash (payload_hash, request_hash, ETags, count payloadHash) comes
 * from one of them. On JSON-shaped values all five give the same bytes; they differ
 * only on `undefined` and `Date`, which the pinned rows below record exactly.
 * `null` in the revision column = not applicable (that copy is typed to Json values).
 */
type Row = [
  name: string,
  idempotency: string | undefined,
  payload: string | undefined,
  count: string | undefined,
  offerPack: string | undefined,
  revision: string | null,
];

const VALUES: ReadonlyArray<() => unknown> = [
  () => ({ b: [3, { z: 1, y: [] }, "x"], a: { d: null, c: true }, "": 0 }),
  () => ({ s: 'q"\\\n\u2028é', n: [0, -1, 1.5, 1e21, 0.1], t: false, z: null }),
  () => ({ "\uFF5E": 1, "\u{1F600}": 2, B: 3, a: 4, "10": 5, "9": 6 }),
  () => ({ "ключ": 1, "مفتاح": 2, "键": 3 }),
  () => ({ o: {}, a: [], n: [[], {}] }),
  () => ({ a: 1, u: undefined, b: { v: undefined } }),
  () => [1, undefined, 2],
  () => undefined,
  () => ({ when: new Date("2026-11-18T10:00:00.123Z") }),
];

const ROWS: Row[] = [
  ["nested objects and arrays, unsorted keys", "{\"\":0,\"a\":{\"c\":true,\"d\":null},\"b\":[3,{\"y\":[],\"z\":1},\"x\"]}", "{\"\":0,\"a\":{\"c\":true,\"d\":null},\"b\":[3,{\"y\":[],\"z\":1},\"x\"]}", "{\"\":0,\"a\":{\"c\":true,\"d\":null},\"b\":[3,{\"y\":[],\"z\":1},\"x\"]}", "{\"\":0,\"a\":{\"c\":true,\"d\":null},\"b\":[3,{\"y\":[],\"z\":1},\"x\"]}", "{\"\":0,\"a\":{\"c\":true,\"d\":null},\"b\":[3,{\"y\":[],\"z\":1},\"x\"]}"],
  ["scalars and escapes", "{\"n\":[0,-1,1.5,1e+21,0.1],\"s\":\"q\\\"\\\\\\n é\",\"t\":false,\"z\":null}", "{\"n\":[0,-1,1.5,1e+21,0.1],\"s\":\"q\\\"\\\\\\n é\",\"t\":false,\"z\":null}", "{\"n\":[0,-1,1.5,1e+21,0.1],\"s\":\"q\\\"\\\\\\n é\",\"t\":false,\"z\":null}", "{\"n\":[0,-1,1.5,1e+21,0.1],\"s\":\"q\\\"\\\\\\n é\",\"t\":false,\"z\":null}", "{\"n\":[0,-1,1.5,1e+21,0.1],\"s\":\"q\\\"\\\\\\n é\",\"t\":false,\"z\":null}"],
  ["code-unit key order (astral vs BMP, case, digits)", "{\"10\":5,\"9\":6,\"B\":3,\"a\":4,\"😀\":2,\"～\":1}", "{\"10\":5,\"9\":6,\"B\":3,\"a\":4,\"😀\":2,\"～\":1}", "{\"10\":5,\"9\":6,\"B\":3,\"a\":4,\"😀\":2,\"～\":1}", "{\"10\":5,\"9\":6,\"B\":3,\"a\":4,\"😀\":2,\"～\":1}", "{\"10\":5,\"9\":6,\"B\":3,\"a\":4,\"😀\":2,\"～\":1}"],
  ["non-ASCII keys", "{\"ключ\":1,\"مفتاح\":2,\"键\":3}", "{\"ключ\":1,\"مفتاح\":2,\"键\":3}", "{\"ключ\":1,\"مفتاح\":2,\"键\":3}", "{\"ключ\":1,\"مفتاح\":2,\"键\":3}", "{\"ключ\":1,\"مفتاح\":2,\"键\":3}"],
  ["empty containers", "{\"a\":[],\"n\":[[],{}],\"o\":{}}", "{\"a\":[],\"n\":[[],{}],\"o\":{}}", "{\"a\":[],\"n\":[[],{}],\"o\":{}}", "{\"a\":[],\"n\":[[],{}],\"o\":{}}", "{\"a\":[],\"n\":[[],{}],\"o\":{}}"],
  ["undefined object value", "{\"a\":1,\"b\":{}}", "{\"a\":1,\"b\":{\"v\":null},\"u\":null}", "{\"a\":1,\"b\":{\"v\":undefined},\"u\":undefined}", "{\"a\":1,\"b\":{}}", null],
  ["undefined array element", "[1,null,2]", "[1,null,2]", "[1,,2]", "[1,,2]", null],
  ["top-level undefined", "null", "null", undefined, undefined, null],
  ["Date value", "{\"when\":\"2026-11-18T10:00:00.123Z\"}", "{\"when\":{}}", "{\"when\":{}}", "{\"when\":{}}", null]
];

describe("RT-1456 A-09 golden vectors: every canonical-JSON copy, pinned byte for byte", () => {
  it("has one row per value", () => {
    expect(ROWS).toHaveLength(VALUES.length);
  });

  it.each(ROWS.map((r, i) => [r[0], i] as const))("%s", (_name, i) => {
    const [, idempotency, payload, count, offerPack, revision] = ROWS[i]!;
    const value = VALUES[i]!();
    expect(canonicalJson(value)).toBe(idempotency);
    expect(canonicalJsonPayload(value)).toBe(payload);
    expect(countJson(value)).toBe(count);
    expect(offerJson(value)).toBe(offerPack);
    if (revision !== null) expect(revisionJson(value as never)).toBe(revision);
  });

  it("agrees on every JSON-shaped value (the rows without undefined or Date)", () => {
    for (const [name, idempotency, payload, count, offerPack, revision] of ROWS.slice(0, 5)) {
      expect([name, payload, count, offerPack, revision]).toEqual([name, idempotency, idempotency, idempotency, idempotency]);
    }
  });
});

describe("RT-1456 A-09 caller payloads: the persisted bytes", () => {
  const COUNT_CANON = "{\"chunk\":1,\"chunkCount\":1,\"countSessionRef\":\"6f1c2b9e-0a53-4a77-9d0e-1a2b3c4d5e6f\",\"lines\":[{\"countedQuantity\":\"12.500000\",\"erpnextItemRef\":{\"doctype\":\"Item\",\"name\":\"ITEM-0001\"},\"lineSeq\":1,\"unit\":\"Nos\",\"warehouseRef\":{\"doctype\":\"Warehouse\",\"name\":\"Stores - RT\"}},{\"countedQuantity\":\"0\",\"erpnextItemRef\":{\"doctype\":\"Item\",\"name\":\"ITEM-0002\"},\"lineSeq\":2,\"unit\":\"Kg\",\"warehouseRef\":{\"doctype\":\"Warehouse\",\"name\":\"Stores - RT\"}}],\"mappingBucketRef\":\"store-cairo-01:stock\",\"postingDatetime\":\"2026-11-18T10:00:00.000001Z\",\"storeId\":\"store-cairo-01\"}";
  const COUNT_HASH = "69f85dec754dce39d913c4bb3f8006483039d8110f235ec5d8afec52090ccec0";
  const PACK_CANON = "{\"currencyCode\":\"EGP\",\"freshnessWindowHours\":24,\"offers\":[{\"eligibleProductIds\":[\"p2\",\"p1\"],\"endsAt\":null,\"nameAr\":\"اشترِ ٢ واحصل على ١\",\"nameEn\":null,\"offerId\":\"0b6e1f3a-5c1d-4e57-8a41-2f9b7c3d1e10\",\"offerVersion\":3,\"offlinePolicy\":\"allow_cached\",\"parameters\":{\"buyQuantity\":2,\"getQuantity\":1,\"maxApplicationsPerSale\":null,\"percentOff\":\"100.00\",\"priceBasis\":\"resolved_store_price\",\"rewardSelection\":\"cheapest\"},\"startsAt\":\"2026-11-01T00:00:00.000Z\",\"type\":\"buy_x_get_y_percent\"}],\"packRevision\":7,\"storeTimezone\":\"Africa/Cairo\"}";
  const PACK_SHA = "fff262557655f59ec88526b1ed7d8583b48f8c70ee0115e89d9b18e777ea9909";

  const count = () =>
    countBody({
      sessionId: "6f1c2b9e-0a53-4a77-9d0e-1a2b3c4d5e6f",
      storeId: "store-cairo-01",
      chunk: 1,
      chunkTotal: 1,
      postingDatetime: "2026-11-18T10:00:00.000001Z",
      lines: [
        { productId: "p1", erpnextItemRef: "ITEM-0001", warehouseRef: "Stores - RT", countedQuantity: "12.500000", unit: "Nos", correctionEffectIds: [] },
        { productId: "p2", erpnextItemRef: "ITEM-0002", warehouseRef: "Stores - RT", countedQuantity: "0", unit: "Kg", correctionEffectIds: ["e1"] },
      ],
    });

  const pack: OfferPackBody = {
    packRevision: 7,
    issuedAt: "2026-11-18T10:00:00.000Z",
    freshnessWindowHours: 24,
    storeTimezone: "Africa/Cairo",
    currencyCode: "EGP",
    offers: [
      {
        offerId: "0b6e1f3a-5c1d-4e57-8a41-2f9b7c3d1e10",
        offerVersion: 3,
        nameAr: "اشترِ ٢ واحصل على ١",
        nameEn: null,
        type: "buy_x_get_y_percent",
        parameters: { buyQuantity: 2, getQuantity: 1, percentOff: "100.00", rewardSelection: "cheapest", maxApplicationsPerSale: null, priceBasis: "resolved_store_price" },
        startsAt: "2026-11-01T00:00:00.000Z",
        endsAt: null,
        offlinePolicy: "allow_cached",
        eligibleProductIds: ["p2", "p1"],
      },
    ],
  };

  it("count posting body: canonical string and feed payloadHash", () => {
    expect(countJson(count())).toBe(COUNT_CANON);
    expect(canonicalJson(count())).toBe(COUNT_CANON); // the shared function the caller now uses
    expect(countPayloadHash(count())).toBe(COUNT_HASH);
    expect(createHash("sha256").update(COUNT_CANON).digest("hex")).toBe(COUNT_HASH);
  });

  it("offer pack: canonical body (no issuedAt) and strong ETag", () => {
    const { issuedAt: _issuedAt, ...rest } = pack;
    expect(offerJson(rest)).toBe(PACK_CANON);
    expect(canonicalJson(rest)).toBe(PACK_CANON); // the shared function the caller now uses
    expect(packEtag(pack)).toBe(`"${PACK_SHA}"`);
    expect(createHash("sha256").update(PACK_CANON).digest("hex")).toBe(PACK_SHA);
  });
});

describe("RT-1456 A-09 canonicalInstant: two stored formats, kept apart", () => {
  // shift-money: epoch seconds plus the fraction as written (microseconds kept), a payload-hash input.
  // ai-entitlements: ISO-8601 UTC at millisecond precision, a stored column value.
  it.each([
    ["2026-10-05T08:00:00Z", "1791187200", "2026-10-05T08:00:00.000Z"],
    ["2026-10-05T10:00:00.000+02:00", "1791187200", "2026-10-05T08:00:00.000Z"],
    ["2026-10-05T10:00:00.123456+02:00", "1791187200.123456", "2026-10-05T08:00:00.123Z"],
    ["2026-10-05T08:00:00.5Z", "1791187200.5", "2026-10-05T08:00:00.500Z"],
  ])("%s", (input, shift, revision) => {
    expect(shiftInstant(input)).toBe(shift);
    expect(revisionInstant(input)).toBe(revision);
  });

  it("ai-entitlements also takes a Date", () => {
    expect(revisionInstant(new Date("2026-10-05T08:00:00.123Z"))).toBe("2026-10-05T08:00:00.123Z");
  });
});

describe("RT-1456 A-09 the fold: shared canonicalJson equals the frozen count-emission and offer-pack copies", () => {
  it("on every JSON-shaped vector", () => {
    for (let i = 0; i < 5; i++) {
      const value = VALUES[i]!();
      expect(canonicalJson(value)).toBe(countJson(value));
      expect(canonicalJson(value)).toBe(offerJson(value));
    }
  });

  it("where they differ, only on undefined and Date (the old output was not valid JSON for undefined)", () => {
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]"); // old copies: "[1,,2]"
    expect(canonicalJson({ a: 1, u: undefined })).toBe('{"a":1}'); // count copy wrote `"u":undefined`
    expect(canonicalJson({ when: new Date("2026-11-18T10:00:00.123Z") })).toBe('{"when":"2026-11-18T10:00:00.123Z"}'); // old: {"when":{}}
  });

  it("on 2000 seeded generated JSON-shaped values", () => {
    let seed = 0x9e3779b9;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const KEYS = ["a", "B", "z", "10", "9", "", "ключ", "\uFF5E", "\u{1F600}", "k\u0000", 'q"', "é"];
    const STRINGS = ["", "x", "Ünï", "\u2028", 'a"b\\c', "\u{1F600}", "line\nbreak"];
    const gen = (depth: number): unknown => {
      const kind = rnd(depth > 3 ? 5 : 7);
      switch (kind) {
        case 0: return null;
        case 1: return rnd(2) === 0;
        case 2: return [0, -0.5, 1, 1e21, 1e-7, 123456789.123456][rnd(6)];
        case 3: return STRINGS[rnd(STRINGS.length)];
        case 4: return rnd(100);
        case 5: return Array.from({ length: rnd(4) }, () => gen(depth + 1));
        default: {
          const o: Record<string, unknown> = {};
          for (let n = rnd(5); n > 0; n--) o[KEYS[rnd(KEYS.length)]!] = gen(depth + 1);
          return o;
        }
      }
    };
    for (let i = 0; i < 2000; i++) {
      const value = gen(0);
      const shared = canonicalJson(value);
      expect(shared).toBe(countJson(value));
      expect(shared).toBe(offerJson(value));
      expect(shared).toBe(canonicalJsonPayload(value));
      expect(() => JSON.parse(shared)).not.toThrow(); // always valid JSON
    }
  });
});
