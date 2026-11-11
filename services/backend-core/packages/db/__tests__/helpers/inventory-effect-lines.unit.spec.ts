/**
 * RT-427 — pure effect-line rules (owner decision 2) and DC-1 provenance keys.
 */
import {
  decideEffectLine,
  returnLineEffectKey,
  saleLineEffectKey,
  voidEffectKey,
  type EffectLineFacts,
} from "../../src/helpers/inventory-effects/effect-lines";

const LINE: EffectLineFacts = {
  tenantProductRef: "0a000000-0000-7000-8000-000000000001",
  quantity: "2.000000",
  unit: "ea",
  trackingMode: "none",
  establishedUnit: null,
  trackingIdentityId: null,
};

const IDENTITY = "0a000000-0000-7000-8000-0000000000e1";

describe("decideEffectLine", () => {
  it.each<[string, Partial<EffectLineFacts>]>([
    ["a product line with no established unit", {}],
    ["a line in the established unit", { establishedUnit: "ea" }],
    ["four significant decimals", { quantity: "1.234500" }],
    ["an integer text", { quantity: "3" }],
  ])("writes %s", (_label, over) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "write", trackingIdentityId: null });
  });

  describe("tracked lines (RT-451 S4)", () => {
    it("writes a batch line with its identity at the identity", () => {
      expect(decideEffectLine({ ...LINE, trackingMode: "batch", trackingIdentityId: IDENTITY })).toEqual({
        kind: "write",
        trackingIdentityId: IDENTITY,
      });
    });

    it("still applies the precision and unit rules to a batch line with its identity", () => {
      const tracked = { ...LINE, trackingMode: "batch", trackingIdentityId: IDENTITY };
      expect(decideEffectLine({ ...tracked, quantity: "0.000001" })).toEqual({ kind: "skip", reason: "quantity_precision" });
      expect(decideEffectLine({ ...tracked, establishedUnit: "kg" })).toEqual({ kind: "skip", reason: "unit_mismatch" });
    });

    it("never carries an identity on an untracked product's line", () => {
      expect(decideEffectLine({ ...LINE, trackingMode: "none", trackingIdentityId: IDENTITY })).toEqual({
        kind: "write",
        trackingIdentityId: null,
      });
    });

    it.each<[string, Partial<EffectLineFacts>]>([
      ["a batch line without an identity", { trackingMode: "batch", trackingIdentityId: null }],
      ["a serial line, even with an identity (serial selling stays gated)", { trackingMode: "serial", trackingIdentityId: IDENTITY }],
    ])("skips %s as tracked_product", (_label, over) => {
      expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "skip", reason: "tracked_product" });
    });
  });

  it.each<[string, Partial<EffectLineFacts>]>([
    ["a line with no product", { tenantProductRef: null, trackingMode: null }],
    ["a zero quantity", { quantity: "0.000000" }],
    ["a bare zero", { quantity: "0" }],
  ])("ignores %s", (_label, over) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "ignore" });
  });

  it.each<[string, Partial<EffectLineFacts>, string]>([
    ["a batch-tracked product", { trackingMode: "batch" }, "tracked_product"],
    ["a serial-tracked product", { trackingMode: "serial" }, "tracked_product"],
    ["five significant decimals", { quantity: "1.234560" }, "quantity_precision"],
    ["six significant decimals", { quantity: "0.000001" }, "quantity_precision"],
    ["another unit than the established one", { establishedUnit: "kg" }, "unit_mismatch"],
  ])("skips %s", (_label, over, reason) => {
    expect(decideEffectLine({ ...LINE, ...over })).toEqual({ kind: "skip", reason });
  });

  it("checks tracking before precision and unit", () => {
    expect(decideEffectLine({ ...LINE, trackingMode: "batch", quantity: "0.000001", establishedUnit: "kg" })).toEqual({
      kind: "skip",
      reason: "tracked_product",
    });
  });
});

describe("DC-1 provenance keys", () => {
  it("are deterministic from the business line", () => {
    expect(saleLineEffectKey("L1")).toBe("sale_line:L1");
    expect(voidEffectKey("V1", "L1")).toBe("void:V1:L1");
    expect(returnLineEffectKey("R1")).toBe("return_line:R1");
  });
});
