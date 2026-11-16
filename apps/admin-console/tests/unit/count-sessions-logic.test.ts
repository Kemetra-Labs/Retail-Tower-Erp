import {
  type ObservationDraft,
  buildApproveCommand,
  buildObservation,
  canApprove,
  canCancel,
  canCapture,
  classifyCountResult,
  countStateKey,
  deviceReasonKey,
  flagKey,
  hasReview,
  isErpState,
  isSelfApproved,
  isStaleLine,
  mergeObservations,
  needsAcknowledgement,
  pendingAcknowledgements,
  refusalKey,
  settlesAttempt,
  tookPart,
  validateObservation,
  warehouseReasonKey,
} from "@/count-sessions/countLogic";
import type { CountVarianceLine } from "@/lib/count-session-queries";
import { describe, expect, test } from "vitest";

const P1 = "0190f000-0000-7000-8000-0000000009a1";
const P2 = "0190f000-0000-7000-8000-0000000009a2";
const P3 = "0190f000-0000-7000-8000-0000000009a3";

function line(productId: string, overrides: Partial<CountVarianceLine> = {}): CountVarianceLine {
  return {
    productId,
    lineVersion: "1",
    stockingUnit: "kg",
    expectedQuantity: "10.0000",
    countedQuantity: "7.0000",
    varianceQuantity: "-3.0000",
    flags: [],
    acknowledgementRequired: false,
    acknowledgement: null,
    refusal: null,
    observations: [],
    ...overrides,
  };
}
const flagged = (id: string, version = "1") =>
  line(id, { lineVersion: version, flags: ["divergence"], acknowledgementRequired: true });

describe("states", () => {
  test("only open and cut_taken capture; submitted onward review; ERP states are server-set", () => {
    expect(canCapture("open")).toBe(true);
    expect(canCapture("cut_taken")).toBe(true);
    expect(canCapture("submitted")).toBe(false);
    expect(hasReview("open")).toBe(false);
    expect(hasReview("submitted")).toBe(true);
    expect(hasReview("cancelled")).toBe(false);
    expect(canCancel("submitted")).toBe(true);
    expect(canCancel("approved")).toBe(false);
    expect(isErpState("posting")).toBe(true);
    expect(isErpState("approved")).toBe(false);
  });

  test("an unknown code reads as Unknown, never as a raw code", () => {
    expect(countStateKey("brand_new")).toBe("counts.value.unknown");
    expect(flagKey("brand_new")).toBe("counts.value.unknown");
    expect(refusalKey("brand_new")).toBe("counts.value.unknown");
    expect(countStateKey("needs_attention")).toBe("counts.state.needs_attention");
  });
});

describe("capture validation", () => {
  const draft: ObservationDraft = {
    productId: P1,
    locationId: "0190f000-0000-7000-8000-0000000009b1",
    inventoryStatus: "sellable",
    quantity: "7.5",
    unit: "kg",
  };

  test("a valid draft has no errors and builds the strict observation", () => {
    expect(validateObservation(draft)).toEqual({});
    expect(buildObservation({ ...draft, quantity: " 7.5 ", unit: " kg " })).toEqual({
      productId: P1,
      locationId: draft.locationId,
      inventoryStatus: "sellable",
      countedQuantity: "7.5",
      stockingUnit: "kg",
    });
  });

  test.each(["", "-1", "1.23456", "abc", "1e3", "1,5"])("quantity %j is refused", (quantity) => {
    expect(validateObservation({ ...draft, quantity }).quantity).toBe(
      "counts.capture.error.quantity",
    );
  });

  test("zero is a valid count (a shelf can be empty)", () => {
    expect(validateObservation({ ...draft, quantity: "0" })).toEqual({});
  });

  test("product, location and unit are required; the unit is at most 32 characters", () => {
    const errors = validateObservation({ ...draft, productId: "", locationId: "", unit: " " });
    expect(Object.keys(errors).sort()).toEqual(["location", "product", "unit"]);
    expect(validateObservation({ ...draft, unit: "x".repeat(33) }).unit).toBeDefined();
  });

  test("the built observation never carries tenant, store or actor", () => {
    expect(Object.keys(buildObservation(draft)).sort()).toEqual([
      "countedQuantity",
      "inventoryStatus",
      "locationId",
      "productId",
      "stockingUnit",
    ]);
  });
});

