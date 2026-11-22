import {
  type CreateDraft,
  type LineDraft,
  type Refused,
  actionsFor,
  buildApproveCommand,
  buildCancelCommand,
  buildCreateCommand,
  buildDispatchCommand,
  canWriteTransfers,
  cancelReasonError,
  expiryAt,
  hasCreateErrors,
  holdFor,
  isDuplicateLine,
  noteError,
  refusalOf,
  validateCreate,
} from "@/inventory/transfers/transferWriteLogic";
import { describe, expect, test } from "vitest";

const SRC = "0190f000-0000-7000-8000-0000000007a1";
const DST = "0190f000-0000-7000-8000-0000000007a2";
const P1 = "0190f000-0000-7000-8000-0000000007c1";
const P2 = "0190f000-0000-7000-8000-0000000007c2";
const BATCH = "0190f000-0000-7000-8000-0000000007f1";

function line(overrides: Partial<LineDraft> = {}): LineDraft {
  return {
    id: 1,
    productId: P1,
    name: "Olive oil",
    trackingMode: "none",
    identityId: null,
    quantity: "2.5",
    unit: "kg",
    ...overrides,
  };
}

function draft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return {
    sourceStoreId: SRC,
    destinationStoreId: DST,
    reason: "",
    lines: [line()],
    ...overrides,
  };
}

/** RT-1515 (PR 2): the pure helpers of the shipment-Transfer writes. */
describe("write roles and state gating", () => {
  test("only owner, tenant_admin and store_manager may write", () => {
    for (const role of ["owner", "tenant_admin", "store_manager"]) {
      expect(canWriteTransfers(role)).toBe(true);
    }
    for (const role of ["store_staff", "cashier", "auditor", "", null, undefined]) {
      expect(canWriteTransfers(role)).toBe(false);
    }
  });

  test("approve only in draft; cancel in draft or approved; dispatch only in approved", () => {
    expect(actionsFor("draft", "owner")).toEqual(["approve", "cancel"]);
    expect(actionsFor("approved", "store_manager")).toEqual(["dispatch", "cancel"]);
    for (const state of ["in_transit", "partially_received", "received", "closed", "cancelled"]) {
      expect(actionsFor(state, "owner")).toEqual([]);
    }
    expect(actionsFor("mystery", "owner")).toEqual([]);
  });

  test("a read-only role gets no action in any state", () => {
    expect(actionsFor("draft", "store_staff")).toEqual([]);
    expect(actionsFor("approved", null)).toEqual([]);
  });
});

