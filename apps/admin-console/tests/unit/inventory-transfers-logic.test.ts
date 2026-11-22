import {
  filterFromParams,
  hasFilter,
  isNotAvailable,
  legStateKey,
  legStateTone,
  paramsFromFilter,
  receiptRowsOf,
  timelineOf,
  transferErrorOf,
  transferStateKey,
  transferStateTone,
} from "@/inventory/transfers/transferLogic";
import type { ShipmentTransfer, ShipmentTransferReceipt } from "@/lib/inventory-queries";
import { describe, expect, test } from "vitest";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const LINE_1 = "0190f000-0000-7000-8000-00000000b001";
const LINE_2 = "0190f000-0000-7000-8000-00000000b002";
const ME = "0190f000-0000-7000-8000-0000000000a1";

function transfer(overrides: Partial<ShipmentTransfer> = {}): ShipmentTransfer {
  return {
    id: "0190f000-0000-7000-8000-00000000a001",
    sourceStoreId: STORE,
    destinationStoreId: "0190f000-0000-7000-8000-0000000007a2",
    state: "draft",
    lines: [
      { id: LINE_1, lineSeq: 1 } as ShipmentTransfer["lines"][number],
      { id: LINE_2, lineSeq: 2 } as ShipmentTransfer["lines"][number],
    ],
    reason: null,
    createdBy: ME,
    createdAt: "2026-11-20T08:00:00Z",
    approval: null,
    reservation: null,
    dispatch: null,
    dispatchIntegrationState: null,
    shortClose: null,
    closure: null,
    cancellation: null,
    receiptCount: 0,
    updatedAt: "2026-11-20T08:00:00Z",
    ...overrides,
  };
}

/** RT-1515 (PR 1): the pure helpers of the read-only shipment-Transfer views. */
describe("transfer states and ERP legs", () => {
  test("every contract state has its own key; an unknown one is Unknown in the danger role", () => {
    expect(transferStateKey("in_transit")).toBe("transfers.state.in_transit");
    expect(transferStateKey("cancelled")).toBe("transfers.state.cancelled");
    expect(transferStateKey("lost")).toBe("transfers.value.unknown");
    expect(transferStateTone("in_transit")).toBe("badge--pending");
    expect(transferStateTone("partially_received")).toBe("badge--pending");
    expect(transferStateTone("received")).toBe("");
    expect(transferStateTone("lost")).toBe("badge--danger");
  });

  test("a leg's state: null is not dispatched yet, never 'not recorded' or zero", () => {
    expect(legStateKey(null)).toBe("transfers.leg.notDispatched");
    expect(legStateKey(undefined)).toBe("transfers.leg.notDispatched");
    expect(legStateKey("not_posted")).toBe("transfers.leg.not_posted");
    expect(legStateKey("reconciliation_required")).toBe("transfers.leg.reconciliation_required");
    expect(legStateKey("mystery")).toBe("transfers.value.unknown");
    expect(legStateTone(null)).toBe("");
    expect(legStateTone("not_posted")).toBe("");
    expect(legStateTone("confirmed")).toBe("badge--success");
    expect(legStateTone("rejected")).toBe("badge--danger");
    expect(legStateTone("mystery")).toBe("badge--danger");
  });
});

describe("filters in the URL", () => {
  test("only values the contract accepts are read; direction only with a store", () => {
    expect(filterFromParams(new URLSearchParams())).toEqual({});
    expect(
      filterFromParams(
        new URLSearchParams({ store: STORE, direction: "inbound", state: "received" }),
      ),
    ).toEqual({ storeId: STORE, direction: "inbound", state: "received" });
    expect(filterFromParams(new URLSearchParams({ direction: "inbound" }))).toEqual({});
    expect(
      filterFromParams(
        new URLSearchParams({ store: "not-a-uuid", state: "lost", direction: "up" }),
      ),
    ).toEqual({});
    expect(filterFromParams(new URLSearchParams({ store: STORE, direction: "up" }))).toEqual({
      storeId: STORE,
    });
  });

  test("params drop `any` and a direction without a store", () => {
    expect(paramsFromFilter({})).toEqual({});
    expect(paramsFromFilter({ storeId: STORE, direction: "any", state: "draft" })).toEqual({
      store: STORE,
      state: "draft",
    });
    expect(paramsFromFilter({ storeId: STORE, direction: "outbound" })).toEqual({
      store: STORE,
      direction: "outbound",
    });
    expect(paramsFromFilter({ direction: "outbound" })).toEqual({});
    expect(hasFilter({})).toBe(false);
    expect(hasFilter({ state: "draft" })).toBe(true);
    expect(hasFilter({ storeId: STORE })).toBe(true);
  });
});

