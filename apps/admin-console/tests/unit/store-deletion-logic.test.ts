/**
 * RT-1441 (U2): the client-side gates and tables of the store deletion. They only HIDE the control
 * or pick a catalog key (AC4); the server stays authoritative and answers 403 or 404 to anyone else
 * (D1), and decides every blocker, effect and verdict.
 */
import type { StoreDeletionPreview } from "@/lib/store-deletion-queries";
import {
  REASON_MAX,
  blockerRows,
  canDeleteStore,
  caveatKeys,
  commitReady,
  effectKeys,
  hasUnknownEffect,
  reasonProblem,
} from "@/store-deletion/storeDeletionLogic";
import { describe, expect, it } from "vitest";

const STORE = "0198a0c4-0000-7000-8000-000000000a01";
const DEV_A = "0198a0c4-0000-7000-8000-000000000d01";
const DEV_B = "0198a0c4-0000-7000-8000-000000000d02";
const DEV_C = "0198a0c4-0000-7000-8000-000000000d03";
const COUNT = "0198a0c4-0000-7000-8000-000000000e01";

function preview(over: Partial<StoreDeletionPreview> = {}): StoreDeletionPreview {
  return {
    store: { storeId: STORE, code: "DXB", name: "Dubai Mall", isActive: true },
    openShifts: [],
    devices: [],
    openCountSessions: [],
    warehouseMappings: [],
    singleStoreMembers: [],
    offersRebuiltCount: 0,
    effects: { willChange: [], willNotChange: [] },
    blockers: [],
    canDelete: true,
    reversible: false,
    reversibleAlternative: "suspend_store",
    caveats: [],
    previewFingerprint: "fp",
    evaluatedAt: "2026-11-17T10:00:00Z",
    ...over,
  };
}

describe("canDeleteStore", () => {
  it("is offered to the owner (D1) who is not a platform admin", () => {
    expect(canDeleteStore("owner", false, false)).toBe(true);
  });

  it("is hidden from tenant_admin and every other role, an unknown role and no role at all", () => {
    for (const role of ["tenant_admin", "store_manager", "cashier", "platform_admin", "", "x"]) {
      expect(canDeleteStore(role, false, false)).toBe(false);
    }
    expect(canDeleteStore(undefined, false, false)).toBe(false);
    expect(canDeleteStore(null, false, false)).toBe(false);
  });

  it("is hidden for the owner inside a support session when they are not a platform admin", () => {
    expect(canDeleteStore("owner", true, false)).toBe(false);
  });

  // RT-1462 (owner decision 2026-11-18): the server admits a platform admin whatever their role in
  // the tenant, with or without a support session, so the control follows.
  it("is offered to a platform admin whatever the membership role, or none", () => {
    for (const role of [
      "owner",
      "tenant_admin",
      "store_manager",
      "store_staff",
      "",
      "x",
      undefined,
      null,
    ]) {
      expect(canDeleteStore(role, false, true)).toBe(true);
    }
  });

  it("is offered to a platform admin inside a support session too", () => {
    expect(canDeleteStore(null, true, true)).toBe(true);
    expect(canDeleteStore("owner", true, true)).toBe(true);
  });
});

describe("reasonProblem and commitReady", () => {
  it("requires a reason of 1 to 200 characters, trimmed", () => {
    expect(reasonProblem("")).toBe("storeDeletion.reason.required");
    expect(reasonProblem("   ")).toBe("storeDeletion.reason.required");
    expect(reasonProblem("closed for good")).toBeNull();
    expect(reasonProblem("x".repeat(REASON_MAX))).toBeNull();
    expect(reasonProblem("x".repeat(REASON_MAX + 1))).toBe("storeDeletion.reason.tooLong");
  });

  const ok = { canDelete: true, reason: "closed", password: "pw", pending: false, fetching: false };

  it("commits only with the server's yes, a reason and a password", () => {
    expect(commitReady(ok)).toBe(true);
    expect(commitReady({ ...ok, canDelete: false })).toBe(false);
    expect(commitReady({ ...ok, reason: "  " })).toBe(false);
    expect(commitReady({ ...ok, password: "" })).toBe(false);
  });

  it("waits while a send or a re-read of the preview is in flight", () => {
    expect(commitReady({ ...ok, pending: true })).toBe(false);
    expect(commitReady({ ...ok, fetching: true })).toBe(false);
  });
});

