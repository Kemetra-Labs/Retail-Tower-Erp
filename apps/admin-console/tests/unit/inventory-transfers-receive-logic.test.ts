import {
  type ReceiveDraft,
  buildCloseCommand,
  buildReceiveCommand,
  compareDecimal,
  hasInTransit,
  hasReceiveErrors,
  inTransitLines,
  shortCloseReasonError,
  validateReceive,
} from "@/inventory/transfers/transferReceiveLogic";
import type { ShipmentTransfer, ShipmentTransferLine } from "@/lib/inventory-queries";
import { describe, expect, test } from "vitest";

const L1 = "0190f000-0000-7000-8000-00000000b001";
const L2 = "0190f000-0000-7000-8000-00000000b002";
const LOC = "0190f000-0000-7000-8000-0000000007d1";

function line(id: string, inTransitQuantity: string): ShipmentTransferLine {
  return { id, inTransitQuantity } as ShipmentTransferLine;
}

const lines = [line(L1, "6.0000"), line(L2, "0.0000")];

function draft(over: Partial<ReceiveDraft> = {}): ReceiveDraft {
  return {
    lines: [
      { lineId: L1, quantity: "", disposition: "sellable", locationId: "" },
      { lineId: L2, quantity: "", disposition: "sellable", locationId: "" },
    ],
    note: "",
    ...over,
  };
}

const withQuantity = (quantity: string, extra: Record<string, string> = {}) =>
  draft({
    lines: [{ lineId: L1, quantity, disposition: "sellable", locationId: "", ...extra }],
  });

/** RT-1515 (PR 3): exact decimal comparison, never a float. */
describe("compareDecimal", () => {
  test.each([
    ["4", "4", 0],
    ["4", "4.0000", 0],
    ["4.0000", "4", 0],
    ["3", "4", -1],
    ["5", "4.0000", 1],
    ["0.5", "0.4999", 1],
    ["0.4999", "0.5", -1],
    ["6.0000", "6.0001", -1],
    ["999999999999999.9999", "999999999999999.9998", 1],
    ["0", "0.0000", 0],
  ])("%s vs %s is %i", (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });

  test("a value that is not a plain decimal compares as null", () => {
    for (const bad of ["", "abc", "-1", "1e3", "1.", ".5", "1,5"]) {
      expect(compareDecimal(bad, "1")).toBeNull();
      expect(compareDecimal("1", bad)).toBeNull();
    }
  });

  test("a difference a float cannot see is still seen", () => {
    expect(compareDecimal("0.30000000000000004", "0.3")).toBe(1);
  });
});

describe("In transit lines", () => {
  test("only a line with a quantity above zero is In transit", () => {
    expect(hasInTransit(line(L1, "0.0001"))).toBe(true);
    expect(hasInTransit(line(L2, "0.0000"))).toBe(false);
    const transfer = { lines } as ShipmentTransfer;
    expect(inTransitLines(transfer).map((l) => l.id)).toEqual([L1]);
  });
});

describe("receipt validation", () => {
  test("a receipt with no quantity on any line is refused", () => {
    const errors = validateReceive(draft(), lines);
    expect(errors.form).toBe("transfers.receive.error.noLines");
    expect(hasReceiveErrors(errors)).toBe(true);
  });

  test("less than, equal to and a different scale of In transit are accepted", () => {
    for (const quantity of ["2", "6", "6.0000", "5.9999"]) {
      expect(hasReceiveErrors(validateReceive(withQuantity(quantity), lines)), quantity).toBe(
        false,
      );
    }
  });

  test("more than In transit is refused on that line, even by 0.0001", () => {
    for (const quantity of ["6.0001", "7", "10.5"]) {
      const errors = validateReceive(withQuantity(quantity), lines);
      expect(errors.perLine[L1], quantity).toBe("transfers.receive.error.over");
    }
  });

  test("zero, negative, too many decimals and text are refused as a bad quantity", () => {
    for (const quantity of ["0", "0.0000", "-1", "1.23456", "abc", "1e2"]) {
      expect(validateReceive(withQuantity(quantity), lines).perLine[L1], quantity).toBe(
        "transfers.receive.error.quantity",
      );
    }
  });

  test("a note over 500 characters is refused", () => {
    const errors = validateReceive({ ...withQuantity("1"), note: "x".repeat(501) }, lines);
    expect(errors.note).toBe("transfers.receive.error.note");
  });
});

describe("receipt command", () => {
  test("only the lines with a quantity are sent, trimmed, with the disposition", () => {
    const d = draft({
      lines: [
        { lineId: L1, quantity: " 2.5 ", disposition: "damaged", locationId: "" },
        { lineId: L2, quantity: "", disposition: "sellable", locationId: "" },
      ],
      note: "  Two crates dented ",
    });
    expect(buildReceiveCommand(d, false)).toEqual({
      lines: [
        { transferLineId: L1, quantity: "2.5", disposition: "damaged", stockLocationId: null },
      ],
      note: "Two crates dented",
    });
  });

  test("the location is null for a single-location destination, even if one was set", () => {
    const d = withQuantity("1", { locationId: LOC });
    expect(buildReceiveCommand(d, false).lines[0]?.stockLocationId).toBeNull();
  });

  test("with several locations the chosen one is sent, and a blank choice sends null", () => {
    const chosen = buildReceiveCommand(withQuantity("1", { locationId: LOC }), true);
    expect(chosen.lines[0]?.stockLocationId).toBe(LOC);
    expect(buildReceiveCommand(withQuantity("1"), true).lines[0]?.stockLocationId).toBeNull();
  });

  test("an empty note is sent as null", () => {
    expect(buildReceiveCommand(withQuantity("1"), false).note).toBeNull();
  });
});

describe("close command", () => {
  test("a full close sends a null reason; a short-close sends the trimmed reason", () => {
    expect(buildCloseCommand(null)).toEqual({ shortCloseReason: null });
    expect(buildCloseCommand("   ")).toEqual({ shortCloseReason: null });
    expect(buildCloseCommand("  Lost in transit ")).toEqual({
      shortCloseReason: "Lost in transit",
    });
  });

  test("a short-close reason is required, 1 to 500 characters", () => {
    expect(shortCloseReasonError("")).toBe("transfers.shortClose.error.reason");
    expect(shortCloseReasonError("   ")).toBe("transfers.shortClose.error.reason");
    expect(shortCloseReasonError("x".repeat(501))).toBe("transfers.shortClose.error.reason");
    expect(shortCloseReasonError("x".repeat(500))).toBeUndefined();
    expect(shortCloseReasonError("Lost")).toBeUndefined();
  });
});