describe("errors keyed by error.code", () => {
  test("the code wins over the status; an unknown or missing code keeps the status kind", () => {
    expect(transferErrorOf({ kind: "generic", code: "not_found" }).kind).toBe("not-found");
    expect(transferErrorOf({ kind: "generic", code: "forbidden" }).kind).toBe("forbidden");
    expect(transferErrorOf({ kind: "generic", code: "unauthorized" }).kind).toBe("session");
    expect(transferErrorOf({ kind: "generic", code: "validation_error" }).kind).toBe("rejected");
    expect(transferErrorOf({ kind: "generic", code: "rate_limited" }).kind).toBe("rate-limited");
    expect(transferErrorOf({ kind: "not-found", code: "internal_error" }).kind).toBe("not-found");
    expect(transferErrorOf({ kind: "generic" }).kind).toBe("generic");
  });

  test("the list's 404 is 'not available', other failures are not", () => {
    expect(isNotAvailable(undefined)).toBe(false);
    expect(isNotAvailable({ kind: "not-found" })).toBe(true);
    expect(isNotAvailable({ kind: "generic", code: "not_found" })).toBe(true);
    expect(isNotAvailable({ kind: "generic", code: "internal_error" })).toBe(false);
  });
});

describe("detail", () => {
  test("the timeline holds only the stamps the Transfer carries, in lifecycle order", () => {
    expect(timelineOf(transfer()).map((e) => e.key)).toEqual(["transfers.detail.createdAt"]);
    const full = transfer({
      approval: { by: ME, at: "2026-11-20T09:00:00Z" },
      dispatch: { by: ME, at: "2026-11-20T10:00:00Z" },
      shortClose: { approvedBy: ME, approvedAt: "2026-11-21T10:00:00Z", reason: "lost" },
      closure: { by: ME, at: "2026-11-21T11:00:00Z" },
      cancellation: { cancelledBy: ME, cancelledAt: "2026-11-21T12:00:00Z", reason: "x" },
    });
    expect(timelineOf(full)).toEqual([
      { key: "transfers.detail.createdAt", at: "2026-11-20T08:00:00Z" },
      { key: "transfers.detail.approvedAt", at: "2026-11-20T09:00:00Z" },
      { key: "transfers.detail.dispatchedAt", at: "2026-11-20T10:00:00Z" },
      { key: "transfers.detail.shortClosedAt", at: "2026-11-21T10:00:00Z" },
      { key: "transfers.detail.closedAt", at: "2026-11-21T11:00:00Z" },
      { key: "transfers.detail.cancelledAt", at: "2026-11-21T12:00:00Z" },
    ]);
  });

  test("receipt rows name each line by its sequence; an unknown line has none", () => {
    const receipt = {
      id: "r1",
      transferId: "t",
      receivedBy: ME,
      receivedAt: "2026-11-21T08:00:00Z",
      note: null,
      integrationState: "pending",
      lines: [
        {
          transferLineId: LINE_2,
          quantity: "2",
          inventoryStatus: "sellable",
          stockLocationId: "l",
          movementId: "m1",
        },
        {
          transferLineId: "gone",
          quantity: "1",
          inventoryStatus: "damaged",
          stockLocationId: "l",
          movementId: "m2",
        },
      ],
    } as ShipmentTransferReceipt;
    const rows = receiptRowsOf([receipt], transfer());
    expect(rows.map((r) => [r.index, r.lineSeq, r.quantity, r.inventoryStatus])).toEqual([
      [0, 2, "2", "sellable"],
      [1, undefined, "1", "damaged"],
    ]);
    expect(receiptRowsOf([receipt], undefined)[0].lineSeq).toBeUndefined();
  });
});
