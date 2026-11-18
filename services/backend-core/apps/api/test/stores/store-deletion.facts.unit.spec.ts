/**
 * RT-1453: `readStoreDeletionFacts` over the owning-module ports (DB-less: every port is replaced).
 *
 * The facts are the ONE evaluator behind the store-deletion preview and write. This pins what the move
 * onto ports must keep: the exact counts are over the whole store while the lists are capped, a member
 * is "single-store" only when this is their only LIVE store (decided against `stores` here), the member
 * cap applies AFTER that filter in user-id order, the write path reads no per-shift eligibility, and
 * nothing is read from `stores` when there is no candidate member.
 */
import type { PoolClient } from "pg";

import { readStoreDeletionFacts } from "../../src/stores/deletion/store-deletion.facts";

const mockReadStoreOpenShifts = jest.fn();
const mockListStoreOpenShifts = jest.fn();
const mockCountStoreOpenShifts = jest.fn();
const mockReadStoreDeviceFacts = jest.fn();
const mockCountOpenCountSessions = jest.fn();
const mockListOpenCountSessions = jest.fn();
const mockWarehouseRefs = jest.fn();
const mockMembers = jest.fn();
const mockOffersCount = jest.fn();

jest.mock("../../src/pos-shifts", () => ({
  readStoreOpenShifts: (...a: unknown[]) => mockReadStoreOpenShifts(...a),
  listStoreOpenShifts: (...a: unknown[]) => mockListStoreOpenShifts(...a),
  countStoreOpenShifts: (...a: unknown[]) => mockCountStoreOpenShifts(...a),
}));
jest.mock("../../src/device-health", () => ({ readStoreDeviceFacts: (...a: unknown[]) => mockReadStoreDeviceFacts(...a) }));
jest.mock("../../src/inventory", () => ({
  countOpenCountSessionsOfStore: (...a: unknown[]) => mockCountOpenCountSessions(...a),
  listOpenCountSessionsOfStore: (...a: unknown[]) => mockListOpenCountSessions(...a),
}));
jest.mock("../../src/catalog", () => ({ listActiveWarehouseRefsOfStore: (...a: unknown[]) => mockWarehouseRefs(...a) }));
jest.mock("../../src/memberships", () => ({ listSpecificAccessMembersOfStore: (...a: unknown[]) => mockMembers(...a) }));
jest.mock("../../src/offers", () => ({ countOffersInPackOfStore: (...a: unknown[]) => mockOffersCount(...a) }));

const TENANT = "0e170000-0000-4000-8000-0000000a0001";
const STORE = "0e170000-0000-4000-8000-0000000a5001";
const store = { storeId: STORE, code: "S1", name: "Store 1", isActive: true };

const record = (n: number) => ({
  shift: { shiftId: `shift-${n}`, openedAt: new Date(`2026-11-16T0${n}:00:00Z`) },
  cashierDisplayName: null,
  terminal: { label: `till-${n}`, lastSeenAt: null, trustState: "active" },
});

