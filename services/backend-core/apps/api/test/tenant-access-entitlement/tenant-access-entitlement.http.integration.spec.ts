/**
 * RT-1353 — the tenant access entitlement over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0105, the NOBYPASSRLS `app_test`
 * pool), the real module graph (`TenantContextGuard`, `RolesGuard`) and the
 * real service. Only cookie authentication is faked: a header names the
 * session (RT-192 / RT-387).
 *
 * tenant-access-entitlement.openapi.yaml, every operation:
 *   - the Console read: no row reads `unrestricted` (existing tenants), a
 *     restricted tenant reads `restricted`; owner / tenant_admin /
 *     store_manager read, a store_staff, another tenant and no session do not;
 *   - the unlock request (platform admin only): records who and when, audits
 *     once, does NOT lift the restriction, replays change nothing, a tenant
 *     with no restriction is `already_unrestricted` and gets no row;
 *   - mark provisioned (platform admin only): refused without an unlock
 *     request (409), lifts the restriction once, replays change nothing;
 *   - an owner or tenant_admin can neither unlock nor provision their own
 *     tenant (403), and a refused call changes nothing;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { TenantAccessEntitlementModule } from "../../src/tenant-access-entitlement/tenant-access-entitlement.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  accessAudits,
  accessRow,
  clearAccess,
  restrict,
  SES_MANAGER,
  SES_OWNER_B,
  SES_PLATFORM,
  SES_STAFF,
  seedAccessFixture,
  UNKNOWN_TENANT,
  USER_PLATFORM,
} from "./__support__/access-fixture";

const h = scopedHttpHarness({
  label: "RT-1353 tenant access entitlement",
  contractId: "tenant-access-entitlement.openapi",
  module: TenantAccessEntitlementModule,
  seed: seedAccessFixture,
});
const skip = (): boolean => h.skipped();

const readPath = (tenantId: string): string => `/api/v1/tenants/${tenantId}/access-entitlement`;
const unlockPath = (tenantId: string): string => `/api/v1/platform/tenants/${tenantId}/access-entitlement/unlock-request`;
const provisionPath = (tenantId: string): string =>
  `/api/v1/platform/tenants/${tenantId}/access-entitlement/mark-provisioned`;

const UNLOCK_REQUESTED = "tenant.access.unlock_requested";
const PROVISIONED = "tenant.access.provisioned";

const read = (session: string | null, tenantId = TENANT_A): request.Test => h.get(readPath(tenantId), session);
const unlock = (session: string | null, tenantId = TENANT_A): request.Test => h.post(unlockPath(tenantId), session, {});
const provision = (session: string | null, tenantId = TENANT_A): request.Test => h.post(provisionPath(tenantId), session, {});

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

/** audit_events is append-only (never deleted): each test counts only the rows it adds. */
const seen: Record<string, number> = {};

async function newAudits(action: string): Promise<Awaited<ReturnType<typeof accessAudits>>> {
  return (await accessAudits(h.env().admin, TENANT_A, action)).slice(seen[action] ?? 0);
}

beforeEach(async () => {
  if (h.skipped()) return;
  for (const action of [UNLOCK_REQUESTED, PROVISIONED]) {
    seen[action] = (await accessAudits(h.env().admin, TENANT_A, action)).length;
  }
});

afterEach(async () => {
  if (h.skipped()) return;
  await clearAccess(h.env().admin, TENANT_A);
  await clearAccess(h.env().admin, TENANT_B);
});

describe("consoleGetTenantAccessEntitlement", () => {
  it("reads unrestricted for a tenant with no stored state (every existing tenant)", async () => {
    if (skip()) return;
    const res = await read(SES_OWNER_ALL).expect(200);
    h.conforms("TenantAccessEntitlement", res.body);
    expect(res.body).toEqual({ tenant_id: TENANT_A, state: "unrestricted", unlock_requested_at: null, provisioned_at: null });
    expect(await accessRow(h.env().admin, TENANT_A)).toBeNull();
  });

  it("reads restricted for a restricted tenant, as owner, tenant_admin and store_manager", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER]) {
      const res = await read(session).expect(200);
      h.conforms("TenantAccessEntitlement", res.body);
      expect(res.body).toEqual({ tenant_id: TENANT_A, state: "restricted", unlock_requested_at: null, provisioned_at: null });
    }
  });

  it("is the same non-disclosing 404 for store_staff and for another tenant's path", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    expectError(await read(SES_STAFF), 404, "not_found");
    expectError(await read(SES_OWNER_B, TENANT_A), 404, "not_found");
    expectError(await read(SES_OWNER_ALL, TENANT_B), 404, "not_found");
  });

  it("is 401 without a session and 400 for a malformed tenant id", async () => {
    if (skip()) return;
    expectError(await read(null), 401, "unauthorized");
    expectError(await read(SES_OWNER_ALL, "not-a-uuid"), 400, "validation_error");
  });

  it("a platform admin reads its session's tenant", async () => {
    if (skip()) return;
    const res = await read(SES_PLATFORM, TENANT_B).expect(200);
    h.conforms("TenantAccessEntitlement", res.body);
    expect(res.body.state).toBe("unrestricted");
  });
});