describe("create validation and command", () => {
  test("a complete draft is valid and builds the strict command (no tenant, no actor)", () => {
    const d = draft({ reason: "  Weekend restock  ", lines: [line({ quantity: " 2.5 " })] });
    expect(hasCreateErrors(validateCreate(d))).toBe(false);
    expect(buildCreateCommand(d)).toEqual({
      sourceStoreId: SRC,
      destinationStoreId: DST,
      lines: [
        { tenantProductRef: P1, quantity: "2.5", stockingUnit: "kg", trackingIdentityId: null },
      ],
      reason: "Weekend restock",
    });
  });

  test("an empty reason is sent as null", () => {
    expect(buildCreateCommand(draft({ reason: "   " })).reason).toBeNull();
  });

  test("a batch line sends its identity; an untracked line always sends null", () => {
    const command = buildCreateCommand(
      draft({
        lines: [
          line({ id: 1, trackingMode: "batch", identityId: BATCH }),
          line({ id: 2, productId: P2, trackingMode: "none", identityId: BATCH }),
        ],
      }),
    );
    expect(command.lines.map((l) => l.trackingIdentityId)).toEqual([BATCH, null]);
  });

  test("source, destination, the same store, no lines and too many lines are refused", () => {
    expect(validateCreate(draft({ sourceStoreId: "" })).source).toBe(
      "transfers.create.error.source",
    );
    expect(validateCreate(draft({ destinationStoreId: "" })).destination).toBe(
      "transfers.create.error.destination",
    );
    expect(validateCreate(draft({ destinationStoreId: SRC })).destination).toBe(
      "transfers.create.error.sameStore",
    );
    expect(validateCreate(draft({ lines: [] })).lines).toBe("transfers.create.error.noLines");
    const many = Array.from({ length: 101 }, (_, i) => line({ id: i + 1, productId: `p${i}` }));
    expect(validateCreate(draft({ lines: many })).lines).toBe(
      "transfers.create.error.tooManyLines",
    );
    expect(validateCreate(draft({ lines: many.slice(0, 100) })).lines).toBeUndefined();
  });

  test("the reason is at most 500 characters", () => {
    expect(validateCreate(draft({ reason: "x".repeat(500) })).reason).toBeUndefined();
    expect(validateCreate(draft({ reason: "x".repeat(501) })).reason).toBe(
      "transfers.create.error.reason",
    );
  });

  test.each(["", "0", "0.0", "-1", "1e3", "1,5", "abc", "1.23456", " "])(
    "quantity %j is refused",
    (quantity) => {
      const errors = validateCreate(draft({ lines: [line({ quantity })] }));
      expect(errors.perLine[1]?.quantity).toBe("transfers.create.error.quantity");
    },
  );

  test.each(["1", "0.0001", "12.5", "999999999999999.9999"])(
    "quantity %j is accepted",
    (quantity) => {
      expect(validateCreate(draft({ lines: [line({ quantity })] })).perLine).toEqual({});
    },
  );

  test("an unknown or oversized stocking unit blocks the line", () => {
    for (const unit of [undefined, null, "", "  ", "u".repeat(33)]) {
      const errors = validateCreate(draft({ lines: [line({ unit })] }));
      expect(errors.perLine[1]?.unit).toBe("transfers.create.error.unit");
    }
  });

  test("a batch product needs one chosen batch; an untracked one does not", () => {
    const batch = validateCreate(draft({ lines: [line({ trackingMode: "batch" })] }));
    expect(batch.perLine[1]?.identity).toBe("transfers.create.error.identity");
    const chosen = validateCreate(
      draft({ lines: [line({ trackingMode: "batch", identityId: BATCH })] }),
    );
    expect(chosen.perLine).toEqual({});
  });

  test("the same product (and batch) twice is refused on the later line only", () => {
    const errors = validateCreate(
      draft({ lines: [line({ id: 1 }), line({ id: 2 }), line({ id: 3, productId: P2 })] }),
    );
    expect(errors.perLine[1]).toBeUndefined();
    expect(errors.perLine[2]?.duplicate).toBe("transfers.create.error.duplicate");
    expect(errors.perLine[3]).toBeUndefined();
    expect(hasCreateErrors(errors)).toBe(true);
  });

  test("one product in two different batches is not a duplicate", () => {
    const other = "0190f000-0000-7000-8000-0000000007f2";
    const lines = [
      line({ id: 1, trackingMode: "batch", identityId: BATCH }),
      line({ id: 2, trackingMode: "batch", identityId: other }),
    ];
    expect(validateCreate(draft({ lines })).perLine).toEqual({});
    expect(isDuplicateLine(lines, { productId: P1, identityId: BATCH })).toBe(true);
    expect(isDuplicateLine(lines, { productId: P1, identityId: null })).toBe(false);
  });
});

