/**
 * RT-1557 — `platformAdoptConnectorRegistration` over HTTP against real Postgres (Testcontainers,
 * every migration, the NOBYPASSRLS `app_test` pool), the real `ConnectorModule` (guards, controller,
 * service) and the real RLS. Only cookie authentication is faked: a header names the session.
 *
 * provisioning-feed.yaml 1.1.0-draft, the one operation:
 *   - refused for anyone who is not a platform admin (an owner and a tenant_admin of the very tenant,
 *     403 forbidden, no session 401), and a refused call changes nothing;
 *   - sets `managed_by = provisioner`, writes EXACTLY ONE `connector.registration.adopted` audit row
 *     (platform_admin actor, in the registration's tenant) and a platform admin of ANOTHER tenant can do it;
 *   - a repeat by the same admin changes nothing and writes no second audit row;
 *   - refused (409) for an already-managed registration with no adoption record, for one another admin
 *     adopted, and for a disabled registration; nothing changes;
 *   - 404 for an unknown registration, for a registration under another tenant's path and for an unknown
 *     tenant; 400 for malformed ids.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { ConnectorModule } from "../../../src/connector/connector.module";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SES_PLATFORM, UNKNOWN_TENANT } from "../../tenant-access-entitlement/__support__/access-fixture";
import {
  adoptionAudits,
  registrationState,
  seedAdoptFixture,
  seedRegistration,
  SES_PLATFORM_2,
  UNKNOWN_REGISTRATION,
  USER_PLATFORM,
} from "./__support__/adopt-fixture";

const h = scopedHttpHarness({
  label: "RT-1557 connector adoption",
  contractId: "provisioning-feed",
  module: ConnectorModule,
  seed: seedAdoptFixture,
});
const skip = (): boolean => h.skipped();

const adoptPath = (tenantId: string, id: string): string => `/api/v1/platform/tenants/${tenantId}/connector-instances/${id}/adopt`;
const adopt = (session: string | null, tenantId: string, id: string): request.Test => h.post(adoptPath(tenantId, id), session, {});

function expectError(res: request.Response, status: number, code: string, schema = "Error"): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms(schema, res.body);
}

describe("platformAdoptConnectorRegistration", () => {
  it("is refused for anyone who is not a platform admin, even for the owner and tenant_admin of that tenant, and changes nothing", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A });
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC]) {
      expectError(await adopt(session, TENANT_A, id), 403, "forbidden");
    }
    expectError(await adopt(null, TENANT_A, id), 401, "unauthorized");
    expect(await registrationState(h.env().admin, id)).toEqual({ managed_by: null, disabled_at: null });
    expect(await adoptionAudits(h.env().admin, id)).toHaveLength(0);
  });

  it("sets managed_by = provisioner and writes exactly one audit row, for a platform admin of another tenant", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A });
    const res = await adopt(SES_PLATFORM, TENANT_A, id).expect(200);
    h.conforms("AdoptedConnectorRegistration", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ outcome: "adopted", tenantId: TENANT_A, instanceId: id, managedBy: "provisioner", environment: "pilot" });

    expect(await registrationState(h.env().admin, id)).toEqual({ managed_by: "provisioner", disabled_at: null });
    const audits = await adoptionAudits(h.env().admin, id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: USER_PLATFORM,
      tenant_id: TENANT_A,
      target_type: "connector_registration",
      metadata: { actor_kind: "platform_admin", adopted_by_user_id: USER_PLATFORM, managed_by: "provisioner" },
    });
  });

  it("a repeat by the same admin changes nothing and writes no second audit row", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A });
    await adopt(SES_PLATFORM, TENANT_A, id).expect(200);
    const second = await adopt(SES_PLATFORM, TENANT_A, id).expect(200);
    h.conforms("AdoptedConnectorRegistration", second.body);
    expect(second.body.outcome).toBe("already_adopted");
    expect(await registrationState(h.env().admin, id)).toEqual({ managed_by: "provisioner", disabled_at: null });
    expect(await adoptionAudits(h.env().admin, id)).toHaveLength(1);
  });

  it("refuses a registration another admin adopted (409 already_managed) and writes nothing", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A });
    await adopt(SES_PLATFORM, TENANT_A, id).expect(200);
    expectError(await adopt(SES_PLATFORM_2, TENANT_A, id), 409, "already_managed", "AdoptRefusedError");
    const audits = await adoptionAudits(h.env().admin, id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_user_id).toBe(USER_PLATFORM);
  });

  it("refuses an already-managed registration with no adoption record (409 already_managed) and writes nothing", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A, managedBy: "provisioner" });
    expectError(await adopt(SES_PLATFORM, TENANT_A, id), 409, "already_managed", "AdoptRefusedError");
    expect(await registrationState(h.env().admin, id)).toEqual({ managed_by: "provisioner", disabled_at: null });
    expect(await adoptionAudits(h.env().admin, id)).toHaveLength(0);
  });

  it("refuses a disabled registration (409 registration_disabled) and writes nothing", async () => {
    if (skip()) return;
    const id = await seedRegistration(h.env().admin, { tenantId: TENANT_A, disabled: true });
    expectError(await adopt(SES_PLATFORM, TENANT_A, id), 409, "registration_disabled", "AdoptRefusedError");
    const state = await registrationState(h.env().admin, id);
    expect(state?.managed_by).toBeNull();
    expect(await adoptionAudits(h.env().admin, id)).toHaveLength(0);
  });

  it("is a non-disclosing 404 for an unknown registration, another tenant's registration, and an unknown tenant", async () => {
    if (skip()) return;
    const inB = await seedRegistration(h.env().admin, { tenantId: TENANT_B });
    expectError(await adopt(SES_PLATFORM, TENANT_A, UNKNOWN_REGISTRATION), 404, "not_found");
    expectError(await adopt(SES_PLATFORM, TENANT_A, inB), 404, "not_found");
    expectError(await adopt(SES_PLATFORM, UNKNOWN_TENANT, inB), 404, "not_found");
    expect(await registrationState(h.env().admin, inB)).toEqual({ managed_by: null, disabled_at: null });
    expect(await adoptionAudits(h.env().admin, inB)).toHaveLength(0);
  });

  it("is 400 validation_error for a malformed tenant id or registration id", async () => {
    if (skip()) return;
    expectError(await adopt(SES_PLATFORM, "not-a-uuid", UNKNOWN_REGISTRATION), 400, "validation_error");
    expectError(await adopt(SES_PLATFORM, TENANT_A, "nope"), 400, "validation_error");
  });
});
