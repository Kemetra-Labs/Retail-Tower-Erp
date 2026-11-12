import { canBindResolution, canReadQueue } from "@/tracking/trackingLogic";
import { buildBindCommand, refusalHint, validateBind } from "@/tracking/writeLogic";
import { describe, expect, test } from "vitest";

const L1 = "0190f000-0000-7000-8000-000000000b01";
const L2 = "0190f000-0000-7000-8000-000000000b02";
const I1 = "0190f000-0000-7000-8000-0000000007b1";

describe("bind draft (RT-455 part 2)", () => {
  test("only the owner binds; the owner and tenant_admin read the queue", () => {
    expect(canBindResolution("owner")).toBe(true);
    expect(canBindResolution("tenant_admin")).toBe(false);
    expect(canBindResolution("store_manager")).toBe(false);
    expect(canReadQueue("tenant_admin")).toBe(true);
    expect(canReadQueue("store_manager")).toBe(false);
  });

  test("needs a reason, a non-blank note and an identity for every line", () => {
    const empty = validateBind({ reason: "", note: "   ", identities: {} }, [L1, L2]);
    expect(Object.keys(empty).sort()).toEqual(["lines", "note", "reason"]);
    const partial = validateBind({ reason: "other", note: "x", identities: { [L1]: I1 } }, [
      L1,
      L2,
    ]);
    expect(partial).toEqual({ lines: "tracking.write.error.bindLines" });
    expect(
      validateBind({ reason: "supplier_notice", note: "x", identities: { [L1]: I1, [L2]: I1 } }, [
        L1,
        L2,
      ]),
    ).toEqual({});
  });

  test("a note over 500 characters is refused", () => {
    expect(
      validateBind({ reason: "other", note: "x".repeat(501), identities: { [L1]: I1 } }, [L1]).note,
    ).toBe("tracking.write.error.noteLength");
  });

  test("the command names each line once, in the sale's order, with a trimmed note", () => {
    expect(
      buildBindCommand(
        { reason: "label_misprint", note: " n ", identities: { [L2]: I1, [L1]: I1 } },
        [L1, L2],
      ),
    ).toEqual({
      reasonCode: "label_misprint",
      note: "n",
      lines: [
        { saleLineId: L1, trackingIdentityId: I1 },
        { saleLineId: L2, trackingIdentityId: I1 },
      ],
    });
  });

  test("the 409 codes each have a console line", () => {
    for (const code of [
      "tracking_resolution_identity_mismatch",
      "tracking_resolution_identity_held",
      "tracking_resolution_identity_expired",
      "tracking_resolution_already_resolved",
    ]) {
      expect(refusalHint({ kind: "rejected", status: 409, code })).toBeDefined();
    }
  });
});
