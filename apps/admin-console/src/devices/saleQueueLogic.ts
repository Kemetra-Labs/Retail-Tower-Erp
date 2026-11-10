/**
 * RT-1312: the till's unsent sales, as one state per device. Four states, never
 * folded into each other: still loading; unavailable (the health read was refused
 * or failed, or the device has no health row in it); Unknown (`saleQueue: null`:
 * the device never beat, or its last beat carried no queue, so never 0); and the
 * counts, as of the last stored heartbeat. A refused (dead-letter) sale or a sale
 * held from an earlier pairing is an attention state; pending alone is not, and no
 * staleness threshold is invented for it.
 */
import type { DeviceHealthPage, DeviceHealthView } from "@/lib/device-health-queries";

/** Where the health read stands: `ready` once it settled with rows. */
export type HealthStatus = "loading" | "ready" | "unavailable" | "failed";

export type SaleQueueState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | {
      kind: "counts";
      pending: number;
      deadLetter: number;
      held: number;
      oldestPendingAt: string | null;
      heartbeatAt: string;
      attention: boolean;
    };

export function saleQueueStateOf(
  row: DeviceHealthView | undefined,
  status: HealthStatus,
): SaleQueueState {
  if (status === "loading") return { kind: "loading" };
  if (status !== "ready" || !row) return { kind: "unavailable" };
  const queue = row.saleQueue;
  if (!queue || !row.heartbeatAt) return { kind: "unknown" };
  return {
    kind: "counts",
    pending: queue.pending,
    deadLetter: queue.deadLetter,
    held: queue.heldPreviousPairing,
    oldestPendingAt: queue.oldestPendingAt,
    heartbeatAt: row.heartbeatAt,
    attention: queue.deadLetter > 0 || queue.heldPreviousPairing > 0,
  };
}

/** True when the device holds a refused sale or a sale from an earlier pairing. */
export function hasStrandedSales(state: SaleQueueState): boolean {
  return state.kind === "counts" && state.attention;
}

/** The health rows of every page, by `deviceId` (the join key with the device list). */
export function healthIndex(pages: readonly DeviceHealthPage[]): Map<string, DeviceHealthView> {
  return new Map(pages.flatMap((p) => p.items).map((row) => [row.deviceId, row]));
}
