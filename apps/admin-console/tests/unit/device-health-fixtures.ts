/** RT-1312 test data: `DeviceHealthView` rows with and without a sale queue. */
import { DEVICE_1, DUBAI_STORE } from "./device-fixtures";

export const HEARTBEAT_AT = "2026-11-10T08:30:00Z";
export const OLDEST_PENDING_AT = "2026-11-09T21:15:00Z";

export function saleQueue(over: Record<string, unknown> = {}) {
  return {
    pending: 0,
    deadLetter: 0,
    heldPreviousPairing: 0,
    oldestPendingAt: null,
    ...over,
  };
}

/** A device that beat at HEARTBEAT_AT; `saleQueue` defaults to an empty queue. */
export function health(over: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE_1,
    storeId: DUBAI_STORE,
    label: "Till 1",
    trustState: "active",
    appVersion: "1.4.0",
    updateChannel: "stable",
    updateState: "idle",
    pendingVersion: null,
    schemaHead: null,
    sourceClockAt: HEARTBEAT_AT,
    heartbeatAt: HEARTBEAT_AT,
    secondsSinceHeartbeat: 60,
    liveness: "online",
    compliance: "ok",
    minSupportedVersion: "1.0.0",
    minSupportedGraceUntil: null,
    activityLastSeenAt: null,
    lastSeenAt: HEARTBEAT_AT,
    lastSeenSource: "heartbeat",
    saleQueue: saleQueue(),
    ...over,
  };
}

/** A device that never beat: no heartbeat, so no sale queue (contract `if/then`). */
export function neverBeat(over: Record<string, unknown> = {}) {
  return health({
    heartbeatAt: null,
    secondsSinceHeartbeat: null,
    sourceClockAt: null,
    liveness: "unknown",
    compliance: "unknown",
    lastSeenAt: null,
    lastSeenSource: null,
    saleQueue: null,
    ...over,
  });
}

export function healthPage(items: unknown[], nextCursor: string | null = null) {
  return { status: 200, data: { items, nextCursor } };
}
