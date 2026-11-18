/**
 * RT-1462 — a platform admin who is not a member may use the Console force actions WITHOUT a support session
 * (owner decision 2026-11-18). Docker-free units for the three pieces that make that so, and only that:
 *
 *   - `SupportSessionGate.admitDirect`: one `platform.cross_tenant.accessed` row per request, naming the live
 *     support session when there is one; a missing tenant is `support_session_required`; a suspended tenant
 *     stays read-only for an unsafe method (`support_session_read_only`);
 *   - `recordDirectOriginRefusal`: the row says `origin_rejected`;
 *   - `PLATFORM_DIRECT_HANDLERS`: exactly the six handlers, each naming a real handler of a real controller,
 *     so a rename cannot silently turn the exemption off (or leave a stale key behind).
 */
jest.mock("../../src/platform-support-sessions/support-session.lifecycle", () => ({
  withSupportSessionCtx: jest.fn(async (_pool: unknown, work: (client: unknown) => unknown) => work(fakeClient)),
}));
jest.mock("../../src/platform-support-sessions/support-session.store", () => ({
  ...jest.requireActual("../../src/platform-support-sessions/support-session.store"),
  findLiveSupportSession: jest.fn(),
  recordCrossTenantAccess: jest.fn(async () => undefined),
}));

import "reflect-metadata";

import type { ExecutionContext } from "@nestjs/common";
import type { Pool } from "pg";

import { ConsoleForceActionsController } from "../../src/console-force-actions/console-force-actions.controller";
import {
  isPlatformDirect,
  PLATFORM_DIRECT_HANDLERS,
} from "../../src/platform-support-sessions/support-session.coverage";
import { SupportSessionGate, type GateRequest } from "../../src/platform-support-sessions/support-session.gate";
import {
  findLiveSupportSession,
  recordCrossTenantAccess,
  type SupportSessionRecord,
} from "../../src/platform-support-sessions/support-session.store";
import { StoreDeletionController } from "../../src/stores/deletion/store-deletion.controller";
import { StoresController } from "../../src/stores/stores.controller";

const TENANT = "04140000-0000-4000-8000-0000000000a1";
const OTHER = "04140000-0000-4000-8000-0000000000b1";

let tenantRows: Array<{ status: string }> = [];
const fakeClient = { query: jest.fn(async () => ({ rows: tenantRows })) };

function live(overrides: Partial<SupportSessionRecord> = {}): SupportSessionRecord {
  return {
    id: "04140000-0000-4000-8000-00000000f001",
    authSessionId: "04140000-0000-4000-8000-00000000f002",
    userId: "04140000-0000-4000-8000-00000000f003",
    tenantId: TENANT,
    purpose: "incident",
    ticketRef: null,
    openedAt: new Date("2026-10-21T08:00:00Z"),
    renewedAt: null,
    expiresAt: new Date("2026-10-21T09:00:00Z"),
    renewalCapAt: new Date("2026-10-21T16:00:00Z"),
    endedAt: null,
    endReason: null,
    status: "active",
    ...overrides,
  };
}

const request = (method = "POST"): GateRequest => ({
  authSessionId: "04140000-0000-4000-8000-00000000f002",
  userId: "04140000-0000-4000-8000-00000000f003",
  method,
  route: "/api/v1/shifts/:shift_id/force-close",
  requestId: "rid-1",
});

const gate = (): SupportSessionGate => new SupportSessionGate({} as Pool);
const recorded = (): Array<Record<string, unknown>> =>
  (recordCrossTenantAccess as jest.Mock).mock.calls.map((c) => c[1] as Record<string, unknown>);