describe("approve, cancel and dispatch commands", () => {
  test("the expiry is days from the given moment, as an ISO date-time in the future", () => {
    const now = new Date("2026-11-22T10:00:00.000Z");
    expect(expiryAt(1, now)).toBe("2026-11-23T10:00:00.000Z");
    expect(expiryAt(3, now)).toBe("2026-11-25T10:00:00.000Z");
    expect(expiryAt(7, now)).toBe("2026-11-29T10:00:00.000Z");
    expect(new Date(buildApproveCommand(3, now).reservationExpiresAt).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  test("a cancel reason is required, 1 to 500 characters once trimmed", () => {
    expect(cancelReasonError("")).toBe("transfers.cancel.error.reason");
    expect(cancelReasonError("   ")).toBe("transfers.cancel.error.reason");
    expect(cancelReasonError("x".repeat(501))).toBe("transfers.cancel.error.reason");
    expect(cancelReasonError("x")).toBeUndefined();
    expect(cancelReasonError("x".repeat(500))).toBeUndefined();
    expect(buildCancelCommand("  Wrong store ")).toEqual({ reason: "Wrong store" });
  });

  test("a dispatch note is optional and at most 500 characters; empty is null", () => {
    expect(noteError("")).toBeUndefined();
    expect(noteError("x".repeat(500))).toBeUndefined();
    expect(noteError("x".repeat(501))).toBe("transfers.dispatch.error.note");
    expect(buildDispatchCommand("  ")).toEqual({ note: null });
    expect(buildDispatchCommand(" Two pallets ")).toEqual({ note: "Two pallets" });
  });
});

describe("idempotency keys", () => {
  test("the same input reuses its key and its body; the body is not rebuilt", () => {
    let builds = 0;
    const build = () => ({ n: ++builds });
    const first = holdFor(null, { a: 1 }, build);
    const again = holdFor(first, { a: 1 }, build);
    expect(again).toBe(first);
    expect(again.command).toEqual({ n: 1 });
    expect(builds).toBe(1);
  });

  test("any edit starts a new key and a new body", () => {
    const first = holdFor(null, { a: 1 }, () => "one");
    const edited = holdFor(first, { a: 2 }, () => "two");
    expect(edited.key).not.toBe(first.key);
    expect(edited.command).toBe("two");
  });

  test("a key is a v4 UUID, inside the contract's 16 to 128 printable ASCII characters", () => {
    const { key } = holdFor(null, {}, () => 0);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the approve body keeps its first expiry on a retry of the same choice", () => {
    const t1 = new Date("2026-11-22T10:00:00.000Z");
    const t2 = new Date("2026-11-22T10:00:30.000Z");
    const first = holdFor(null, { days: 3 }, () => buildApproveCommand(3, t1));
    const retry = holdFor(first, { days: 3 }, () => buildApproveCommand(3, t2));
    expect(retry.command.reservationExpiresAt).toBe("2026-11-25T10:00:00.000Z");
  });
});

describe("refusals worded by error.code", () => {
  const rejected = (status: number, code?: string, extra: Partial<Refused> = {}): Refused => ({
    kind: "rejected",
    status,
    code,
    message: "server words that must never show",
    ...extra,
  });

  test.each([
    ["validation_error", "transfers.write.error.validation"],
    ["forbidden", "transfers.write.error.forbidden"],
    ["not_found", "transfers.write.error.notFound"],
    ["shipment_transfer_not_in_state", "transfers.write.error.notInState"],
    ["cross_legal_entity_transfer", "transfers.write.error.crossLegalEntity"],
    ["tracking_identity_required", "transfers.write.error.identityRequired"],
    ["tracking_identity_held_or_expired", "transfers.write.error.identityHeldOrExpired"],
    ["serial_transfer_not_supported", "transfers.write.error.serialNotSupported"],
    ["transfer_warehouse_unmapped", "transfers.write.error.warehouseUnmapped"],
    ["transfer_item_unmapped", "transfers.write.error.itemUnmapped"],
    ["idempotency_key_conflict", "transfers.write.error.keyConflict"],
    ["over_receipt_requires_approval", "transfers.write.error.overReceipt"],
    ["short_close_reason_required", "transfers.write.error.shortCloseReason"],
  ])("%s has its own copy", (code, key) => {
    expect(refusalOf(rejected(409, code))).toEqual({ key, wait: undefined });
  });

  test("the code wins over the status", () => {
    expect(refusalOf(rejected(500, "forbidden")).key).toBe("transfers.write.error.forbidden");
  });

  test("with no code the status decides: 400, 401, 403, 404, 429", () => {
    expect(refusalOf(rejected(400)).key).toBe("transfers.write.error.validation");
    expect(refusalOf(rejected(401)).key).toBe("transfers.write.error.session");
    expect(refusalOf(rejected(403)).key).toBe("transfers.write.error.forbidden");
    expect(refusalOf(rejected(404)).key).toBe("transfers.write.error.notFound");
    expect(refusalOf(rejected(429)).key).toBe("transfers.write.error.rateLimited");
  });

  test("a 429 carries the server's wait", () => {
    expect(refusalOf(rejected(429, "rate_limited", { retryAfter: 12 }))).toEqual({
      key: "transfers.write.error.rateLimited",
      wait: 12,
    });
  });

  test("a 5xx without a code is generic with no code shown", () => {
    expect(refusalOf(rejected(503))).toEqual({
      key: "transfers.write.error.generic",
      unknownCode: undefined,
    });
  });

  test("an unknown code is generic copy plus the code, never the message", () => {
    const refusal = refusalOf(rejected(409, "brand_new_code"));
    expect(refusal).toEqual({
      key: "transfers.write.error.generic",
      unknownCode: "brand_new_code",
    });
    expect(JSON.stringify(refusal)).not.toContain("server words");
  });
});