describe("effects and caveats", () => {
  it("maps the contract's codes to catalog keys, in the server's order", () => {
    expect(
      effectKeys("willChange", ["devices_refused_immediately", "store_hidden_from_lists"]),
    ).toEqual([
      "storeDeletion.effect.willChange.devices_refused_immediately",
      "storeDeletion.effect.willChange.store_hidden_from_lists",
    ]);
    expect(effectKeys("willNotChange", ["warehouse_mapping_kept"])).toEqual([
      "storeDeletion.effect.willNotChange.warehouse_mapping_kept",
    ]);
  });

  it("drops a code this build does not know and reports it, never showing it raw", () => {
    expect(effectKeys("willChange", ["brand_new_effect"])).toEqual([]);
    expect(hasUnknownEffect("willChange", ["brand_new_effect"])).toBe(true);
    expect(hasUnknownEffect("willChange", ["store_hidden_from_lists"])).toBe(false);
  });

  it("gives one key per distinct caveat, and a generic one for an unknown caveat", () => {
    expect(
      caveatKeys(["queue_as_of_last_heartbeat", "queue_as_of_last_heartbeat", "weird"]),
    ).toEqual(["storeDeletion.caveat.queue_as_of_last_heartbeat", "storeDeletion.caveat.unknown"]);
  });
});

describe("blockerRows: each blocker is linked to its fix", () => {
  const devices: StoreDeletionPreview["devices"] = [
    { deviceId: DEV_A, label: "till-A", trustState: "active", lastSeenAt: null, queue: null },
    {
      deviceId: DEV_B,
      label: null,
      trustState: "revoked",
      lastSeenAt: "2026-11-16T08:00:00Z",
      queue: { pending: 0, deadLetter: 2, held: 0 },
    },
    {
      deviceId: DEV_C,
      label: "till-C",
      trustState: "retired",
      lastSeenAt: null,
      queue: { pending: 5, deadLetter: 0, held: 0 },
    },
  ];
  const full = preview({
    devices,
    openShifts: [
      {
        shiftId: "s1",
        openedAt: "2026-11-16T08:00:00Z",
        terminalLabel: null,
        forceCloseEligible: true,
      },
    ],
    openCountSessions: [{ sessionId: COUNT, status: "open" }],
  });

  it("an open shift links to the store's open shifts, once", () => {
    const [row] = blockerRows([{ code: "store_has_open_shift", count: 2 }], full, STORE);
    expect(row.messageKey).toBe("storeDeletion.blocker.store_has_open_shift");
    expect(row.count).toBe(2);
    expect(row.links).toEqual([{ kind: "shifts", to: `/stores/${STORE}/open-shifts` }]);
  });

  it("an unretired device links to each device that is not retired", () => {
    const [row] = blockerRows([{ code: "store_has_unretired_device", count: 2 }], full, STORE);
    expect(row.links).toEqual([
      { kind: "device", to: `/devices/${DEV_A}`, label: "till-A" },
      { kind: "device", to: `/devices/${DEV_B}`, label: null },
    ]);
  });

  it("an unsynced queue links to each non-retired device whose queue is unknown or not empty", () => {
    const [row] = blockerRows([{ code: "store_device_queue_unsynced", count: 2 }], full, STORE);
    expect(row.links.map((l) => (l.kind === "device" ? l.to : ""))).toEqual([
      `/devices/${DEV_A}`,
      `/devices/${DEV_B}`,
    ]);
  });

  it("a till with an empty queue is not linked", () => {
    const clean = preview({
      devices: [
        {
          deviceId: DEV_A,
          label: "till-A",
          trustState: "active",
          lastSeenAt: null,
          queue: { pending: 0, deadLetter: 0, held: 0 },
        },
      ],
    });
    const [row] = blockerRows([{ code: "store_device_queue_unsynced", count: 1 }], clean, STORE);
    expect(row.links).toEqual([]);
  });

  it("an open count session links to that session", () => {
    const [row] = blockerRows([{ code: "store_has_open_count_session", count: 1 }], full, STORE);
    expect(row.links).toEqual([
      { kind: "count", to: `/inventory/stores/${STORE}/counts/${COUNT}`, index: 1 },
    ]);
  });

  it("keeps the server's order and reads each distinct code once", () => {
    const rows = blockerRows(
      [
        { code: "store_has_open_count_session", count: 1 },
        { code: "store_has_open_shift", count: 1 },
        { code: "store_has_open_shift", count: 1 },
      ],
      full,
      STORE,
    );
    expect(rows.map((r) => r.messageKey)).toEqual([
      "storeDeletion.blocker.store_has_open_count_session",
      "storeDeletion.blocker.store_has_open_shift",
    ]);
  });

  it("an unknown code never leaks and has no link; an empty list still reads as a reason", () => {
    const [unknown] = blockerRows([{ code: "from_the_future", count: 3 }], full, STORE);
    expect(unknown.messageKey).toBe("storeDeletion.blocker.unknown");
    expect(unknown.links).toEqual([]);
    const [empty] = blockerRows([], full, STORE);
    expect(empty.messageKey).toBe("storeDeletion.blocker.unknown");
  });

  it("without a preview the rows still render, with no links", () => {
    const [row] = blockerRows([{ code: "store_has_unretired_device", count: 1 }], undefined, STORE);
    expect(row.links).toEqual([]);
  });
});
