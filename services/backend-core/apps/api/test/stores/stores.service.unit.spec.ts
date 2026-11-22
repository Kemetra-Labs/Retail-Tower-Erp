/**
 * stores.service.unit.spec.ts
 *
 * Docker-free unit coverage for StoresService.
 *
 * Strategy:
 *   - Construct StoresService with a fake TxRunner injected via the
 *     `@Optional() tx` constructor parameter. The fake tx calls
 *     `work(fakeClient)` directly, bypassing `runWithTenantContext`.
 *   - Mock StoresRepository and MembershipRepository with per-test
 *     jest.fn() overrides.
 *   - Mock `@data-pulse-2/shared` (newId) for determinism.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake TxRunner bypasses `runWithTenantContext` and the fake repository
 * resolves whatever rows are stubbed — RLS is a DB-layer guarantee tested
 * only with a real Postgres instance (Testcontainers integration spec).
 *
 * The `tx ?? runWithTenantContext` constructor fallback (when `tx` is
 * omitted) is intentionally deferred — exercising it requires a real
 * Postgres pool, which is out of scope for unit coverage. All tests
 * supply the fake tx runner explicitly.
 */

import "reflect-metadata";
import {
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Module mocks — must be declared BEFORE any imports that exercise them
// ---------------------------------------------------------------------------

jest.mock("@data-pulse-2/shared", () => ({
  // RT-125: real queue names (read at module load by queue producers).
  QUEUE_NAMES: jest.requireActual("@data-pulse-2/shared").QUEUE_NAMES,
  // RT-812: the boot grant check loads its fragments at import (auth.module).
  loadFragmentDir: jest.requireActual("@data-pulse-2/shared").loadFragmentDir,
  // RT-1211: the api InstrumentedPool wraps pg.Pool at import (auth.module -> database-pools).
  withSlowQueryRecorder: jest.requireActual("@data-pulse-2/shared").withSlowQueryRecorder,
  newId: jest.fn(),
  assertMetricLabels: jest.fn(),
  getMeter: jest.fn(() => ({
    createCounter: jest.fn(() => ({ add: jest.fn() })),
    createHistogram: jest.fn(() => ({ record: jest.fn() })),
    createObservableGauge: jest.fn(() => ({ addCallback: jest.fn(), removeCallback: jest.fn() })),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { StoresService } from "../../src/stores/stores.service";
import type { StorePricingLifecycle } from "../../src/stores";
import type {
  StoreRecord,
  StoresRepository,
} from "../../src/stores/stores.repository";
import type {
  ActiveMembership,
  MembershipRepository,
} from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";

import { newId } from "@data-pulse-2/shared";
import {
  readStoreDeletionFacts,
  type StoreDeletionFacts,
} from "../../src/stores/deletion/store-deletion.facts";
import { deleteStoreWithAudit } from "../../src/stores/deletion/store-deletion.write";

// RT-1337: store create / delete refresh the offer Pack; these unit specs run on a bare fake client.
// RT-1439: the deletion evaluator and writer have their own real-database specs
// (stores.deletion.http.integration.spec.ts); here only the orchestration of softDelete is pinned.
jest.mock("../../src/stores/deletion/store-deletion.facts", () => ({
  ...jest.requireActual("../../src/stores/deletion/store-deletion.facts"),
  readStoreDeletionFacts: jest.fn(),
}));
jest.mock("../../src/stores/deletion/store-deletion.write", () => ({
  deleteStoreWithAudit: jest.fn(async () => new Date("2026-11-16T22:45:00Z")),
}));

// RT-1484 PR-5 (spec 042 §8): Store lifecycle writes take the pricing publish lock and write the
// bootstrap row; these unit specs run on a bare fake client, so the helpers are recorded instead.
const mockPricingCalls: string[] = [];
// RT-1525: the stores port `StorePricingLifecycle`, injected (Pricing's adapter in production).
const mockPricingLifecycle: StorePricingLifecycle = {
  lockForStoreWrite: async () => {
    mockPricingCalls.push("lock");
  },
  bootstrapStore: async () => {
    mockPricingCalls.push("bootstrap");
  },
};

jest.mock("../../src/offers/offer-pack.rebuild", () => ({
  rebuildOfferPackForStoreChange: jest.fn(async () => ({ revision: null, changedStoreIds: [] })),
}));

const mockNewId = newId as jest.MockedFunction<typeof newId>;
const mockFacts = readStoreDeletionFacts as jest.MockedFunction<typeof readStoreDeletionFacts>;

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const USER_ID       = "0193c000-0000-7000-8000-0000000000a1";
const TENANT_ID     = "0193c000-0000-7000-8000-0000000000b2";
const STORE_ID      = "0193c000-0000-7000-8000-0000000000c3";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-0000000000d4";

const NOW = new Date("2026-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeStoreRecord(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "MAIN",
    name: "Main Store",
    timezone: "UTC",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeActiveMembership(
  overrides: Partial<ActiveMembership> = {},
): ActiveMembership {
  return {
    membershipId: MEMBERSHIP_ID,
    storeAccessKind: "all",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake repositories — jest.fn() fields, overridden per-test
// ---------------------------------------------------------------------------

function makeFakeStoresRepo(): jest.Mocked<StoresRepository> {
  return {
    listInTenant:    jest.fn(),
    findById:        jest.fn(),
    create:          jest.fn(),
    update:          jest.fn(),
    softDelete:      jest.fn(),
    existsInTenant:  jest.fn(),
    findByIdForUpdate: jest.fn(),
    markDeleted:     jest.fn(),
  } as unknown as jest.Mocked<StoresRepository>;
}

function makeFakeMembershipsRepo(): jest.Mocked<MembershipRepository> {
  return {
    isPlatformAdmin:             jest.fn(),
    findActiveMembership:        jest.fn(),
    canAccessStore:              jest.fn(),
    listForUser:                 jest.fn(),
    findRoleCodeForUserInTenant: jest.fn(),
    findTenantSummary:           jest.fn(),
    findStoreSummary:            jest.fn(),
    findUserSummary:             jest.fn(),
    listForTenant:               jest.fn(),
  } as unknown as jest.Mocked<MembershipRepository>;
}

// ---------------------------------------------------------------------------
// TxRunner fake — synchronously calls work(fakeClient)
// ---------------------------------------------------------------------------

const fakeClient = {} as PoolClient;
const fakePool   = {} as Pool;

function makeFakeTx() {
  return jest.fn(
    async <T>(
      _pool: Pool,
      _ctx: unknown,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => work(fakeClient),
  );
}

// ---------------------------------------------------------------------------
// Helper: build service with defaults
// ---------------------------------------------------------------------------

interface BuildServiceOpts {
  storesRepo?:      jest.Mocked<StoresRepository>;
  membershipsRepo?: jest.Mocked<MembershipRepository>;
  tx?:              ReturnType<typeof makeFakeTx>;
}

function buildService(opts: BuildServiceOpts = {}) {
  const storesRepo      = opts.storesRepo      ?? makeFakeStoresRepo();
  const membershipsRepo = opts.membershipsRepo ?? makeFakeMembershipsRepo();
  const tx              = opts.tx              ?? makeFakeTx();

  const service = new StoresService(
    fakePool,
    storesRepo as unknown as StoresRepository,
    membershipsRepo as unknown as MembershipRepository,
    mockPricingLifecycle,
    tx as unknown as NonNullable<ConstructorParameters<typeof StoresService>[4]>,
  );

  return { service, storesRepo, membershipsRepo, tx };
}

// ---------------------------------------------------------------------------
// Reset shared state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockNewId.mockReturnValue(STORE_ID);
});

// ===========================================================================
// CTOR. constructor fallback — `tx ?? runWithTenantContext`
// ===========================================================================

describe("StoresService constructor", () => {
  it("CTOR1: omitting tx falls back to runWithTenantContext (constructor branch only)", () => {
    // Construct WITHOUT a tx — exercises the right-hand branch of
    // `tx ?? runWithTenantContext`. We do NOT invoke any service method
    // here; calling one would require a real Postgres pool. This test
    // pins the construction path so the nullish-coalesce branch is
    // exercised at least once.
    const storesRepo      = makeFakeStoresRepo();
    const membershipsRepo = makeFakeMembershipsRepo();

    const service = new StoresService(
      fakePool,
      storesRepo as unknown as StoresRepository,
      membershipsRepo as unknown as MembershipRepository,
      mockPricingLifecycle,
    );

    expect(service).toBeInstanceOf(StoresService);
  });
});

// ===========================================================================
// L. list()
// ===========================================================================

describe("StoresService.list", () => {
  it("L1: calls tx with pool + tenantCtx and proxies to stores.listInTenant", async () => {
    const { service, storesRepo, tx } = buildService();
    const rows = [makeStoreRecord(), makeStoreRecord({ id: "other-id" })];
    storesRepo.listInTenant.mockResolvedValue(rows);
    const ctx = makeCtx();

    const result = await service.list(ctx);

    expect(result).toBe(rows);
    expect(storesRepo.listInTenant).toHaveBeenCalledTimes(1);
    expect(storesRepo.listInTenant).toHaveBeenCalledWith(fakeClient);
    expect(tx).toHaveBeenCalledTimes(1);
    // tx invoked with pool, tenantCtx, work fn
    const txCall = tx.mock.calls[0]!;
    expect(txCall[0]).toBe(fakePool);
    expect(txCall[1]).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
    expect(typeof txCall[2]).toBe("function");
  });
});

// ===========================================================================
// CR. create()
// ===========================================================================

describe("StoresService.create", () => {
  it("CR1: ctx.tenantId === null → NotFoundException (defensive guard before tx)", async () => {
    const { service, storesRepo, tx } = buildService();
    const ctx = makeCtx({ tenantId: null });

    await expect(
      service.create(ctx, { code: "MAIN", name: "Main" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx).not.toHaveBeenCalled();
    expect(storesRepo.create).not.toHaveBeenCalled();
  });

  it("CR2: happy path — stores.create called with minted id + tenantCtx forwarded", async () => {
    const { service, storesRepo, tx } = buildService();
    const row = makeStoreRecord();
    storesRepo.create.mockResolvedValue(row);
    const ctx = makeCtx();

    mockPricingCalls.length = 0;
    storesRepo.create.mockImplementation(async () => {
      mockPricingCalls.push("create");
      return row;
    });
    const result = await service.create(ctx, { code: "MAIN", name: "Main Store" });

    expect(result).toBe(row);
    // RT-1484 PR-5: the pricing publish lock first, then the insert, then the bootstrap row
    // (whose correlation id is the second minted id).
    expect(mockPricingCalls).toEqual(["lock", "create", "bootstrap"]);
    expect(mockNewId).toHaveBeenCalledTimes(2);
    expect(storesRepo.create).toHaveBeenCalledTimes(1);
    expect(storesRepo.create).toHaveBeenCalledWith(fakeClient, {
      id: STORE_ID,
      tenantId: TENANT_ID,
      code: "MAIN",
      name: "Main Store",
    });
    // tx invoked with the resolved tenant context
    expect(tx.mock.calls[0]![1]).toEqual({
      tenantId: TENANT_ID,
      isPlatformAdmin: false,
    });
  });

  it("CR3: stores.create throws direct {code:'23505',constraint:'stores_tenant_code_uidx'} → ConflictException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      code: "23505",
      constraint: "stores_tenant_code_uidx",
      message: "duplicate key",
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR4: stores.create throws drizzle-wrapped {cause:{code:'23505',constraint:'stores_tenant_code_uidx'}} → ConflictException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      message: "DrizzleQueryError",
      cause: {
        code: "23505",
        constraint: "stores_tenant_code_uidx",
      },
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR5: stores.create throws {code:'23505',constraint:'other_constraint'} → rethrown as-is", async () => {
    const { service, storesRepo } = buildService();
    const originalError = {
      code: "23505",
      constraint: "other_unique_constraint",
      message: "duplicate on something else",
    };
    storesRepo.create.mockRejectedValue(originalError);
    const ctx = makeCtx();

    const err = await service
      .create(ctx, { code: "X", name: "X" })
      .catch((e: unknown) => e);

    expect(err).toBe(originalError);
    expect(err).not.toBeInstanceOf(ConflictException);
  });

  it("CR6: stores.create throws {code:'23505',message:'...stores_tenant_code_uidx...'} → ConflictException (message-substring path)", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue({
      code: "23505",
      message:
        "duplicate key value violates unique constraint \"stores_tenant_code_uidx\"",
    });
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "DUP", name: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("CR7: stores.create throws non-23505 random Error → rethrown verbatim", async () => {
    const { service, storesRepo } = buildService();
    const randomError = new Error("connection reset");
    storesRepo.create.mockRejectedValue(randomError);
    const ctx = makeCtx();

    await expect(
      service.create(ctx, { code: "MAIN", name: "Main" }),
    ).rejects.toBe(randomError);
  });

  it("CR8: stores.create throws null → rethrown (covers null branch in isUniqueViolation)", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.create.mockRejectedValue(null);
    const ctx = makeCtx();

    const err = await service
      .create(ctx, { code: "MAIN", name: "Main" })
      .catch((e: unknown) => e);

    expect(err).toBeNull();
  });
});

// ===========================================================================
// RE. read()
// ===========================================================================

describe("StoresService.read", () => {
  it("RE1: ctx.tenantId === null → NotFoundException (before tx)", async () => {
    const { service, storesRepo, membershipsRepo, tx } = buildService();
    const ctx = makeCtx({ tenantId: null });

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(tx).not.toHaveBeenCalled();
    expect(storesRepo.findById).not.toHaveBeenCalled();
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
  });

  it("RE2: session caller, findActiveMembership returns null → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(membershipsRepo.findActiveMembership).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID,
      fakeClient,
    );
    expect(membershipsRepo.canAccessStore).not.toHaveBeenCalled();
    expect(storesRepo.findById).not.toHaveBeenCalled();
  });

  it("RE3: session caller, canAccessStore returns false → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(
      makeActiveMembership({ storeAccessKind: "specific" }),
    );
    membershipsRepo.canAccessStore.mockResolvedValue(false);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(membershipsRepo.canAccessStore).toHaveBeenCalledWith(
      MEMBERSHIP_ID,
      TENANT_ID,
      STORE_ID,
      "specific",
      fakeClient,
    );
    expect(storesRepo.findById).not.toHaveBeenCalled();
  });

  it("RE4: session caller, canAccessStore true, stores.findById returns null → NotFoundException", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    membershipsRepo.findActiveMembership.mockResolvedValue(makeActiveMembership());
    membershipsRepo.canAccessStore.mockResolvedValue(true);
    storesRepo.findById.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(service.read(ctx, STORE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE5: session caller, all checks pass → returns store record", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    membershipsRepo.findActiveMembership.mockResolvedValue(makeActiveMembership());
    membershipsRepo.canAccessStore.mockResolvedValue(true);
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx();

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).toHaveBeenCalledTimes(1);
    expect(membershipsRepo.canAccessStore).toHaveBeenCalledTimes(1);
  });

  it("RE6: platform admin session — skips stage 1, findById called directly", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ isPlatformAdmin: true });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(membershipsRepo.canAccessStore).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE7: token caller (source='token') — skips stage 1, findById called directly", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ source: "token" });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });

  it("RE8: session caller with userId=null — skips stage 1 (ctx.userId falsy), goes to stage 2", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    const row = makeStoreRecord();
    storesRepo.findById.mockResolvedValue(row);
    const ctx = makeCtx({ userId: null });

    const result = await service.read(ctx, STORE_ID);

    expect(result).toBe(row);
    expect(membershipsRepo.findActiveMembership).not.toHaveBeenCalled();
    expect(storesRepo.findById).toHaveBeenCalledWith(fakeClient, STORE_ID);
  });
});

// ===========================================================================
// UP. update()
// ===========================================================================

describe("StoresService.update", () => {
  it("UP1: stores.update returns null → NotFoundException", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.update.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(
      service.update(ctx, STORE_ID, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(storesRepo.update).toHaveBeenCalledWith(fakeClient, STORE_ID, {
      name: "Renamed",
      isActive: undefined,
    });
  });

  it("UP2: happy path — returns updated record; is_active mapped to isActive", async () => {
    const { service, storesRepo } = buildService();
    const row = makeStoreRecord({ name: "Renamed", isActive: false });
    storesRepo.update.mockResolvedValue(row);
    const ctx = makeCtx();

    const result = await service.update(ctx, STORE_ID, {
      name: "Renamed",
      is_active: false,
    });

    expect(result).toBe(row);
    expect(storesRepo.update).toHaveBeenCalledWith(fakeClient, STORE_ID, {
      name: "Renamed",
      isActive: false,
    });
  });

  // RT-1484 PR-5 (spec 042 §8, data-model §2.6): lifecycle writes take the pricing publish lock first.
  it("UP3: a deactivation takes the pricing lock and writes no bootstrap row; an activation writes one", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.update.mockImplementation(async () => {
      mockPricingCalls.push("update");
      return makeStoreRecord();
    });
    mockPricingCalls.length = 0;
    await service.update(makeCtx(), STORE_ID, { is_active: false });
    expect(mockPricingCalls).toEqual(["lock", "update"]);
    expect(storesRepo.findById).not.toHaveBeenCalled();
    mockPricingCalls.length = 0;
    storesRepo.findById.mockResolvedValue(makeStoreRecord({ isActive: false }));
    await service.update(makeCtx(), STORE_ID, { is_active: true });
    expect(mockPricingCalls).toEqual(["lock", "update", "bootstrap"]);
  });

  // Review round 1 (m5): an `is_active: true` PATCH on an active Store is no activation.
  it("UP3b: is_active true on an already active Store locks but writes no bootstrap row", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.findById.mockResolvedValue(makeStoreRecord({ isActive: true }));
    storesRepo.update.mockImplementation(async () => {
      mockPricingCalls.push("update");
      return makeStoreRecord();
    });
    mockPricingCalls.length = 0;
    await service.update(makeCtx(), STORE_ID, { is_active: true });
    expect(mockPricingCalls).toEqual(["lock", "update"]);
  });

  it("UP4: a rename alone is no lifecycle write: no pricing lock", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.update.mockResolvedValue(makeStoreRecord());
    mockPricingCalls.length = 0;
    await service.update(makeCtx(), STORE_ID, { name: "Renamed" });
    expect(mockPricingCalls).toEqual([]);
  });
});

// ===========================================================================
// SD. softDelete()
// ===========================================================================

describe("StoresService.softDelete", () => {
  const facts = (over: Partial<StoreDeletionFacts> = {}): StoreDeletionFacts => {
    const base = {
      store: { storeId: STORE_ID, code: "BR-01", name: "Branch 01", isActive: true },
      openShifts: [],
      devices: [],
      openCountSessions: [],
      warehouseMappings: [],
      singleStoreMembers: [],
      offersRebuiltCount: 0,
      ...over,
    };
    return {
      ...base,
      counts: { openShifts: base.openShifts.length, totalDevices: 0, unretiredDevices: 0, unsyncedDevices: 0, openCountSessions: base.openCountSessions.length },
    };
  };
  const liveStore = { id: STORE_ID, tenantId: "0e170000-0000-4000-8000-0000000a0001", code: "BR-01", name: "Branch 01", isActive: true } as StoreRecord;

  it("SD1: the store row cannot be locked (invisible or already deleted) → NotFoundException; nothing is deleted", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.findByIdForUpdate.mockResolvedValue(null);
    const ctx = makeCtx();

    await expect(service.softDelete(ctx, STORE_ID)).rejects.toBeInstanceOf(NotFoundException);

    expect(storesRepo.findByIdForUpdate).toHaveBeenCalledWith(fakeClient, STORE_ID);
    expect(deleteStoreWithAudit).not.toHaveBeenCalled();
  });

  it("SD2: happy path — locks the store, evaluates the guards, then deletes with an api audit; resolves void", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    storesRepo.findByIdForUpdate.mockResolvedValue(liveStore);
    mockFacts.mockResolvedValue(facts());
    membershipsRepo.findRoleCodeForUserInTenant.mockResolvedValue("tenant_admin");
    const ctx = makeCtx();

    const result = await service.softDelete(ctx, STORE_ID, { requestId: "req-1" });

    expect(result).toBeUndefined();
    expect(deleteStoreWithAudit).toHaveBeenCalledWith(
      fakeClient,
      storesRepo,
      ctx.tenantId,
      expect.objectContaining({ store: expect.objectContaining({ storeId: STORE_ID }) }),
      { channel: "api", actorUserId: ctx.userId, actorRole: "tenant_admin", requestId: "req-1", reason: null, previewFingerprint: null },
    );
    expect(storesRepo.findByIdForUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFacts.mock.invocationCallOrder[0]!,
    );
    expect(mockFacts.mock.invocationCallOrder[0]!).toBeLessThan(
      (deleteStoreWithAudit as jest.Mock).mock.invocationCallOrder[0]!,
    );
    // RT-1453: the facts are read for the store's own tenant (the pos-shifts port scopes by it).
    // The delete path refuses on counts and fingerprints ids only, so it reads no per-shift eligibility.
    expect(mockFacts).toHaveBeenCalledWith(fakeClient, expect.anything(), liveStore.tenantId, { withEligibility: false });
  });

  it("SD3: a guard holds → 409 with the first blocker as the code and every blocker in details; nothing is deleted", async () => {
    const { service, storesRepo } = buildService();
    storesRepo.findByIdForUpdate.mockResolvedValue(liveStore);
    mockFacts.mockResolvedValue(
      facts({ openShifts: [{ shiftId: "s1", openedAt: new Date(), terminalLabel: null, forceCloseEligible: true }] }),
    );

    const err = await service.softDelete(makeCtx(), STORE_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "store_has_open_shift",
      details: { blockers: [{ code: "store_has_open_shift", count: 1 }] },
    });
    expect(deleteStoreWithAudit).not.toHaveBeenCalled();
  });

  it("SD4: a platform admin without a membership is audited as platform_admin", async () => {
    const { service, storesRepo, membershipsRepo } = buildService();
    storesRepo.findByIdForUpdate.mockResolvedValue(liveStore);
    mockFacts.mockResolvedValue(facts());
    membershipsRepo.findRoleCodeForUserInTenant.mockResolvedValue(null);

    await service.softDelete({ ...makeCtx(), isPlatformAdmin: true }, STORE_ID);

    expect(deleteStoreWithAudit).toHaveBeenCalledWith(
      fakeClient,
      storesRepo,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ actorRole: "platform_admin" }),
    );
  });
});