describe("acknowledgement and approval gating", () => {
  test("a flagged line needs an acknowledgement; a refused line can never be acknowledged", () => {
    expect(needsAcknowledgement(flagged(P1))).toBe(true);
    expect(needsAcknowledgement(line(P1))).toBe(false);
    const refused = line(P1, {
      flags: ["unmapped"],
      acknowledgementRequired: true,
      refusal: { code: "count_line_unmapped", message: "x" },
    });
    expect(needsAcknowledgement(refused)).toBe(false);
  });

  test("an acknowledgement counts only for the exact line version it was given for", () => {
    const lines = [flagged(P1, "2")];
    expect(pendingAcknowledgements(lines, { [P1]: "2" })).toEqual([]);
    expect(pendingAcknowledgements(lines, { [P1]: "1" })).toHaveLength(1);
  });

  test("approve needs every page loaded, at least one line and every flagged line acknowledged", () => {
    const lines = [flagged(P1), line(P2)];
    expect(canApprove(lines, false, { [P1]: "1" })).toBe(false);
    expect(canApprove([], true, {})).toBe(false);
    expect(canApprove(lines, true, {})).toBe(false);
    expect(canApprove(lines, true, { [P1]: "1" })).toBe(true);
  });

  test("the approve command lists one acknowledgement per flagged line with its version", () => {
    const lines = [flagged(P1, "3"), line(P2), flagged(P3, "5")];
    expect(buildApproveCommand(lines, { [P1]: "3", [P3]: "5", [P2]: "1" })).toEqual({
      acknowledgements: [
        { productId: P1, lineVersion: "3" },
        { productId: P3, lineVersion: "5" },
      ],
    });
    expect(buildApproveCommand([line(P2)], {})).toEqual({ acknowledgements: [] });
  });
});

describe("approver and self-approval", () => {
  const session = { counterIds: ["u2"], submittedBy: "u3" };
  test("tookPart is advisory: a counter or the submitter, never an unknown viewer", () => {
    expect(tookPart(session, "u2")).toBe(true);
    expect(tookPart(session, "u3")).toBe(true);
    expect(tookPart(session, "u9")).toBe(false);
    expect(tookPart(session, null)).toBe(false);
  });

  test("self-approved only when the server says so", () => {
    expect(isSelfApproved({ approval: null })).toBe(false);
    expect(
      isSelfApproved({
        approval: {
          approvedBy: "u2",
          approvedAt: "2026-11-16T09:00:00Z",
          policy: "small_merchant_exception",
          selfApproved: true,
        },
      }),
    ).toBe(true);
    expect(
      isSelfApproved({
        approval: {
          approvedBy: "u9",
          approvedAt: "2026-11-16T09:00:00Z",
          policy: "strict_separation",
          selfApproved: false,
        },
      }),
    ).toBe(false);
  });
});

describe("write outcome", () => {
  const body = (code: string) => ({ error: { code, message: "words", request_id: "r1" } });

  test("200 and 201 are ok and carry the data", () => {
    expect(classifyCountResult({ status: 201, data: { id: "s" } })).toEqual({
      kind: "ok",
      data: { id: "s" },
    });
    expect(classifyCountResult({ status: 200 }).kind).toBe("ok");
  });

  test("a typed 409 selects its catalog message and keeps the code and request id", () => {
    const out = classifyCountResult({ status: 409, error: body("count_cut_barrier_not_met") });
    expect(out).toMatchObject({
      kind: "rejected",
      messageKey: "counts.error.cutBlocked",
      code: "count_cut_barrier_not_met",
      requestId: "r1",
    });
  });

  test.each([
    ["count_session_not_in_state", "counts.error.notInState"],
    ["count_tracked_product_refused", "counts.error.trackedRefused"],
    ["count_scope_in_use", "counts.error.scopeInUse"],
    ["count_approver_conflict", "counts.error.approverConflict"],
    ["count_flagged_line_not_acknowledged", "counts.error.notAcknowledged"],
    ["count_line_version_stale", "counts.error.lineStale"],
    ["idempotency_key_conflict", "counts.error.keyConflict"],
    ["some_future_code", "counts.error.conflict"],
  ])("409 %s reads as %s", (code, key) => {
    expect(classifyCountResult({ status: 409, error: body(code) })).toMatchObject({
      messageKey: key,
    });
  });

  test("other statuses never show the server's words", () => {
    expect(classifyCountResult({ status: 403 })).toMatchObject({
      messageKey: "counts.error.forbidden",
    });
    expect(classifyCountResult({ status: 404 })).toMatchObject({
      messageKey: "counts.error.notFound",
    });
    expect(classifyCountResult({ status: 500 })).toMatchObject({
      messageKey: "counts.error.generic",
    });
    expect(classifyCountResult({ status: 429, retryAfter: 9 })).toMatchObject({
      messageKey: "counts.error.rateLimited",
      retryAfter: 9,
    });
  });

  test("a stale line is recognised so the lines can be re-read", () => {
    expect(
      isStaleLine(classifyCountResult({ status: 409, error: body("count_line_version_stale") })),
    ).toBe(true);
    expect(isStaleLine({ kind: "failed" })).toBe(false);
  });

  test("a lost answer, a 429 and a 5xx keep the Idempotency-Key; a terminal answer settles it", () => {
    expect(settlesAttempt({ kind: "ok", data: undefined })).toBe(true);
    expect(settlesAttempt(classifyCountResult({ status: 409, error: body("x") }))).toBe(true);
    expect(settlesAttempt(classifyCountResult({ status: 400 }))).toBe(true);
    expect(settlesAttempt({ kind: "failed" })).toBe(false);
    expect(settlesAttempt(classifyCountResult({ status: 429 }))).toBe(false);
    expect(settlesAttempt(classifyCountResult({ status: 503 }))).toBe(false);
  });
});

