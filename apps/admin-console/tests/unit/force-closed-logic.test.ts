/**
 * RT-1440 (U1) A4: the read-only list of shifts closed without a count, read from the audit
 * search (`action=shift.force_closed`). The audit row carries ids, codes and counts only: never
 * the reason (D5a). Rows are read defensively: an item that is not a force-close audit row is
 * dropped, never shown half-filled.
 */
import {
  FORCE_CLOSED_ACTION,
  FORCE_CLOSED_WINDOW_DAYS,
  forceClosedRowOf,
  forceClosedRows,
  windowStart,
} from "@/force-actions/forceClosedLogic";
import { describe, expect, it } from "vitest";

const event = (over: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  id: "0198a0c4-0000-7000-8000-0000000000e1",
  occurred_at: "2026-11-16T22:41:00Z",
  actor_user_id: "0198a0c4-0000-7000-8000-000000000e01",
  tenant_id: "0198a0c4-0000-7000-8000-000000000001",
  store_id: "0198a0c4-0000-7000-8000-000000000a01",
  action: FORCE_CLOSED_ACTION,
  kind: "change",
  target_type: "shift",
  target_id: "0198a0c4-0000-7000-8000-000000000b01",
  metadata: {
    shift_id: "0198a0c4-0000-7000-8000-000000000b01",
    channel: "console",
    actor_role: "owner",
    shift_age_minutes: 880,
    ...metadata,
  },
  ...over,
});

describe("forceClosedRowOf", () => {
  it("reads who, when, where, by which channel and how old the shift was", () => {
    expect(forceClosedRowOf(event())).toEqual({
      id: "0198a0c4-0000-7000-8000-0000000000e1",
      occurredAt: "2026-11-16T22:41:00Z",
      actorUserId: "0198a0c4-0000-7000-8000-000000000e01",
      actorRole: "owner",
      channel: "console",
      shiftId: "0198a0c4-0000-7000-8000-000000000b01",
      storeId: "0198a0c4-0000-7000-8000-000000000a01",
      ageMinutes: 880,
    });
  });

  it("a channel this build does not know reads as unknown, never as a guess", () => {
    expect(forceClosedRowOf(event({}, { channel: "api" }))?.channel).toBe("unknown");
    expect(forceClosedRowOf(event({}, { channel: undefined }))?.channel).toBe("unknown");
  });

  it("missing optional facts stay null (unknown, never zero)", () => {
    const row = forceClosedRowOf(event({ actor_user_id: null, store_id: null }, { actor_role: undefined, shift_age_minutes: undefined }));
    expect(row).toMatchObject({ actorUserId: null, storeId: null, actorRole: null, ageMinutes: null });
  });

  it("drops what is not a force-close audit row", () => {
    expect(forceClosedRowOf(event({ action: "store.deleted" }))).toBeNull();
    expect(forceClosedRowOf(event({ id: 7 }))).toBeNull();
    expect(forceClosedRowOf(event({ occurred_at: undefined }))).toBeNull();
    expect(forceClosedRowOf(event({ target_id: null }, { shift_id: undefined }))).toBeNull();
    expect(forceClosedRowOf(null)).toBeNull();
    expect(forceClosedRowOf("x")).toBeNull();
  });
});

describe("forceClosedRows replays", () => {
  it("a replayed audit row is the same close seen again, never a second one", () => {
    const rows = forceClosedRows([event({ id: "r1" }), event({ id: "r2" }, { replayed: true })]);
    expect(rows.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("forceClosedRows", () => {
  it("keeps the server's newest-first order and skips malformed items", () => {
    const rows = forceClosedRows([event({ id: "a1" }), { nope: true }, event({ id: "a2" })]);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("a non-list body has no rows", () => {
    expect(forceClosedRows(undefined)).toEqual([]);
    expect(forceClosedRows({})).toEqual([]);
  });
});

describe("windowStart", () => {
  it("is the start of the last 30 days, as an ISO instant", () => {
    expect(FORCE_CLOSED_WINDOW_DAYS).toBe(30);
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(windowStart(now)).toBe("2026-10-18T12:00:00.000Z");
  });
});
