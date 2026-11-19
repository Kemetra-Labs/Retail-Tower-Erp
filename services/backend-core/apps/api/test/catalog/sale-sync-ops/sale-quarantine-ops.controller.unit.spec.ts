/**
 * RT-1312 Phase 3(b), slice B: the wiring and error mapping of the Console
 * quarantine routes (`SaleQuarantineOpsController`), without a database. The
 * HTTP behaviour over real Postgres is `sale-quarantine-ops.integration.spec.ts`.
 *
 * Pins what an HTTP spec cannot see cheaply: the guard order, the role gate
 * (decision C1: `owner` and `tenant_admin` only), the audit action of each
 * route, the console rate-limit class (RT-574 D3), `Idempotency-Key` on the
 * write-off, and which service error becomes which status.
 */
import "reflect-metadata";

import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";

import { AUDITABLE_KEY } from "../../../src/audit/auditable.decorator";
import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { ROLES_METADATA_KEY } from "../../../src/auth/roles.decorator";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { CONSOLE_RATE_LIMIT_CLASS_KEY } from "../../../src/console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import { IDEMPOTENT_POLICY_KEY } from "../../../src/idempotency/idempotent.decorator";
import { SaleQuarantineOpsController } from "../../../src/catalog/sale-sync-ops/sale-quarantine-ops.controller";
import { QuarantineNotFoundError } from "../../../src/catalog/sale-sync-ops/sale-quarantine-ops.service";
import {
  RepairConflictError,
  StoreNotInScopeError,
} from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const STORE = "0a000000-0000-7000-8000-0000000000b1";
const REF = "0190f0f0-0000-7000-8000-00000000c001";
const request = (over: Record<string, unknown> = {}): never =>
  ({ context: { tenantId: TENANT, storeId: null, userId: "u1" }, ...over }) as never;

const handler = (name: "list" | "get" | "writeOff"): object =>
  Object.getOwnPropertyDescriptor(SaleQuarantineOpsController.prototype, name)?.value as object;

describe("SaleQuarantineOpsController wiring", () => {
  it("serves the three contract paths under the sale-sync-ops namespace", () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler("list"))).toBe("api/v1/catalog/sale-sync-ops/quarantined-sales");
    expect(Reflect.getMetadata(PATH_METADATA, handler("get"))).toBe(
      "api/v1/catalog/sale-sync-ops/quarantined-sales/:quarantineRef",
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler("writeOff"))).toBe(
      "api/v1/catalog/sale-sync-ops/quarantined-sales/:quarantineRef/write-off",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler("list"))).toBe(0); // GET
    expect(Reflect.getMetadata(METHOD_METADATA, handler("get"))).toBe(0); // GET
    expect(Reflect.getMetadata(METHOD_METADATA, handler("writeOff"))).toBe(1); // POST
  });

  it("authenticates the human session, then the tenant context, for every route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SaleQuarantineOpsController)).toEqual([
      DashboardAuthGuard,
      TenantContextGuard,
    ]);
  });

  it.each(["list", "get", "writeOff"] as const)("%s is gated to owner and tenant_admin (C1)", (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RolesGuard]);
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler(name))).toMatchObject({
      any: ["owner", "tenant_admin"],
      platformAdminOnly: false,
    });
  });

  it("audits each route under its contract action", () => {
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler("list"))).toBe("sale_sync_ops.quarantine.listed");
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler("get"))).toBe("sale_sync_ops.quarantine.read");
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler("writeOff"))).toBe("sale_sync_ops.quarantine.written_off");
  });

  it("uses the rate-limit classes the contract's class file declares", () => {
    expect(Reflect.getMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, handler("list"))).toBe("expensiveRead");
    expect(Reflect.getMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, handler("get"))).toBe("cheapRead");
    expect(Reflect.getMetadata(CONSOLE_RATE_LIMIT_CLASS_KEY, handler("writeOff"))).toBe("write");
  });

  it("answers the write-off 200 as the contract documents (a bare POST would be 201)", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler("writeOff"))).toBe(200);
  });

  it("requires an Idempotency-Key on the write-off only", () => {
    expect(Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler("writeOff"))).toBe("required");
    expect(Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler("list"))).toBeUndefined();
    expect(Reflect.getMetadata(IDEMPOTENT_POLICY_KEY, handler("get"))).toBeUndefined();
  });
});