describe("Count Cut blockers and owner-only refusal", () => {
  test("a cut refusal keeps the server's devices and warehouses, only when well formed", () => {
    const details = {
      devices: [{ deviceId: "d1", reason: "queue_pending" }],
      warehouses: [{ warehouseRef: "Stores - RT", reason: "import_not_past_cut" }],
    };
    const out = classifyCountResult({
      status: 409,
      error: { error: { code: "count_cut_barrier_not_met", message: "m", details } },
    });
    expect(out).toMatchObject({ blockers: details });
    const bare = classifyCountResult({
      status: 409,
      error: { error: { code: "count_cut_barrier_not_met", message: "m" } },
    });
    expect(bare).toMatchObject({ blockers: undefined });
    const malformed = classifyCountResult({
      status: 409,
      error: {
        error: { code: "count_cut_barrier_not_met", message: "m", details: { devices: 1 } },
      },
    });
    expect(malformed).toMatchObject({ blockers: undefined });
    // Other 409 codes never carry blockers.
    expect(
      classifyCountResult({
        status: 409,
        error: { error: { code: "count_scope_in_use", details } },
      }),
    ).toMatchObject({ blockers: undefined });
  });

  test("every blocker reason has catalog copy; an unknown one reads as Unknown", () => {
    for (const r of ["no_heartbeat", "stale_heartbeat", "queue_unknown", "queue_pending"]) {
      expect(deviceReasonKey(r)).toBe(`counts.cut.device.${r}`);
    }
    expect(deviceReasonKey("new")).toBe("counts.value.unknown");
    expect(warehouseReasonKey("import_not_past_cut")).toBe(
      "counts.cut.warehouse.import_not_past_cut",
    );
    expect(warehouseReasonKey("new")).toBe("counts.value.unknown");
  });

  test("the typed owner-only 403 selects its own message", () => {
    expect(
      classifyCountResult({
        status: 403,
        error: { error: { code: "count_self_approval_owner_only", message: "m" } },
      }),
    ).toMatchObject({
      messageKey: "counts.error.ownerOnly",
      code: "count_self_approval_owner_only",
    });
    expect(classifyCountResult({ status: 403 })).toMatchObject({
      messageKey: "counts.error.forbidden",
    });
  });
});

describe("a later observation replaces the same position", () => {
  const obs = (productId: string, locationId: string, inventoryStatus: string, q: string) => ({
    productId,
    locationId,
    inventoryStatus,
    countedQuantity: q,
  });

  test("recounting a position takes the old row's place, never a second row", () => {
    const first = [obs(P1, "L1", "sellable", "5"), obs(P2, "L1", "sellable", "2")];
    const merged = mergeObservations(first, [obs(P1, "L1", "sellable", "7")]);
    expect(merged).toEqual([obs(P1, "L1", "sellable", "7"), obs(P2, "L1", "sellable", "2")]);
  });

  test("a new position (another location or status) is appended", () => {
    const merged = mergeObservations(
      [obs(P1, "L1", "sellable", "5")],
      [obs(P1, "L2", "sellable", "1"), obs(P1, "L1", "damaged", "1")],
    );
    expect(merged).toHaveLength(3);
  });
});
