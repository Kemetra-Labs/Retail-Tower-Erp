import { describe, expect, test } from "vitest";
import { DEVICE_1, DEVICE_2, DEVICE_3 } from "./device-fixtures";
import {
  HEARTBEAT_AT,
  OLDEST_PENDING_AT,
  health,
  neverBeat,
  saleQueue,
} from "./device-health-fixtures";

import { healthIndex, saleQueueStateOf } from "@/devices/saleQueueLogic";
import type { DeviceHealthView } from "@/lib/device-health-queries";

const row = (over: Record<string, unknown> = {}) => health(over) as DeviceHealthView;

describe("sale queue state (RT-1312)", () => {
  test("saleQueue null is Unknown, never a zero count", () => {
    const state = saleQueueStateOf(row({ saleQueue: null }), "ready");
    expect(state).toEqual({ kind: "unknown" });
  });

  test("a device that never beat is Unknown", () => {
    expect(saleQueueStateOf(neverBeat() as DeviceHealthView, "ready")).toEqual({
      kind: "unknown",
    });
  });

  test("counts carry the as-of heartbeat time and the oldest pending time", () => {
    const state = saleQueueStateOf(
      row({ saleQueue: saleQueue({ pending: 3, oldestPendingAt: OLDEST_PENDING_AT }) }),
      "ready",
    );
    expect(state).toEqual({
      kind: "counts",
      pending: 3,
      deadLetter: 0,
      held: 0,
      oldestPendingAt: OLDEST_PENDING_AT,
      heartbeatAt: HEARTBEAT_AT,
      attention: false,
    });
  });

  test("a refused (dead-letter) sale is an attention state", () => {
    const state = saleQueueStateOf(row({ saleQueue: saleQueue({ deadLetter: 1 }) }), "ready");
    expect(state.kind === "counts" && state.attention).toBe(true);
  });

  test("a sale held from an earlier pairing is an attention state", () => {
    const state = saleQueueStateOf(
      row({ saleQueue: saleQueue({ heldPreviousPairing: 2 }) }),
      "ready",
    );
    expect(state.kind === "counts" && state.attention).toBe(true);
  });

  test("pending alone is not an attention state (no invented staleness threshold)", () => {
    const state = saleQueueStateOf(row({ saleQueue: saleQueue({ pending: 40 }) }), "ready");
    expect(state.kind === "counts" && state.attention).toBe(false);
  });

  test("a read that failed or was refused is unavailable, not Unknown and not zero", () => {
    expect(saleQueueStateOf(undefined, "unavailable")).toEqual({ kind: "unavailable" });
    expect(saleQueueStateOf(undefined, "failed")).toEqual({ kind: "unavailable" });
  });

  test("a device missing from a settled health read is unavailable", () => {
    expect(saleQueueStateOf(undefined, "ready")).toEqual({ kind: "unavailable" });
  });

  test("while the read is in flight the state is loading", () => {
    expect(saleQueueStateOf(undefined, "loading")).toEqual({ kind: "loading" });
  });
});

describe("health index (RT-1312 join by deviceId)", () => {
  test("indexes every page's rows by deviceId, whatever their order", () => {
    const index = healthIndex([
      { items: [row({ deviceId: DEVICE_3 }), row({ deviceId: DEVICE_1 })], nextCursor: "c1" },
      { items: [row({ deviceId: DEVICE_2, saleQueue: null })], nextCursor: null },
    ]);
    expect([...index.keys()].sort()).toEqual([DEVICE_1, DEVICE_2, DEVICE_3].sort());
    expect(index.get(DEVICE_2)?.saleQueue).toBeNull();
  });
});
