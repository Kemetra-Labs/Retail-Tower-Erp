/**
 * RT-1312 Phase 3(b): the pure rules of a quarantined sale body — the
 * sale-facts digest (RT-1206) and the decision C5 summary. Both run on an
 * unvalidated body, so neither may throw on a field's shape.
 */
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import {
  CAPTURE_HASH_EXCLUDED_FIELDS,
  saleFactsDigest,
  saleFactsOf,
  summaryOf,
} from "../../../../src/catalog/sales/quarantine/quarantine-facts";

const BODY = {
  sourceSystem: "pos-pulse",
  externalId: "ext-1",
  occurredAt: "2026-11-11T09:00:00.000+02:00",
  currencyCode: "EGP",
  posTotal: "10.0000",
  lines: [{ a: 1 }, { a: 2 }],
};

describe("saleFactsDigest (the RT-1206 same-facts rule)", () => {
  it("equals the capture payload_hash of the body without the fields capture leaves out", () => {
    const withExcluded = {
      ...BODY,
      operatorUserId: "u",
      admissionCheckAt: "2026-11-11T09:00:00Z",
      receipt: { x: 1 },
      safetyRevision: 3,
      safetySyncedAt: "2026-11-11T08:00:00Z",
    };
    // The controller hashes exactly this destructured body (SalesController.captureSale).
    expect(saleFactsDigest(withExcluded)).toBe(sha256CanonicalHex(BODY));
  });

  it("names the five fields the capture controller leaves out", () => {
    expect([...CAPTURE_HASH_EXCLUDED_FIELDS]).toEqual([
      "operatorUserId",
      "admissionCheckAt",
      "receipt",
      "safetyRevision",
      "safetySyncedAt",
    ]);
  });

  it("ignores key order and the excluded fields, and sees every other change", () => {
    const reordered = Object.fromEntries(Object.entries(BODY).reverse());
    expect(saleFactsDigest(reordered)).toBe(saleFactsDigest(BODY));
    expect(saleFactsDigest({ ...BODY, receipt: "anything" })).toBe(saleFactsDigest(BODY));
    expect(saleFactsDigest({ ...BODY, posTotal: "10.0001" })).not.toBe(saleFactsDigest(BODY));
    expect(saleFactsDigest({ ...BODY, extra: null })).not.toBe(saleFactsDigest(BODY));
  });

  it("does not mutate the body", () => {
    const body = { ...BODY, receipt: { x: 1 } };
    saleFactsOf(body);
    expect(body.receipt).toEqual({ x: 1 });
  });

  it("returns null, not a throw, for a body nested too deeply to serialise", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200_000; i += 1) deep = [deep];
    expect(saleFactsDigest({ lines: deep })).toBeNull();
  });
});

describe("summaryOf (decision C5)", () => {
  it("reads the time, total, currency and line count", () => {
    expect(summaryOf(BODY)).toEqual({
      occurredAt: new Date("2026-11-11T07:00:00.000Z"),
      posTotal: "10.0000",
      currencyCode: "EGP",
      lineCount: 2,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["missing fields", {}],
    ["wrong types", { occurredAt: 1, posTotal: 10, currencyCode: ["EGP"], lines: { a: 1 } }],
    ["malformed values", { occurredAt: "2026-11-11", posTotal: "-1", currencyCode: "egp", lines: null }],
    ["an impossible date", { occurredAt: "2026-13-45T99:99:99Z", posTotal: "1.00001", currencyCode: "EGPP" }],
  ])("gives null for %s, never a throw", (_label, body) => {
    expect(summaryOf(body)).toEqual({ occurredAt: null, posTotal: null, currencyCode: null, lineCount: null });
  });

  it("counts an empty line list as zero", () => {
    expect(summaryOf({ lines: [] }).lineCount).toBe(0);
  });
});
