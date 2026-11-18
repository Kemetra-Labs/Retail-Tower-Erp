/**
 * RT-1468 — a platform admin is admitted to every covered route of any existing tenant, member or not,
 * with or without a support session, suspended tenant included (owner decision 2026-11-18, RT-1468
 * comment 17463). Docker-free units for `SupportSessionGate`:
 *
 *   - `admit`: one `platform.cross_tenant.accessed` row per request, naming the live support session for
 *     this tenant when there is one (an expired one, or another tenant's, is absent); the only refusal is
 *     a tenant that does not exist (`support_session_required`); a suspended tenant admits every method;
 *   - `recordOriginRefusal`: `origin_rejected` for an existing tenant, `support_session_required` for a
 *     missing one, never `support_session_read_only` or `support_session_expired`.
 */
jest.mock("../../src/platform-support-sessions/support-session.lifecycle", () => ({
  withSupportSessionCtx: jest.fn(async (_pool: unknown, work: (client: unknown) => unknown) => work(fakeClient)),
}));
jest.mock("../../src/platform-support-sessions/support-session.store", () => ({
  ...jest.requireActual("../../src/platform-support-sessions/support-session.store"),
  findLiveSupportSession: jest.fn(),
  recordCrossTenantAccess: jest.fn(async () => undefined),
}));

import type { Pool } from "pg";

import { SupportSessionGate, type GateRequest } from "../../src/platform-support-sessions/support-session.gate";
import {
  findLiveSupportSession,
  recordCrossTenantAccess,
  type SupportSessionRecord,
} from "../../src/platform-support-sessions/support-session.store";

const TENANT = "04140000-0000-4000-8000-0000000000a1";
const OTHER = "04140000-0000-4000-8000-0000000000b1";

/** The rows `SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL` returns: one for an existing tenant. */
let tenantRows: Array<Record<string, unknown>> = [];
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
  route: "/api/v1/stores",
  requestId: "rid-1",
});

const gate = (): SupportSessionGate => new SupportSessionGate({} as Pool);
const recorded = (): Array<Record<string, unknown>> =>
  (recordCrossTenantAccess as jest.Mock).mock.calls.map((c) => c[1] as Record<string, unknown>);

describe("SupportSessionGate.admit (RT-1468)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tenantRows = [{ "?column?": 1 }];
    (findLiveSupportSession as jest.Mock).mockResolvedValue(null);
  });

  it.each(["GET", "POST", "PATCH", "DELETE"])(
    "an existing tenant with no support session admits %s, and one row records it with no session",
    async (method) => {
      await expect(gate().admit(TENANT, request(method))).resolves.toBeNull();
      expect(recorded()).toHaveLength(1);
      expect(recorded()[0]).toMatchObject({ tenantId: TENANT, method, session: null });
      expect(recorded()[0]).not.toHaveProperty("reason");
    },
  );

  it("the caller's live support session for this tenant is returned and recorded", async () => {
    (findLiveSupportSession as jest.Mock).mockResolvedValue(live());
    await expect(gate().admit(TENANT, request())).resolves.toMatchObject({ id: live().id });
    expect(recorded()[0]).toMatchObject({ session: { id: live().id } });
  });

  it.each([
    ["another tenant's session", live({ tenantId: OTHER })],
    ["an expired session", live({ status: "expired" })],
  ])("%s is not this request's session: admitted without one, never refused", async (_name, session) => {
    (findLiveSupportSession as jest.Mock).mockResolvedValue(session);
    await expect(gate().admit(TENANT, request())).resolves.toBeNull();
    expect(recorded()[0]).toMatchObject({ session: null });
    expect(recorded()[0]).not.toHaveProperty("reason");
  });

  it("a tenant that does not exist is support_session_required, recorded before the refusal", async () => {
    tenantRows = [];
    await expect(gate().admit(TENANT, request())).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ reason: "support_session_required" });
  });

  it("a path segment that is not a UUID is support_session_required without a tenant lookup", async () => {
    await expect(gate().admit("not-a-uuid", request())).rejects.toMatchObject({
      response: { code: "support_session_required" },
    });
    expect(fakeClient.query).not.toHaveBeenCalled();
  });

  it("the tenant check reads existence only: its status is not a refusal (a suspended tenant is admitted)", async () => {
    await gate().admit(TENANT, request("POST"));
    const sql = String((fakeClient.query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).not.toMatch(/status/);
  });
});

describe("SupportSessionGate.recordOriginRefusal (RT-1468)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tenantRows = [{ "?column?": 1 }];
    (findLiveSupportSession as jest.Mock).mockResolvedValue(null);
  });

  it("an existing tenant is origin_rejected, naming the live session when there is one", async () => {
    const refusal = await gate().recordOriginRefusal(TENANT, request());
    expect(refusal.getResponse()).toMatchObject({ code: "origin_rejected" });
    expect(recorded()[0]).toMatchObject({ reason: "origin_rejected", session: null });
    (findLiveSupportSession as jest.Mock).mockResolvedValue(live());
    await gate().recordOriginRefusal(TENANT, request());
    expect(recorded()[1]).toMatchObject({ reason: "origin_rejected", session: { id: live().id } });
  });

  it("a missing tenant is support_session_required", async () => {
    tenantRows = [];
    await expect(gate().recordOriginRefusal(TENANT, request("POST"))).resolves.toMatchObject({
      response: { code: "support_session_required" },
    });
    expect(recorded()[0]).toMatchObject({ reason: "support_session_required" });
  });
});