describe("SaleQuarantineOpsController behaviour", () => {
  const ops = { list: jest.fn(), get: jest.fn(), writeOff: jest.fn() };
  const readModel = { assertStoreInScope: jest.fn() };
  const controller = (): SaleQuarantineOpsController => new SaleQuarantineOpsController(ops as never, readModel as never);

  beforeEach(() => {
    jest.resetAllMocks();
    readModel.assertStoreInScope.mockResolvedValue(undefined);
  });

  it("every route is 401 without a resolved tenant, before any service call", async () => {
    const noTenant = { context: { tenantId: null } } as never;
    await expect(controller().list(noTenant, {})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller().get(noTenant, REF)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller().writeOff(noTenant, REF, { note: "n" })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ops.list).not.toHaveBeenCalled();
  });

  it("list passes the default page size, no cursor and no store; state is left to the service", async () => {
    ops.list.mockResolvedValue({ items: [], nextCursor: null });
    await expect(controller().list(request(), {})).resolves.toEqual({ items: [], nextCursor: null });
    expect(ops.list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, cursor: null, limit: 50 }));
    expect(ops.list.mock.calls[0]![0]).not.toHaveProperty("storeId");
    expect(readModel.assertStoreInScope).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it("list checks the store filter against the caller's scope, and an out-of-scope store is the same 404", async () => {
    readModel.assertStoreInScope.mockRejectedValue(new StoreNotInScopeError());
    await expect(controller().list(request(), { store_id: STORE })).rejects.toBeInstanceOf(NotFoundException);
    expect(readModel.assertStoreInScope).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE }));
    expect(ops.list).not.toHaveBeenCalled();
  });

  it("list passes the state, store, cursor and page size through", async () => {
    ops.list.mockResolvedValue({ items: [], nextCursor: null });
    await controller().list(request(), { store_id: STORE, state: "captured", cursor: REF, page_size: 7 });
    expect(ops.list).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, state: "captured", cursor: REF, limit: 7 }),
    );
  });

  it("get and write-off answer a malformed ref with a 400 before any service call", async () => {
    await expect(controller().get(request(), "nope")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller().writeOff(request(), "nope", { note: "n" })).rejects.toBeInstanceOf(BadRequestException);
    expect(ops.get).not.toHaveBeenCalled();
    expect(ops.writeOff).not.toHaveBeenCalled();
  });

  it("get returns the item, and an unresolved ref is the non-disclosing 404", async () => {
    ops.get.mockResolvedValueOnce({ quarantineRef: REF });
    await expect(controller().get(request(), REF)).resolves.toEqual({ quarantineRef: REF });
    ops.get.mockRejectedValueOnce(new QuarantineNotFoundError());
    await expect(controller().get(request(), REF)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("write-off passes the note, and maps not-found to 404 and not-open to 409 repair_conflict", async () => {
    ops.writeOff.mockResolvedValueOnce({ quarantineRef: REF, state: "written-off" });
    await expect(controller().writeOff(request(), REF, { note: "refunded in cash" })).resolves.toEqual({
      quarantineRef: REF,
      state: "written-off",
    });
    expect(ops.writeOff).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), REF, "refunded in cash");

    ops.writeOff.mockRejectedValueOnce(new QuarantineNotFoundError());
    await expect(controller().writeOff(request(), REF, { note: "n" })).rejects.toBeInstanceOf(NotFoundException);

    ops.writeOff.mockRejectedValueOnce(new RepairConflictError());
    const conflict = await controller()
      .writeOff(request(), REF, { note: "n" })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toEqual({
      code: "repair_conflict",
      message: "The quarantined sale is not open.",
    });
  });

  it("an unexpected service error is rethrown untouched (the global filter answers 500)", async () => {
    const boom = new Error("db down");
    ops.writeOff.mockRejectedValueOnce(boom);
    await expect(controller().writeOff(request(), REF, { note: "n" })).rejects.toBe(boom);
  });

  it("annotates the audit row with ids only, never the note", async () => {
    ops.writeOff.mockResolvedValueOnce({ quarantineRef: REF, storeId: STORE, state: "written-off" });
    const req = request();
    await controller().writeOff(req, REF, { note: "customer name and phone" });
    const metadata = (req as { auditMetadata?: Record<string, unknown> }).auditMetadata;
    expect(metadata).toEqual({ quarantine_ref: REF, store_id: STORE, state: "written-off" });
    expect(JSON.stringify(metadata)).not.toContain("customer");
  });
});
