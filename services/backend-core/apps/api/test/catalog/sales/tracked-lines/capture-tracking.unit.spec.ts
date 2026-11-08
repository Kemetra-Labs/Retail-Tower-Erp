/**
 * Jira RT-451 slice S3 — the pure G7-9 ingest classification
 * (`capture-tracking.rules.ts`). The HTTP spec covers the database facts; this
 * covers every rule and its precedence, including the recall hold.
 */
import {
  classifyCapturedLine,
  saleTrackingStatus,
  type CapturedLineFacts,
} from "../../../../src/catalog/sales/tracked-lines/capture-tracking.rules";

const P = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

const VALID: CapturedLineFacts = {
  productId: P,
  trackingMode: "batch",
  expiryRequired: true,
  hasTracking: true,
  identity: { productId: P, expiryDate: "2026-05-01", hasEdgeMap: true },
  validationSent: true,
  validationMatches: true,
  qualityHoldId: null,
  recallHoldId: null,
  businessDate: "2026-05-01",
};

const causes = (facts: Partial<CapturedLineFacts>): string[] => {
  const c = classifyCapturedLine({ ...VALID, ...facts });
  return c.trackingClass === "flagged" ? c.findings.map((f) => `${f.kind}/${f.cause}`) : [c.trackingClass ?? "null"];
};

describe("classifyCapturedLine", () => {
  it("row 1: valid on its expiry date (inclusive)", () => {
    expect(classifyCapturedLine(VALID)).toEqual({ trackingClass: "valid" });
  });

  it.each<[string, Partial<CapturedLineFacts>, string]>([
    ["an untracked product without tracking", { trackingMode: "none", hasTracking: false, identity: null }, "null"],
    ["an ad-hoc line without tracking", { productId: null, trackingMode: null, hasTracking: false, identity: null }, "null"],
  ])("not classified: %s", (_why, facts, expected) => {
    expect(causes(facts)).toEqual([expected]);
  });

  it.each<[string, Partial<CapturedLineFacts>, string]>([
    ["a batch product without tracking", { hasTracking: false, identity: null }, "tracking_missing"],
    ["a serial product without tracking", { trackingMode: "serial", hasTracking: false, identity: null }, "tracking_missing"],
    ["an unknown identity", { identity: null }, "identity_unknown"],
    ["another product's identity", { identity: { ...VALID.identity!, productId: OTHER } }, "identity_other_product"],
    ["an ad-hoc line with tracking", { productId: null, trackingMode: null }, "identity_other_product"],
    [
      "another product's identity that is also held, expired and unvalidated",
      { identity: { productId: OTHER, expiryDate: "2020-01-01", hasEdgeMap: false }, qualityHoldId: "h", validationSent: false },
      "identity_other_product",
    ],
  ])("row 4 wins: %s", (_why, facts, reason) => {
    expect(classifyCapturedLine({ ...VALID, ...facts })).toEqual({ trackingClass: "unresolved", reason });
  });

  it.each<[string, Partial<CapturedLineFacts>, string[]]>([
    ["no validationId", { validationSent: false, validationMatches: false }, ["unvalidated_tracked_line/validation_missing"]],
    ["a validation that does not match", { validationMatches: false }, ["unvalidated_tracked_line/validation_mismatch"]],
    ["a quality hold", { qualityHoldId: "q" }, ["sold_under_hold/quality_hold"]],
    ["a recall hold", { recallHoldId: "r" }, ["sold_under_hold/recall_hold"]],
    ["expired the day before", { identity: { ...VALID.identity!, expiryDate: "2026-04-30" } }, ["erp_intent_held/expired"]],
    ["no expiry when required", { identity: { ...VALID.identity!, expiryDate: null } }, ["erp_intent_held/expired"]],
    ["no edge map", { identity: { ...VALID.identity!, hasEdgeMap: false } }, ["erp_intent_held/edge_map_missing"]],
    [
      "every row-2 and row-3 cause at once",
      { validationSent: false, qualityHoldId: "q", recallHoldId: "r", identity: { productId: P, expiryDate: "2026-04-30", hasEdgeMap: false } },
      [
        "unvalidated_tracked_line/validation_missing",
        "sold_under_hold/quality_hold",
        "sold_under_hold/recall_hold",
        "erp_intent_held/expired",
        "erp_intent_held/edge_map_missing",
      ],
    ],
  ])("rows 2-3: %s", (_why, facts, expected) => {
    expect(causes(facts)).toEqual(expected);
  });

  it("no expiry is not expired when the product does not require one", () => {
    expect(causes({ expiryRequired: false, identity: { ...VALID.identity!, expiryDate: null } })).toEqual(["valid"]);
  });

  it("carries the hold id on sold_under_hold only", () => {
    const c = classifyCapturedLine({ ...VALID, recallHoldId: "r1", validationSent: false });
    expect(c).toEqual({
      trackingClass: "flagged",
      findings: [
        { kind: "unvalidated_tracked_line", cause: "validation_missing", holdId: null },
        { kind: "sold_under_hold", cause: "recall_hold", holdId: "r1" },
      ],
    });
  });
});

describe("saleTrackingStatus", () => {
  it.each<[string, Parameters<typeof saleTrackingStatus>[0], ReturnType<typeof saleTrackingStatus>]>([
    ["no classified line", [{ trackingClass: null }], null],
    ["valid and flagged lines", [{ trackingClass: "valid" }, { trackingClass: "flagged", findings: [] }], "tracked"],
    ["any unresolved line", [{ trackingClass: "valid" }, { trackingClass: "unresolved", reason: "tracking_missing" }], "tracking_unresolved"],
  ])("%s", (_why, classes, expected) => {
    expect(saleTrackingStatus(classes)).toBe(expected);
  });
});