describe("platformRequestTenantUnlock", () => {
  it("records the request, audits it once and does NOT lift the restriction", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    const res = await unlock(SES_PLATFORM).expect(200);
    h.conforms("TenantAccessChange", res.body);
    expect(res.body.outcome).toBe("requested");
    expect(res.body.entitlement).toMatchObject({ tenant_id: TENANT_A, state: "restricted", provisioned_at: null });
    expect(typeof res.body.entitlement.unlock_requested_at).toBe("string");

    const row = await accessRow(h.env().admin, TENANT_A);
    expect(row).toMatchObject({ state: "restricted", unlock_requested_by_user_id: USER_PLATFORM, provisioned_at: null });
    const audits = await newAudits(UNLOCK_REQUESTED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: USER_PLATFORM, target_id: TENANT_A });
    // The read (what the banner shows) still says restricted.
    expect((await read(SES_OWNER_ALL)).body.state).toBe("restricted");
  });

  it("a replay changes nothing: already_requested, the same time, one audit row", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    const first = await unlock(SES_PLATFORM).expect(200);
    const second = await unlock(SES_PLATFORM).expect(200);
    h.conforms("TenantAccessChange", second.body);
    expect(second.body.outcome).toBe("already_requested");
    expect(second.body.entitlement.unlock_requested_at).toBe(first.body.entitlement.unlock_requested_at);
    expect(await newAudits(UNLOCK_REQUESTED)).toHaveLength(1);
  });

  it("a tenant with no restriction is already_unrestricted: no row, no audit", async () => {
    if (skip()) return;
    const res = await unlock(SES_PLATFORM).expect(200);
    h.conforms("TenantAccessChange", res.body);
    expect(res.body.outcome).toBe("already_unrestricted");
    expect(res.body.entitlement).toEqual({ tenant_id: TENANT_A, state: "unrestricted", unlock_requested_at: null, provisioned_at: null });
    expect(await accessRow(h.env().admin, TENANT_A)).toBeNull();
    expect(await newAudits(UNLOCK_REQUESTED)).toHaveLength(0);
  });

  it("is platform-admin only: owner and tenant_admin get 403, and nothing changes", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER, SES_STAFF]) {
      expectError(await unlock(session), 403, "forbidden");
    }
    expectError(await unlock(null), 401, "unauthorized");
    expect(await accessRow(h.env().admin, TENANT_A)).toMatchObject({ state: "restricted", unlock_requested_at: null });
    expect(await newAudits(UNLOCK_REQUESTED)).toHaveLength(0);
  });

  it("is 404 for an unknown tenant and 400 for a malformed id", async () => {
    if (skip()) return;
    expectError(await unlock(SES_PLATFORM, UNKNOWN_TENANT), 404, "not_found");
    expectError(await unlock(SES_PLATFORM, "nope"), 400, "validation_error");
  });
});

describe("platformMarkTenantProvisioned", () => {
  it("is refused without an unlock request (409) and changes nothing", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    expectError(await provision(SES_PLATFORM), 409, "unlock_not_requested");
    expect(await accessRow(h.env().admin, TENANT_A)).toMatchObject({ state: "restricted", provisioned_at: null });
    expect(await newAudits(PROVISIONED)).toHaveLength(0);
  });

  it("is refused for a tenant that was never restricted (409), and creates no row", async () => {
    if (skip()) return;
    expectError(await provision(SES_PLATFORM), 409, "unlock_not_requested");
    expect(await accessRow(h.env().admin, TENANT_A)).toBeNull();
  });

  it("after an unlock request, lifts the restriction once and audits it", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    await unlock(SES_PLATFORM).expect(200);
    const res = await provision(SES_PLATFORM).expect(200);
    h.conforms("TenantAccessChange", res.body);
    expect(res.body.outcome).toBe("provisioned");
    expect(res.body.entitlement).toMatchObject({ tenant_id: TENANT_A, state: "unrestricted" });
    expect(typeof res.body.entitlement.provisioned_at).toBe("string");
    expect(await accessRow(h.env().admin, TENANT_A)).toMatchObject({
      state: "unrestricted",
      provisioned_by_user_id: USER_PLATFORM,
      provisioning_source: "manual_platform",
    });
    const audits = await newAudits(PROVISIONED);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: USER_PLATFORM, target_id: TENANT_A });
    expect((await read(SES_OWNER_ALL)).body.state).toBe("unrestricted");
  });

  it("a replay changes nothing (already_unrestricted), and a later unlock request is already_unrestricted", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    await unlock(SES_PLATFORM).expect(200);
    const first = await provision(SES_PLATFORM).expect(200);
    const replay = await provision(SES_PLATFORM).expect(200);
    h.conforms("TenantAccessChange", replay.body);
    expect(replay.body.outcome).toBe("already_unrestricted");
    expect(replay.body.entitlement.provisioned_at).toBe(first.body.entitlement.provisioned_at);
    const later = await unlock(SES_PLATFORM).expect(200);
    expect(later.body.outcome).toBe("already_unrestricted");
    expect(await newAudits(PROVISIONED)).toHaveLength(1);
    expect(await newAudits(UNLOCK_REQUESTED)).toHaveLength(1);
  });

  it("a tenant can never provision itself: owner and tenant_admin get 403, even after an unlock request", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    await unlock(SES_PLATFORM).expect(200);
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER]) {
      expectError(await provision(session), 403, "forbidden");
    }
    expect(await accessRow(h.env().admin, TENANT_A)).toMatchObject({ state: "restricted", provisioned_at: null });
  });

  it("is 404 for an unknown tenant", async () => {
    if (skip()) return;
    expectError(await provision(SES_PLATFORM, UNKNOWN_TENANT), 404, "not_found");
  });
});
