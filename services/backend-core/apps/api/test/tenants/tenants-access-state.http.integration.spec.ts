/**
 * RT-1350 slice 6a: `GET /api/v1/tenants` shows each tenant's access state to a
 * platform admin, over HTTP against real Postgres (Testcontainers, every migration
 * incl. 0105 and 0110, the NOBYPASSRLS `app_test` pool), the real module graph and
 * the real service and repository. Only cookie authentication is faked (a header
 * names the session, RT-192).
 *
 * What this proves:
 *   - a platform admin's list carries `access_state`, `unlock_requested_at` and
 *     `provisioned_at` on every row; a tenant with NO stored row reads `unrestricted`
 *     with both timestamps null (the RT-1353 rule), which only works because the 0110
 *     platform-wide SELECT policy lets the LEFT JOIN see other tenants' rows;
 *   - `?access_state=restricted` returns exactly the restricted tenants and
 *     `?access_state=unrestricted` the rest, including tenants with no row (SQL filter);
 *   - the unlock request and the provisioning result show up as timestamps;
 *   - a member's list (not a platform admin) is unchanged: no access fields, and the
 *     filter is a 403, never silently ignored; an unknown value is a 400 for anyone;
 *   - every row validates against the contract's `TenantSummary`.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { TenantsModule } from "../../src/tenants/tenants.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { clearAccess, restrict, SES_PLATFORM, seedAccessFixture, USER_PLATFORM } from "../tenant-access-entitlement/__support__/access-fixture";

const h = scopedHttpHarness({
  label: "RT-1350 6a tenants access state",
  contractId: "tenants.openapi",
  module: TenantsModule,
  seed: seedAccessFixture,
});
const skip = (): boolean => h.skipped();

const PATH = "/api/v1/tenants";

interface Row {
  id: string;
  access_state?: string;
  unlock_requested_at?: string | null;
  provisioned_at?: string | null;
}

const list = (session: string | null, access_state?: string): request.Test =>
  h.get(PATH, session, access_state === undefined ? undefined : { access_state });
const ids = (res: request.Response): string[] => (res.body as Row[]).map((r) => r.id).sort();
const byId = (res: request.Response, id: string): Row => (res.body as Row[]).find((r) => r.id === id)!;

afterEach(async () => {
  if (h.skipped()) return;
  for (const t of [TENANT_A, TENANT_B]) await clearAccess(h.env().admin, t);
});

describe("GET /api/v1/tenants as a platform admin", () => {
  it("every row carries the access state; a tenant with no row is unrestricted with null timestamps", async () => {
    if (skip()) return;
    const res = await list(SES_PLATFORM);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([TENANT_A, TENANT_B].sort()));
    for (const row of res.body as Row[]) {
      expect(row).toMatchObject({ access_state: "unrestricted", unlock_requested_at: null, provisioned_at: null });
      h.conforms("TenantSummary", row);
    }
  });

  it("sees another tenant's restriction (the 0110 platform-wide read): restricted, unlock requested, provisioned", async () => {
    if (skip()) return;
    const admin = h.env().admin;
    await restrict(admin, TENANT_A);
    await restrict(admin, TENANT_B);
    await admin.query(
      `UPDATE tenant_access_entitlements SET unlock_requested_at = '2026-11-13T10:00:00Z', unlock_requested_by_user_id = $2 WHERE tenant_id = $1`,
      [TENANT_B, USER_PLATFORM],
    );
    const res = await list(SES_PLATFORM);
    expect(byId(res, TENANT_A)).toMatchObject({ access_state: "restricted", unlock_requested_at: null, provisioned_at: null });
    const b = byId(res, TENANT_B);
    expect(b.access_state).toBe("restricted");
    expect(new Date(b.unlock_requested_at as string).toISOString()).toBe("2026-11-13T10:00:00.000Z");
    expect(b.provisioned_at).toBeNull();

    await admin.query(
      `UPDATE tenant_access_entitlements SET state = 'unrestricted', provisioned_at = '2026-11-14T10:00:00Z', provisioned_by_user_id = $2, provisioning_source = 'manual_platform' WHERE tenant_id = $1`,
      [TENANT_B, USER_PLATFORM],
    );
    const after = byId(await list(SES_PLATFORM), TENANT_B);
    expect(after.access_state).toBe("unrestricted");
    expect(new Date(after.provisioned_at as string).toISOString()).toBe("2026-11-14T10:00:00.000Z");
    h.conforms("TenantSummary", after);
  });

  it("?access_state=restricted keeps exactly the restricted tenants; =unrestricted the rest, rows with no row included", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    const restricted = await list(SES_PLATFORM, "restricted");
    expect(restricted.status).toBe(200);
    expect(ids(restricted)).toEqual([TENANT_A]);

    const open = await list(SES_PLATFORM, "unrestricted");
    expect(open.status).toBe(200);
    expect(ids(open)).toContain(TENANT_B);
    expect(ids(open)).not.toContain(TENANT_A);
    for (const row of open.body as Row[]) expect(row.access_state).toBe("unrestricted");
  });

  it("a soft-deleted tenant is not listed, as before", async () => {
    if (skip()) return;
    const admin = h.env().admin;
    await admin.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [TENANT_B]);
    try {
      expect(ids(await list(SES_PLATFORM))).not.toContain(TENANT_B);
      expect(ids(await list(SES_PLATFORM, "unrestricted"))).not.toContain(TENANT_B);
    } finally {
      await admin.query(`UPDATE tenants SET deleted_at = NULL WHERE id = $1`, [TENANT_B]);
    }
  });
});

describe("GET /api/v1/tenants as a member (not a platform admin)", () => {
  it("is unchanged: only the member's tenants and no access fields, even when the tenant is restricted", async () => {
    if (skip()) return;
    await restrict(h.env().admin, TENANT_A);
    const res = await list(SES_OWNER_ALL);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([TENANT_A]);
    expect(res.body[0]).not.toHaveProperty("access_state");
    expect(res.body[0]).not.toHaveProperty("unlock_requested_at");
    expect(res.body[0]).not.toHaveProperty("provisioned_at");
  });

  it("the access_state filter is a 403, not silently ignored", async () => {
    if (skip()) return;
    for (const value of ["restricted", "unrestricted"]) {
      const res = await list(SES_OWNER_ALL, value);
      expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 403, code: "forbidden" });
    }
  });
});

describe("GET /api/v1/tenants?access_state= with a bad value", () => {
  it.each([SES_PLATFORM, SES_OWNER_ALL])("is a 400 validation_error for session %s", async (session) => {
    if (skip()) return;
    const res = await list(session, "bogus");
    expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 400, code: "validation_error" });
  });
});