function fakeClient(liveStoreIds: string[]) {
  const stores: unknown[][] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      if (/FROM stores/.test(sql)) {
        stores.push(params);
        const asked = params[0] as string[];
        return { rows: asked.filter((id) => liveStoreIds.includes(id)).map((id) => ({ id })) };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as unknown as PoolClient;
  return { client, stores };
}

beforeEach(() => {
  mockReadStoreOpenShifts.mockResolvedValue([]);
  mockListStoreOpenShifts.mockResolvedValue([]);
  mockCountStoreOpenShifts.mockResolvedValue(0);
  mockReadStoreDeviceFacts.mockResolvedValue([]);
  mockCountOpenCountSessions.mockResolvedValue(0);
  mockListOpenCountSessions.mockResolvedValue([]);
  mockWarehouseRefs.mockResolvedValue([]);
  mockMembers.mockResolvedValue([]);
  mockOffersCount.mockResolvedValue(0);
});

describe("readStoreDeletionFacts counts and lists", () => {
  it("derives the device counts from every row while the list is capped at 500, an unknown queue counts as unsynced", async () => {
    const rows = Array.from({ length: 502 }, (_, i) => ({
      deviceId: `d-${String(i).padStart(4, "0")}`,
      label: null,
      trustState: i < 500 ? "retired" : "active",
      lastSeenAt: null,
      queue: i === 500 ? null : { pending: 0, deadLetter: 0, held: 0 }, // 500: unknown queue; 501: zero queue
    }));
    mockReadStoreDeviceFacts.mockResolvedValue(rows);
    const { client } = fakeClient([]);
    const facts = await readStoreDeletionFacts(client, store, TENANT);
    expect(facts.counts).toMatchObject({ totalDevices: 502, unretiredDevices: 2, unsyncedDevices: 1 });
    expect(facts.devices).toHaveLength(500);
    expect(facts.devices[0]!.deviceId).toBe("d-0000");
  });

  it("a queued, dead-lettered or held sale makes a non-retired till unsynced; a retired till never does", async () => {
    mockReadStoreDeviceFacts.mockResolvedValue([
      { deviceId: "a", label: null, trustState: "active", lastSeenAt: null, queue: { pending: 1, deadLetter: 0, held: 0 } },
      { deviceId: "b", label: null, trustState: "revoked", lastSeenAt: null, queue: { pending: 0, deadLetter: 1, held: 0 } },
      { deviceId: "c", label: null, trustState: "active", lastSeenAt: null, queue: { pending: 0, deadLetter: 0, held: 1 } },
      { deviceId: "d", label: null, trustState: "retired", lastSeenAt: null, queue: { pending: 9, deadLetter: 9, held: 9 } },
    ]);
    const facts = await readStoreDeletionFacts(fakeClient([]).client, store, TENANT);
    expect(facts.counts).toMatchObject({ totalDevices: 4, unretiredDevices: 3, unsyncedDevices: 3 });
  });

  it("takes the exact shift and Count Session counts from the ports and caps the lists (200, 200, 50)", async () => {
    mockCountStoreOpenShifts.mockResolvedValue(1234);
    mockCountOpenCountSessions.mockResolvedValue(4321);
    await readStoreDeletionFacts(fakeClient([]).client, store, TENANT);
    expect(mockReadStoreOpenShifts).toHaveBeenCalledWith(expect.anything(), { tenantId: TENANT, storeId: STORE }, { limit: 200, order: "oldest_first" });
    expect(mockListOpenCountSessions).toHaveBeenCalledWith(expect.anything(), STORE, 200);
    expect(mockWarehouseRefs).toHaveBeenCalledWith(expect.anything(), STORE, 50);
    const facts = await readStoreDeletionFacts(fakeClient([]).client, store, TENANT);
    expect(facts.counts).toMatchObject({ openShifts: 1234, openCountSessions: 4321 });
  });
});

describe("readStoreDeletionFacts shift eligibility", () => {
  it("the preview states each shift's eligibility from the verdict-reading port", async () => {
    mockReadStoreOpenShifts.mockResolvedValue([
      { ...record(1), forceCloseEligible: true },
      { ...record(2), forceCloseEligible: false },
    ]);
    const facts = await readStoreDeletionFacts(fakeClient([]).client, store, TENANT);
    expect(facts.openShifts.map((s) => [s.shiftId, s.terminalLabel, s.forceCloseEligible])).toEqual([
      ["shift-1", "till-1", true],
      ["shift-2", "till-2", false],
    ]);
    expect(mockListStoreOpenShifts).not.toHaveBeenCalled();
  });

  it("the write path (withEligibility: false) lists the shifts without a verdict and leaves eligibility null", async () => {
    mockListStoreOpenShifts.mockResolvedValue([record(1), record(2)]);
    const facts = await readStoreDeletionFacts(fakeClient([]).client, store, TENANT, { withEligibility: false });
    expect(mockReadStoreOpenShifts).not.toHaveBeenCalled();
    expect(facts.openShifts.map((s) => [s.shiftId, s.forceCloseEligible])).toEqual([
      ["shift-1", null],
      ["shift-2", null],
    ]);
  });
});

describe("readStoreDeletionFacts single-store members", () => {
  it("reads nothing from stores when no member has specific access to the store", async () => {
    const { client, stores } = fakeClient([]);
    const facts = await readStoreDeletionFacts(client, store, TENANT);
    expect(stores).toHaveLength(0);
    expect(facts.singleStoreMembers).toEqual([]);
  });

  it("a member counts when this is their only LIVE store, not when they reach another live one", async () => {
    mockMembers.mockResolvedValue([
      { userId: "only", roleCode: "store_manager", storeIds: [STORE] },
      { userId: "with-deleted", roleCode: "cashier", storeIds: [STORE, "gone"] },
      { userId: "with-live", roleCode: "cashier", storeIds: [STORE, "live-2"] },
    ]);
    const { client, stores } = fakeClient([STORE, "live-2"]); // "gone" is soft-deleted
    const facts = await readStoreDeletionFacts(client, store, TENANT);
    expect(facts.singleStoreMembers).toEqual([
      { userId: "only", roleCode: "store_manager" },
      { userId: "with-deleted", roleCode: "cashier" },
    ]);
    expect(stores).toEqual([[[STORE, "gone", "live-2"], TENANT]]); // one read, tenant bound, each store once
  });

  it("caps at 500 AFTER the filter, in user-id order (a capped-first read would drop a qualifying member)", async () => {
    // 500 multi-store members first (they do not qualify), then 3 single-store ones: all 3 must survive.
    const multi = Array.from({ length: 500 }, (_, i) => ({ userId: `m-${String(i).padStart(4, "0")}`, roleCode: "cashier", storeIds: [STORE, "live-2"] }));
    const single = ["z-1", "z-2", "z-3"].map((userId) => ({ userId, roleCode: "cashier", storeIds: [STORE] }));
    mockMembers.mockResolvedValue([...multi, ...single]);
    const facts = await readStoreDeletionFacts(fakeClient([STORE, "live-2"]).client, store, TENANT);
    expect(facts.singleStoreMembers.map((m) => m.userId)).toEqual(["z-1", "z-2", "z-3"]);

    const many = Array.from({ length: 600 }, (_, i) => ({ userId: `u-${String(i).padStart(4, "0")}`, roleCode: "cashier", storeIds: [STORE] }));
    mockMembers.mockResolvedValue(many);
    const capped = await readStoreDeletionFacts(fakeClient([STORE]).client, store, TENANT);
    expect(capped.singleStoreMembers).toHaveLength(500);
    expect(capped.singleStoreMembers[0]!.userId).toBe("u-0000");
    expect(capped.singleStoreMembers[499]!.userId).toBe("u-0499");
  });
});

describe("readStoreDeletionFacts other ports", () => {
  it("passes the warehouse refs and the Offer Pack count through", async () => {
    mockWarehouseRefs.mockResolvedValue(["Stores - RT"]);
    mockOffersCount.mockResolvedValue(4);
    const facts = await readStoreDeletionFacts(fakeClient([]).client, store, TENANT);
    expect(facts.warehouseMappings).toEqual(["Stores - RT"]);
    expect(facts.offersRebuiltCount).toBe(4);
    expect(mockOffersCount).toHaveBeenCalledWith(expect.anything(), STORE);
  });
});
