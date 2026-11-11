/**
 * RT-1328: the two platform-admin reads of the pilot lane over HTTP against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool)
 * and the real guards. Only cookie authentication is faked (a header names the
 * session); the presigner is never called by these routes.
 *
 *   GET /api/v1/platform/pos-pilot-releases   platformListPilotReleases
 *   GET /api/v1/platform/pos-pilot-tenants    platformListPilotTenants
 *
 * What this proves (RT-1328 acceptance 2 to 4):
 *   - a platform admin reads every registry row, newest `registeredAt` first,
 *     withdrawn and current rows included, each conforming to `PilotRelease`;
 *   - a platform admin reads every allowlisted tenant, across tenants (RLS lets
 *     the platform context read them all), each conforming to `PilotTenant`;
 *   - a tenant user is 403, no session is 401, a query parameter is 400;
 *   - every 200 is `Cache-Control: no-store`, carries no presigned URL, and
 *     neither read writes an audit row.
 *
 * Rows are seeded through the superuser pool, so the reads are proved apart
 * from the write routes (RT-1298's spec covers those).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { AuthModule } from "../../src/auth/auth.module";
import { ContextModule } from "../../src/context/context.module";
import { PilotReleaseActivationController } from "../../src/pos-pilot-releases/pilot-release-activation.controller";
import { PilotReleaseRegistryService } from "../../src/pos-pilot-releases/pilot-release-registry.service";
import { PilotTenantsController } from "../../src/pos-pilot-releases/pilot-tenants.controller";
import { PilotTenantsService } from "../../src/pos-pilot-releases/pilot-tenants.service";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  OWNER_A,
  PLATFORM_ADMIN,
  TENANT_A,
  TENANT_B,
  seedDeviceHealthFixture,
} from "../device-health/__support__/device-health-fixture";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PilotTenantsController, PilotReleaseActivationController],
  providers: [PlatformAdminGuard, PilotTenantsService, PilotReleaseRegistryService],
})
class PilotPlatformReadsTestModule {}

const h = scopedHttpHarness({
  label: "RT-1328 pilot platform reads",
  contractId: "pos-pilot-releases.openapi",
  module: PilotPlatformReadsTestModule,
  seed: seedDeviceHealthFixture,
});

const RELEASES = "/api/v1/platform/pos-pilot-releases";
const TENANTS = "/api/v1/platform/pos-pilot-tenants";
const RUN_URL = "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321";

interface SeedRelease {
  readonly version: string;
  readonly registeredAt: string;
  readonly withdrawn?: boolean;
  readonly activated?: boolean;
}

/** Insert one registry row through the superuser pool and return its id. */
async function seedRelease(admin: Pool, release: SeedRelease): Promise<string> {
  const { version } = release;
  const res = await admin.query<{ id: string }>(
    `INSERT INTO pos_pilot_release_registry (
       id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha,
       artifact_key, artifact_version_id, approved, approved_at, approved_by, promotion_run_url,
       registered_at, withdrawn_at, withdrawn_by, activated_at, activated_by_user_id)
     VALUES (gen_random_uuid(), $1, $2, 133893640, 'CN=Kemetra POS PILOT', 'pilot',
       'https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/42', $3,
       'pos/pilot/' || $1 || '/POS-Pulse-Setup-' || $1 || '.exe', $4, $5, $6::timestamptz, 'kemetra-owner', $7,
       $6::timestamptz, $8::timestamptz, $9, $10::timestamptz, $11::uuid)
     RETURNING id`,
    [
      version,
      Buffer.from(version).toString("hex").padEnd(64, "a"),
      "c".repeat(40),
      `verid-${version}`,
      release.withdrawn !== true,
      release.registeredAt,
      RUN_URL,
      release.withdrawn === true ? release.registeredAt : null,
      release.withdrawn === true ? "kemetra-owner" : null,
      release.activated === true ? release.registeredAt : null,
      release.activated === true ? PLATFORM_ADMIN.id : null,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error("seedRelease: no row returned");
  return id;
}

/** How many audit rows exist (superuser, RLS-exempt). */
async function auditCount(admin: Pool): Promise<number> {
  const res = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events`);
  return Number(res.rows[0]?.n);
}

beforeEach(async () => {
  if (h.skipped()) return;
  const admin = h.env().admin;
  await admin.query(`DELETE FROM pos_pilot_release_registry`);
  await admin.query(`DELETE FROM pos_pilot_tenant_allowlist`);
});

describe("RT-1328 platformListPilotReleases", () => {
  it("answers an empty list when nothing is registered", async () => {
    if (h.skipped()) return;
    const res = await h.get(RELEASES, PLATFORM_ADMIN.session);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    h.conforms("PilotReleaseList", res.body);
  });

  it("lists every release newest first, with withdrawn and current rows, and no URL", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const old = await seedRelease(admin, { version: "0.1.1", registeredAt: "2026-11-01T10:00:00.000Z", withdrawn: true });
    const current = await seedRelease(admin, { version: "0.1.2", registeredAt: "2026-11-05T10:00:00.000Z", activated: true });
    const fresh = await seedRelease(admin, { version: "0.1.3", registeredAt: "2026-11-10T10:00:00.000Z" });
    const before = await auditCount(admin);

    const res = await h.get(RELEASES, PLATFORM_ADMIN.session);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    h.conforms("PilotReleaseList", res.body);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((item) => item["releaseId"])).toEqual([fresh, current, old]);
    expect(items[0]).toMatchObject({ version: "0.1.3", approved: true, activatedAt: null, withdrawnAt: null });
    expect(items[1]).toMatchObject({ version: "0.1.2", approved: true, activatedByUserId: PLATFORM_ADMIN.id });
    expect(items[2]).toMatchObject({ version: "0.1.1", approved: false, withdrawnBy: "kemetra-owner" });
    expect(JSON.stringify(res.body)).not.toMatch(/X-Amz|downloadUrl|artifactKey|pos\/pilot\//);
    expect(await auditCount(admin)).toBe(before);
  });

  it("refuses a tenant user (403), no session (401) and any query parameter (400)", async () => {
    if (h.skipped()) return;
    expect((await h.get(RELEASES, OWNER_A.session)).status).toBe(403);
    expect((await h.get(RELEASES, null)).status).toBe(401);
    expect((await h.get(RELEASES, PLATFORM_ADMIN.session, { limit: 10 })).status).toBe(400);
  });
});

describe("RT-1328 platformListPilotTenants", () => {
  it("answers an empty list when no tenant is allowlisted", async () => {
    if (h.skipped()) return;
    const res = await h.get(TENANTS, PLATFORM_ADMIN.session);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    h.conforms("PilotTenantList", res.body);
  });

  it("lists every allowlisted tenant across tenants, oldest first, with no audit row", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await admin.query(
      `INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id, added_at)
       VALUES ($1, $3, '2026-11-02T10:00:00Z'), ($2, $3, '2026-11-01T10:00:00Z')`,
      [TENANT_A, TENANT_B, PLATFORM_ADMIN.id],
    );
    const before = await auditCount(admin);

    const res = await h.get(TENANTS, PLATFORM_ADMIN.session);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    h.conforms("PilotTenantList", res.body);
    expect(res.body).toEqual({
      items: [
        { tenantId: TENANT_B, addedAt: "2026-11-01T10:00:00.000Z", addedByUserId: PLATFORM_ADMIN.id },
        { tenantId: TENANT_A, addedAt: "2026-11-02T10:00:00.000Z", addedByUserId: PLATFORM_ADMIN.id },
      ],
    });
    expect(await auditCount(admin)).toBe(before);
  });

  it("reflects an add and a remove made through the write routes", async () => {
    if (h.skipped()) return;
    expect((await h.put(`${TENANTS}/${TENANT_A}`, PLATFORM_ADMIN.session, {})).status).toBe(201);
    const listed = await h.get(TENANTS, PLATFORM_ADMIN.session);
    expect((listed.body as { items: Array<{ tenantId: string }> }).items.map((item) => item.tenantId)).toEqual([TENANT_A]);
    expect((await h.del(`${TENANTS}/${TENANT_A}`, PLATFORM_ADMIN.session)).status).toBe(204);
    expect((await h.get(TENANTS, PLATFORM_ADMIN.session)).body).toEqual({ items: [] });
  });

  it("refuses a tenant user (403), no session (401) and any query parameter (400)", async () => {
    if (h.skipped()) return;
    expect((await h.get(TENANTS, OWNER_A.session)).status).toBe(403);
    expect((await h.get(TENANTS, null)).status).toBe(401);
    expect((await h.get(TENANTS, PLATFORM_ADMIN.session, { tenantId: TENANT_A })).status).toBe(400);
  });
});
