/**
 * RT-1312 F7 — the RT-132 inventory role rule (owner ratification, RT-132 comment 10674):
 * inventory MUTATIONS need owner, tenant_admin or store_manager plus the resolved store scope;
 * store_staff gets no dashboard inventory mutation authority. The store scope is enforced inside
 * each handler (`authorizeStore`); this pins the role gate in front of it.
 *
 * A refusal is the non-disclosing 404 (`denyAs: 404`, the RolesGuard default) that the three
 * operations already declare (`NotFoundOrCrossTenant`), so the contract does not change. Reads
 * stay ungated by role (any store member may view stock).
 */
import "reflect-metadata";

import { RolesGuard } from "../../../src/auth/roles.guard";
import { ROLES_METADATA_KEY } from "../../../src/auth/roles.decorator";
import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import { InventoryController } from "../../../src/inventory/inventory.controller";

const guardsOf = (target: object): unknown[] => (Reflect.getMetadata("__guards__", target) ?? []) as unknown[];

const WRITES = ["createStockMovement", "createStockTransfer", "recordStockCount"] as const;
const READS = ["getOnHand", "listStockMovements", "listStockLocations"] as const;

describe("RT-1312 F7 inventory write roles", () => {
  it("keeps the class guards: a human session, then the tenant context", () => {
    expect(guardsOf(InventoryController)).toEqual([DashboardAuthGuard, TenantContextGuard]);
  });

  it.each(WRITES)("%s requires owner, tenant_admin or store_manager, denied as 404", (route) => {
    const handler = InventoryController.prototype[route];
    expect(guardsOf(handler)).toEqual([RolesGuard]);
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler)).toMatchObject({
      any: ["owner", "tenant_admin", "store_manager"],
      platformAdminOnly: false,
      denyAs: 404,
    });
  });

  it.each(READS)("%s stays readable by any store member (no role gate)", (route) => {
    const handler = InventoryController.prototype[route];
    expect(guardsOf(handler)).toEqual([]);
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, handler)).toBeUndefined();
  });
});
