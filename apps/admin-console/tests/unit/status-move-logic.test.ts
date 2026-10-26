import {
  type MoveDraft,
  buildCommand,
  canMoveStock,
  classifyMoveResult,
  fromStatusesFor,
  isKeyConflict,
  keyFor,
  noteRequired,
  reasonKey,
  reasonsFor,
  toStatusesFor,
  validateMove,
} from "@/inventory/statusMoveLogic";
import { describe, expect, test } from "vitest";

const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const LOCATION = "0190f000-0000-7000-8000-0000000007d1";

function draft(overrides: Partial<MoveDraft> = {}): MoveDraft {
  return {
    productId: PRODUCT,
    from: "sellable",
    to: "damaged",
    reason: "damage",
    quantity: "2.5",
    note: "",
    locationId: "",
    stockingUnit: "kg",
    ...overrides,
  };
}

describe("status move choices (RT-436)", () => {
  test("only the roles the operation accepts may move stock", () => {
    expect(canMoveStock("owner")).toBe(true);
    expect(canMoveStock("tenant_admin")).toBe(true);
    expect(canMoveStock("store_manager")).toBe(true);
    for (const role of ["cashier", "auditor", "", null, undefined]) {
      expect(canMoveStock(role)).toBe(false);
    }
  });

  test("the hold and recall statuses are never offered", () => {
    for (const role of ["owner", "store_manager"]) {
      const offered = [...fromStatusesFor(role), ...toStatusesFor("sellable")];
      expect(offered).not.toContain("quality_hold");
      expect(offered).not.toContain("recall_hold");
    }
  });

  test("moving out of damaged / expired is offered to owner and tenant_admin only", () => {
    expect(fromStatusesFor("owner")).toEqual([
      "sellable",
      "return_inspection",
      "damaged",
      "expired",
    ]);
    expect(fromStatusesFor("tenant_admin")).toContain("damaged");
    expect(fromStatusesFor("store_manager")).toEqual(["sellable", "return_inspection"]);
  });

  test("the target statuses exclude the source", () => {
    expect(toStatusesFor("sellable")).toEqual(["return_inspection", "damaged", "expired"]);
  });

  test("each pair offers its own reason code, then correction", () => {
    expect(reasonsFor("sellable", "damaged")).toEqual(["damage", "correction"]);
    expect(reasonsFor("sellable", "expired")).toEqual(["expiry", "correction"]);
    expect(reasonsFor("return_inspection", "sellable")).toEqual([
      "inspection_restock",
      "correction",
    ]);
    expect(reasonsFor("return_inspection", "damaged")).toEqual(["inspection_damage", "correction"]);
    expect(reasonsFor("damaged", "sellable")).toEqual(["correction"]);
    expect(reasonsFor("sellable", "sellable")).toEqual([]);
  });

  test("only correction needs a note", () => {
    expect(noteRequired("correction")).toBe(true);
    expect(noteRequired("damage")).toBe(false);
    expect(noteRequired("")).toBe(false);
  });

  test("reason keys are catalog keys; an unknown code reads Unknown", () => {
    expect(reasonKey("damage")).toBe("inventory.move.reason.damage");
    expect(reasonKey("hold_release")).toBe("inventory.value.unknown");
  });
});

describe("status move validation (RT-436)", () => {
  test("a complete draft is valid", () => {
    expect(validateMove(draft())).toEqual({});
  });

  test.each(["", "0", "0.000", "-1", "1.23456", "1e3", "abc", "1,5", "1234567890123456"])(
    "quantity %j is refused before sending",
    (quantity) => {
      expect(validateMove(draft({ quantity })).quantity).toBe("inventory.move.error.quantity");
    },
  );

  test.each(["1", "0.5", "10.0001", " 3 ", "999999999999999"])(
    "quantity %j is accepted",
    (quantity) => {
      expect(validateMove(draft({ quantity })).quantity).toBeUndefined();
    },
  );

  test("a reason that does not fit the pair is refused", () => {
    expect(validateMove(draft({ reason: "expiry" })).reason).toBe("inventory.move.error.reason");
    expect(validateMove(draft({ reason: "" })).reason).toBe("inventory.move.error.reason");
    expect(validateMove(draft({ reason: "hold_release" })).reason).toBe(
      "inventory.move.error.reason",
    );
  });

  test("a correction needs a note; a note over 500 characters is refused", () => {
    expect(validateMove(draft({ reason: "correction" })).note).toBe("inventory.move.error.note");
    expect(validateMove(draft({ reason: "correction", note: "recount" })).note).toBeUndefined();
    expect(validateMove(draft({ note: "x".repeat(501) })).note).toBe("inventory.move.error.note");
  });

  test("a missing or blank stocking unit blocks the move", () => {
    for (const stockingUnit of [null, undefined, "", "  "]) {
      expect(validateMove(draft({ stockingUnit })).unit).toBe("inventory.move.error.unit");
    }
  });
});

describe("status move command (RT-436)", () => {
  test("the strict command carries no tenant, store or actor and omits empty optionals", () => {
    expect(buildCommand(draft())).toEqual({
      tenantProductRef: PRODUCT,
      quantity: "2.5",
      stockingUnit: "kg",
      fromStatus: "sellable",
      toStatus: "damaged",
      reasonCode: "damage",
    });
  });

  test("a chosen location and a note are sent; the quantity stays the string typed", () => {
    expect(
      buildCommand(draft({ quantity: " 2.5000 ", note: " broken ", locationId: LOCATION })),
    ).toMatchObject({ quantity: "2.5000", note: "broken", stockLocationId: LOCATION });
  });
});

describe("idempotency key (RT-436)", () => {
  test("an unchanged command reuses its key; an edited one gets a new key", () => {
    const first = keyFor(null, buildCommand(draft()));
    expect(keyFor(first, buildCommand(draft())).key).toBe(first.key);
    expect(keyFor(first, buildCommand(draft({ quantity: "3" }))).key).not.toBe(first.key);
    expect(first.key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });
});

describe("status move outcome (RT-436)", () => {
  test("201 and a 200 replay are recorded", () => {
    expect(classifyMoveResult({ status: 201 })).toEqual({ kind: "recorded" });
    expect(classifyMoveResult({ status: 200 })).toEqual({ kind: "recorded" });
  });

  test("a refusal keeps the server's message, code and request id verbatim", () => {
    const outcome = classifyMoveResult({
      status: 409,
      error: {
        error: {
          code: "tracking_identity_required",
          message: "Tracked products cannot be moved yet.",
          request_id: "r-1",
        },
      },
    });
    expect(outcome).toEqual({
      kind: "rejected",
      status: 409,
      message: "Tracked products cannot be moved yet.",
      code: "tracking_identity_required",
      requestId: "r-1",
      retryAfter: undefined,
    });
    expect(isKeyConflict(outcome)).toBe(false);
  });

  test("an idempotency_key_conflict is recognised so the next try uses a new key", () => {
    const outcome = classifyMoveResult({
      status: 409,
      error: { error: { code: "idempotency_key_conflict", message: "m" } },
    });
    expect(isKeyConflict(outcome)).toBe(true);
  });

  test("a body-less failure still reports its status", () => {
    expect(classifyMoveResult({ status: 502 })).toMatchObject({ kind: "rejected", status: 502 });
  });
});