describe("SupportSessionGate.admitDirect (RT-1462)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tenantRows = [{ status: "active" }];
    (findLiveSupportSession as jest.Mock).mockResolvedValue(null);
  });

  it("an active tenant with no support session is admitted, and one row records it with no session", async () => {
    await expect(gate().admitDirect(TENANT, request())).resolves.toBeNull();
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ tenantId: TENANT, method: "POST", session: null });
    expect(recorded()[0]).not.toHaveProperty("reason");
  });

  it("the caller's live support session for this tenant is returned and recorded", async () => {
    (findLiveSupportSession as jest.Mock).mockResolvedValue(live());
    await expect(gate().admitDirect(TENANT, request())).resolves.toMatchObject({ id: live().id });
    expect(recorded()[0]).toMatchObject({ session: { id: live().id } });
  });

  it.each([
    ["another tenant's session", live({ tenantId: OTHER })],
    ["an expired session", live({ status: "expired" })],
  ])("%s is not this request's session: admitted without one", async (_name, session) => {
    (findLiveSupportSession as jest.Mock).mockResolvedValue(session);
    await expect(gate().admitDirect(TENANT, request())).resolves.toBeNull();
    expect(recorded()[0]).toMatchObject({ session: null });
  });

  it("a tenant that does not exist is support_session_required, audited, like any unresolvable tenant", async () => {
    tenantRows = [];
    await expect(gate().admitDirect(TENANT, request())).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
    expect(recorded()[0]).toMatchObject({ reason: "support_session_required" });
  });

  it("a suspended tenant stays read-only: an unsafe method is support_session_read_only, a read is admitted", async () => {
    tenantRows = [{ status: "suspended" }];
    await expect(gate().admitDirect(TENANT, request("POST"))).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_read_only" },
    });
    expect(recorded()[0]).toMatchObject({ reason: "support_session_read_only" });
    await expect(gate().admitDirect(TENANT, request("GET"))).resolves.toBeNull();
  });

  it("the origin refusal of a direct route is origin_rejected, naming the live session when there is one", async () => {
    const refusal = await gate().recordDirectOriginRefusal(TENANT, request());
    expect(refusal.getResponse()).toMatchObject({ code: "origin_rejected" });
    expect(recorded()[0]).toMatchObject({ reason: "origin_rejected", session: null });
    (findLiveSupportSession as jest.Mock).mockResolvedValue(live());
    await gate().recordDirectOriginRefusal(TENANT, request());
    expect(recorded()[1]).toMatchObject({ reason: "origin_rejected", session: { id: live().id } });
  });

  it("the origin refusal follows the contract order: a suspended tenant or a missing one decides first", async () => {
    tenantRows = [{ status: "suspended" }];
    await expect(gate().recordDirectOriginRefusal(TENANT, request("POST"))).resolves.toMatchObject({
      response: { code: "support_session_read_only" },
    });
    tenantRows = [];
    await expect(gate().recordDirectOriginRefusal(TENANT, request("POST"))).resolves.toMatchObject({
      response: { code: "support_session_required" },
    });
    expect(recorded().map((r) => r["reason"])).toEqual(["support_session_read_only", "support_session_required"]);
  });
});

describe("PLATFORM_DIRECT_HANDLERS (RT-1462)", () => {
  const controllers: Record<string, { prototype: object }> = {
    ConsoleForceActionsController,
    StoreDeletionController,
  };

  it("is exactly the six force-action handlers", () => {
    expect([...PLATFORM_DIRECT_HANDLERS].sort()).toEqual([
      "ConsoleForceActionsController.forceCloseShift",
      "ConsoleForceActionsController.getForceClosePreview",
      "ConsoleForceActionsController.listOpenShifts",
      "StoreDeletionController.delete",
      "StoreDeletionController.preview",
      "StoreDeletionController.reauthenticate",
    ]);
  });

  it.each([...PLATFORM_DIRECT_HANDLERS])("%s names a real handler, and isPlatformDirect sees it", (key) => {
    const [controller, handler] = key.split(".") as [string, string];
    const target = controllers[controller];
    expect(target).toBeDefined();
    const fn = (target!.prototype as Record<string, unknown>)[handler];
    expect(typeof fn).toBe("function");
    const execCtx = { getClass: () => target, getHandler: () => fn } as unknown as ExecutionContext;
    expect(isPlatformDirect(execCtx)).toBe(true);
  });

  it("no other handler is direct: the store CRUD routes still need a support session", () => {
    for (const handler of ["create", "update", "list", "read", "softDelete"]) {
      const fn = (StoresController.prototype as unknown as Record<string, unknown>)[handler];
      // A renamed or removed handler must fail here, not silently skip its check.
      expect(typeof fn).toBe("function");
      const execCtx = { getClass: () => StoresController, getHandler: () => fn } as unknown as ExecutionContext;
      expect(isPlatformDirect(execCtx)).toBe(false);
    }
  });
});
