/**
 * RT-1292 (RT-1290 slice P1): the POS pilot release lane over HTTP against real
 * Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool)
 * and the real guards. Only cookie authentication is faked (a header names the
 * session) and the presigner is a fake that records its calls.
 *
 *   GET    /api/v1/pos-pilot-releases/latest                  consolePilotGetLatestPosRelease
 *   PUT    /api/v1/platform/pos-pilot-tenants/{tenantId}      platformAddPilotTenant
 *   DELETE /api/v1/platform/pos-pilot-tenants/{tenantId}      platformRemovePilotTenant
 *
 * What this proves (RT-1292 acceptance 2 to 5):
 *   - a lab or production release, a lab-marked publisher and a second current
 *     release cannot be stored (direct SQL, whoever runs it), and a stored
 *     release cannot be edited except for approval, withdrawal and activation;
 *   - the resolver answers `available:true` only for an allowlisted tenant, an
 *     allowed role, and an approved, activated release whose publisher is the
 *     configured pin; every other case is the same `{ "available": false }`;
 *   - an issued link writes one tenant-scoped audit row without the URL; the
 *     URL names the verified object version; the reply is `no-store`;
 *   - the allowlist is changed by a platform admin only, audited once per
 *     effective change, and a tenant context cannot write it (RLS).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { PlatformAdminGuard } from "../../src/audit/platform-admin.guard";
import { AuthModule } from "../../src/auth/auth.module";
import { ContextModule } from "../../src/context/context.module";
import { resolvePilotReleaseConfig, type PilotReleaseConfig } from "../../src/pos-pilot-releases/pilot-release.config";
import { resolveLatestPilotRelease } from "../../src/pos-pilot-releases/pilot-release.resolver";
import { grantSupportSession } from "../_helpers/support-session";
import { registerTestSession } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  PILOT_RELEASE_CONFIG,
  PILOT_RELEASE_PRESIGNER,
  type PilotReleasePresignRequest,
  type PilotReleasePresigner,
} from "../../src/pos-pilot-releases/pilot-release.presigner";
import { PilotReleaseService } from "../../src/pos-pilot-releases/pilot-release.service";
import { PilotReleasesController } from "../../src/pos-pilot-releases/pilot-releases.controller";
import { PilotTenantsController } from "../../src/pos-pilot-releases/pilot-tenants.controller";
import { PilotTenantsService } from "../../src/pos-pilot-releases/pilot-tenants.service";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  MANAGER_A1,
  OWNER_A,
  OWNER_B,
  PLATFORM_ADMIN,
  STAFF_A,
  TENANT_A,
  TENANT_B,
  seedDeviceHealthFixture,
} from "../device-health/__support__/device-health-fixture";

const PIN = "CN=Kemetra POS PILOT, O=Kemetra Labs";
const CONFIG: PilotReleaseConfig = { enabled: true, publisher: PIN, bucket: "pilot-bucket", urlTtlSeconds: 300 };
const URL_SIGNATURE = "sig-must-never-be-stored";

/** Records every presign request; `failing` makes the next ones throw. */
const presigner = {
  calls: [] as PilotReleasePresignRequest[],
  failing: false,
  impl: {
    presignGet: async (request: PilotReleasePresignRequest) => {
      presigner.calls.push(request);
      if (presigner.failing) throw new Error("presign failed");
      return {
        url: `https://${request.bucket}.s3.example/${request.key}?versionId=${request.versionId}&X-Amz-Signature=${URL_SIGNATURE}`,
        expiresAt: new Date(Date.now() + request.ttlSeconds * 1000),
      };
    },
  } satisfies PilotReleasePresigner,
};

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PilotReleasesController, PilotTenantsController],
  providers: [
    { provide: PILOT_RELEASE_CONFIG, useValue: CONFIG },
    { provide: PILOT_RELEASE_PRESIGNER, useValue: presigner.impl },
    PlatformAdminGuard,
    PilotReleaseService,
    PilotTenantsService,
  ],
})
class PilotReleasesTestModule {}

const h = scopedHttpHarness({
  label: "RT-1292 pilot releases",
  contractId: "pos-pilot-releases.openapi",
  module: PilotReleasesTestModule,
  seed: seedDeviceHealthFixture,
});

const LATEST = "/api/v1/pos-pilot-releases/latest";
const tenantPath = (tenantId: string): string => `/api/v1/platform/pos-pilot-tenants/${tenantId}`;
const ISSUED = "pos.pilot_release.download_link_issued";
const ADDED = "pos.pilot_tenant.added";
const REMOVED = "pos.pilot_tenant.removed";

const RELEASE_ID = "0190f5a2-3b4c-7d8e-9f01-000000001292";
const OTHER_RELEASE_ID = "0190f5a2-3b4c-7d8e-9f01-000000001293";
const UNKNOWN_TENANT = "0190f5a2-3b4c-7d8e-9f01-0000000fffff";

interface ReleaseSeed {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly publisher: string;
  readonly signingClass: string;
  readonly approved: boolean;
}

const RELEASE: ReleaseSeed = {
  id: RELEASE_ID,
  version: "1.4.0",
  sha256: "a".repeat(64),
  publisher: PIN,
  signingClass: "pilot",
  approved: true,
};

async function insertRelease(admin: Pool, seed: ReleaseSeed): Promise<void> {
  await admin.query(
    `INSERT INTO pos_pilot_release_registry
       (id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha,
        artifact_key, artifact_version_id, approved, approved_at, approved_by, promotion_run_url,
        withdrawn_at, withdrawn_by)
     VALUES ($1, $2, $3, 185483052, $4, $5,
        'https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/123456', $6,
        'pos/pilot/' || $2 || '/POS-Pulse-Setup-' || $2 || '.exe', 'verid-' || $2, $7, now(), 'kemetra-owner',
        'https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/987654321',
        CASE WHEN $7 THEN NULL ELSE now() END, CASE WHEN $7 THEN NULL ELSE 'kemetra-owner' END)`,
    [seed.id, seed.version, seed.sha256, seed.publisher, seed.signingClass, "c".repeat(40), seed.approved],
  );
}

async function activate(admin: Pool, id: string): Promise<void> {
  await admin.query(`UPDATE pos_pilot_release_registry SET activated_at = now(), activated_by_user_id = $2 WHERE id = $1`, [
    id,
    PLATFORM_ADMIN.id,
  ]);
}

async function allowlist(admin: Pool, tenantId: string): Promise<void> {
  await admin.query(`INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id) VALUES ($1, $2)`, [tenantId, PLATFORM_ADMIN.id]);
}

interface AuditRow {
  actor_user_id: string | null;
  tenant_id: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
}

/** audit_events is append-only: rows written before the current test are skipped. */
const baselines = new Map<string, number>();

async function audits(admin: Pool, action: string): Promise<AuditRow[]> {
  const r = await admin.query<AuditRow>(`SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`, [action]);
  return r.rows.slice(baselines.get(action) ?? 0);
}

async function markBaselines(admin: Pool): Promise<void> {
  for (const action of [ISSUED, ADDED, REMOVED]) {
    baselines.set(action, 0);
    baselines.set(action, (await audits(admin, action)).length);
  }
}

beforeEach(async () => {
  if (h.skipped()) return;
  const admin = h.env().admin;
  await admin.query(`DELETE FROM pos_pilot_release_registry`);
  await admin.query(`DELETE FROM pos_pilot_tenant_allowlist`);
  await markBaselines(admin);
  presigner.calls.length = 0;
  presigner.failing = false;
});

async function sqlError(work: Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await work;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message?: string };
    return { ...(e.code !== undefined ? { code: e.code } : {}), ...(e.constraint !== undefined ? { constraint: e.constraint } : {}), message: e.message ?? "" };
  }
  throw new Error("expected the statement to fail");
}

describe("RT-1292 the pilot registry cannot hold a lab or production release (by construction)", () => {
  it.each(["lab", "production"])("refuses signing class %s", async (signingClass) => {
    if (h.skipped()) return;
    const err = await sqlError(insertRelease(h.env().admin, { ...RELEASE, signingClass }));
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("pos_pilot_release_registry_class_pilot");
  });

  it.each(["Kemetra POS LAB TEST - NOT FOR PRODUCTION", "CN=lab test here", "CN=not for production"])(
    "refuses the lab-marked publisher %s even with class pilot",
    async (publisher) => {
      if (h.skipped()) return;
      const err = await sqlError(insertRelease(h.env().admin, { ...RELEASE, publisher }));
      expect(err.code).toBe("23514");
      expect(err.constraint).toBe("pos_pilot_release_registry_publisher_shape");
    },
  );

  it("allows at most one current (approved and activated) release", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await insertRelease(admin, RELEASE);
    await insertRelease(admin, { ...RELEASE, id: OTHER_RELEASE_ID, version: "1.5.0", sha256: "b".repeat(64) });
    await activate(admin, RELEASE_ID);
    const err = await sqlError(activate(admin, OTHER_RELEASE_ID));
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("pos_pilot_release_registry_one_current");
    await admin.query(
      `UPDATE pos_pilot_release_registry SET approved = false, withdrawn_at = now(), withdrawn_by = 'kemetra-owner' WHERE id = $1`,
      [RELEASE_ID],
    );
    await activate(admin, OTHER_RELEASE_ID);
  });

  it("refuses to edit a release except for approval, withdrawal and activation", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await insertRelease(admin, RELEASE);
    const edit = await sqlError(admin.query(`UPDATE pos_pilot_release_registry SET sha256 = $2 WHERE id = $1`, [RELEASE_ID, "d".repeat(64)]));
    expect(edit.code).toBe("23514");
    expect(edit.message).toContain("immutable");
    await activate(admin, RELEASE_ID);
    const cleared = await sqlError(admin.query(`UPDATE pos_pilot_release_registry SET activated_at = NULL, activated_by_user_id = NULL WHERE id = $1`, [RELEASE_ID]));
    expect(cleared.code).toBe("23514");
    await admin.query(
      `UPDATE pos_pilot_release_registry SET approved = false, withdrawn_at = now(), withdrawn_by = 'kemetra-owner' WHERE id = $1`,
      [RELEASE_ID],
    );
    const reapproved = await sqlError(
      admin.query(`UPDATE pos_pilot_release_registry SET approved = true, withdrawn_at = NULL, withdrawn_by = NULL WHERE id = $1`, [RELEASE_ID]),
    );
    expect(reapproved.code).toBe("23514");
    expect(reapproved.message).toContain("never re-approved");
  });
});

describe("RT-1292 the resolver: who may call it", () => {
  it("answers 401 to no session and to a bearer", async () => {
    if (h.skipped()) return;
    await h.get(LATEST, null).expect(401);
    await h.get(LATEST, null).set("authorization", `Bearer ${DEV_A1A.token}`).expect(401);
  });

  it("answers 401 to a signed-in platform admin with no active tenant", async () => {
    if (h.skipped()) return;
    const res = await h.get(LATEST, PLATFORM_ADMIN.session);
    expect(res.status).toBe(401);
    expect(presigner.calls).toEqual([]);
  });

  it("answers 403 support_session_required to a platform admin in tenant A with no membership and no support session, and admits them with one", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const session = "0190f5a2-3b4c-7d8e-9f01-000000009292";
    await admin.query(
      `INSERT INTO sessions (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))
       ON CONFLICT (id) DO NOTHING`,
      [session, PLATFORM_ADMIN.id, TENANT_A],
    );
    registerTestSession(session, PLATFORM_ADMIN.id);
    await insertRelease(admin, RELEASE);
    await activate(admin, RELEASE_ID);
    await allowlist(admin, TENANT_A);
    const refused = await h.get(LATEST, session);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe("support_session_required");
    expect(presigner.calls).toEqual([]);
    expect(await audits(admin, ISSUED)).toEqual([]);
    await grantSupportSession(admin, session, PLATFORM_ADMIN.id, TENANT_A);
    const admitted = await h.get(LATEST, session);
    expect(admitted.status).toBe(200);
    expect(admitted.body).toMatchObject({ available: true, version: "1.4.0" });
  });

  it("answers the non-disclosing 404 to a role outside owner, tenant_admin and store_manager", async () => {
    if (h.skipped()) return;
    const res = await h.get(LATEST, STAFF_A.session);
    expect(res.status).toBe(404);
    h.conforms("Error", res.body);
  });

  it("answers 400 to any query parameter, after the guards and before any read", async () => {
    if (h.skipped()) return;
    const res = await h.get(LATEST, OWNER_A.session, { tenant: TENANT_B });
    expect(res.status).toBe(400);
    expect(presigner.calls).toEqual([]);
  });
});

describe("RT-1292 configuration refusals: a pin that could admit a lab or production release disables the lane", () => {
  const ENV = { POS_PILOT_RELEASE_BUCKET: "pilot-bucket" };
  const eligibleDeps = (config: PilotReleaseConfig): Parameters<typeof resolveLatestPilotRelease>[0] => ({
    config,
    presigner: presigner.impl,
    readState: async () => ({
      allowlisted: true,
      release: {
        id: RELEASE_ID,
        version: "1.4.0",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        publisher: PIN,
        signingClass: "pilot",
        artifactKey: "pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe",
        artifactVersionId: "verid-1.4.0",
      },
    }),
    recordIssued: async () => undefined,
    recordOutcome: () => undefined,
    now: () => new Date(),
  });

  it.each([
    ["equal to the production pin", { POS_PILOT_RELEASE_PUBLISHER: PIN, POS_RELEASE_PRODUCTION_PUBLISHER: PIN }],
    ["carrying the lab marker", { POS_PILOT_RELEASE_PUBLISHER: "CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION" }],
  ])("refuses a pilot pin %s: the lane is disabled and the resolver answers { available: false }", async (_label, env) => {
    const config = resolvePilotReleaseConfig({ ...ENV, ...env });
    expect(config).toEqual({ enabled: false, reason: "pin_invalid" });
    presigner.calls.length = 0;
    expect(await resolveLatestPilotRelease(eligibleDeps(config))).toEqual({ available: false });
    expect(presigner.calls).toEqual([]);
  });

  it("control: a distinct pilot pin enables the lane for the same eligible release", async () => {
    const config = resolvePilotReleaseConfig({ ...ENV, POS_PILOT_RELEASE_PUBLISHER: PIN, POS_RELEASE_PRODUCTION_PUBLISHER: "CN=Kemetra Labs, O=Kemetra" });
    expect(config.enabled).toBe(true);
    presigner.calls.length = 0;
    expect(await resolveLatestPilotRelease(eligibleDeps(config))).toMatchObject({ available: true });
  });
});

describe("RT-1292 the resolver: every ineligible case is the same { available: false }", () => {
  async function expectUnavailable(session: string): Promise<void> {
    const res = await h.get(LATEST, session);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
    h.conforms("LatestPilotRelease", res.body);
    expect(presigner.calls).toEqual([]);
    expect(await audits(h.env().admin, ISSUED)).toEqual([]);
  }

  it("is false for a tenant that is not allowlisted, even with a current release", async () => {
    if (h.skipped()) return;
    await insertRelease(h.env().admin, RELEASE);
    await activate(h.env().admin, RELEASE_ID);
    await expectUnavailable(OWNER_A.session);
  });

  it("is false for another tenant when only tenant A is allowlisted", async () => {
    if (h.skipped()) return;
    await insertRelease(h.env().admin, RELEASE);
    await activate(h.env().admin, RELEASE_ID);
    await allowlist(h.env().admin, TENANT_A);
    await expectUnavailable(OWNER_B.session);
  });

  it("is false when no release exists", async () => {
    if (h.skipped()) return;
    await allowlist(h.env().admin, TENANT_A);
    await expectUnavailable(OWNER_A.session);
  });

  it("is false for a registered release that was never activated", async () => {
    if (h.skipped()) return;
    await insertRelease(h.env().admin, RELEASE);
    await allowlist(h.env().admin, TENANT_A);
    await expectUnavailable(OWNER_A.session);
  });

  it("is false once the current release is withdrawn", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await insertRelease(admin, RELEASE);
    await activate(admin, RELEASE_ID);
    await allowlist(admin, TENANT_A);
    await admin.query(
      `UPDATE pos_pilot_release_registry SET approved = false, withdrawn_at = now(), withdrawn_by = 'kemetra-owner' WHERE id = $1`,
      [RELEASE_ID],
    );
    await expectUnavailable(OWNER_A.session);
  });

  it("is false when the stored publisher is not the configured pin", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await insertRelease(admin, { ...RELEASE, publisher: "CN=Someone Else, O=Elsewhere" });
    await activate(admin, RELEASE_ID);
    await allowlist(admin, TENANT_A);
    await expectUnavailable(OWNER_A.session);
  });
});

describe("RT-1292 the resolver: the control case (so the refusals above do not pass vacuously)", () => {
  async function eligible(): Promise<void> {
    const admin = h.env().admin;
    await insertRelease(admin, RELEASE);
    await activate(admin, RELEASE_ID);
    await allowlist(admin, TENANT_A);
  }

  it.each([
    ["an owner", OWNER_A.session],
    ["a store manager", MANAGER_A1.session],
  ])("returns the release and a URL naming the verified version to %s", async (_who, session) => {
    if (h.skipped()) return;
    await eligible();
    const res = await h.get(LATEST, session);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    h.conforms("LatestPilotRelease", res.body);
    const body = res.body as { available: true; version: string; fileName: string; expectedPublisher: string; downloadUrl: string; expiresAt: string };
    expect(body).toMatchObject({ available: true, version: "1.4.0", fileName: "POS-Pulse-Setup-1.4.0.exe", expectedPublisher: PIN });
    expect(body.downloadUrl).toContain("versionId=verid-1.4.0");
    expect(presigner.calls).toEqual([
      {
        bucket: "pilot-bucket",
        key: "pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe",
        versionId: "verid-1.4.0",
        fileName: "POS-Pulse-Setup-1.4.0.exe",
        ttlSeconds: 300,
      },
    ]);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it("writes one tenant-scoped audit row per issued link, with no URL, key or token in it", async () => {
    if (h.skipped()) return;
    await eligible();
    await h.get(LATEST, OWNER_A.session).expect(200);
    const rows = await audits(h.env().admin, ISSUED);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.actor_user_id).toBe(OWNER_A.id);
    expect(row.target_id).toBe(RELEASE_ID);
    expect(row.metadata).toEqual({ releaseId: RELEASE_ID, version: "1.4.0" });
    expect(JSON.stringify(row)).not.toContain(URL_SIGNATURE);
    expect(JSON.stringify(row)).not.toContain("https://");
  });

  it("answers 500, never available:false, when presigning fails, and writes no audit row", async () => {
    if (h.skipped()) return;
    await eligible();
    presigner.failing = true;
    const res = await h.get(LATEST, OWNER_A.session);
    expect(res.status).toBe(500);
    expect(await audits(h.env().admin, ISSUED)).toEqual([]);
  });
});

describe("RT-1292 the pilot allowlist: platform admins only", () => {
  it("answers 401 to no session, and 403 forbidden to a tenant owner, writing nothing", async () => {
    if (h.skipped()) return;
    await h.put(tenantPath(TENANT_A), null, {}).expect(401);
    await h.del(tenantPath(TENANT_A), null).expect(401);
    for (const res of [await h.put(tenantPath(TENANT_A), OWNER_A.session, {}), await h.del(tenantPath(TENANT_A), OWNER_A.session)]) {
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    }
    const rows = await h.env().admin.query(`SELECT 1 FROM pos_pilot_tenant_allowlist`);
    expect(rows.rowCount).toBe(0);
  });

  it("adds a tenant once (201), is idempotent (200), and audits only the effective change", async () => {
    if (h.skipped()) return;
    const first = await h.put(tenantPath(TENANT_A), PLATFORM_ADMIN.session, {});
    expect(first.status).toBe(201);
    h.conforms("PilotTenant", first.body);
    expect(first.headers["cache-control"]).toBe("no-store");
    const again = await h.put(tenantPath(TENANT_A), PLATFORM_ADMIN.session, {});
    expect(again.status).toBe(200);
    h.conforms("PilotTenant", again.body);
    const rows = await audits(h.env().admin, ADDED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: PLATFORM_ADMIN.id, tenant_id: null, target_type: "tenant", target_id: TENANT_A });
    expect(rows[0]!.metadata).toEqual({ tenantId: TENANT_A });
  });

  it("answers 404 tenant_not_found for an unknown tenant and 400 for a malformed id", async () => {
    if (h.skipped()) return;
    const unknown = await h.put(tenantPath(UNKNOWN_TENANT), PLATFORM_ADMIN.session, {});
    expect(unknown.status).toBe(404);
    expect((unknown.body as { error: { code: string } }).error.code).toBe("tenant_not_found");
    expect((await h.put(tenantPath("not-a-uuid"), PLATFORM_ADMIN.session, {})).status).toBe(400);
    expect(await audits(h.env().admin, ADDED)).toEqual([]);
  });

  it("removes a tenant (204), is idempotent, audits only the effective removal, and the lane closes", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await insertRelease(admin, RELEASE);
    await activate(admin, RELEASE_ID);
    await h.put(tenantPath(TENANT_A), PLATFORM_ADMIN.session, {}).expect(201);
    expect((await h.get(LATEST, OWNER_A.session)).body).toMatchObject({ available: true });
    await h.del(tenantPath(TENANT_A), PLATFORM_ADMIN.session).expect(204);
    await h.del(tenantPath(TENANT_A), PLATFORM_ADMIN.session).expect(204);
    expect((await h.get(LATEST, OWNER_A.session)).body).toEqual({ available: false });
    const rows = await audits(admin, REMOVED);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ tenantId: TENANT_A });
  });

  it("lets a tenant context read only its own allowlist row, and never write the allowlist or the registry (RLS)", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await allowlist(admin, TENANT_A);
    await allowlist(admin, TENANT_B);
    const asTenantA = <T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
      runWithTenantContext(h.env().app, { tenantId: TENANT_A, isPlatformAdmin: false }, work);
    const seen = await asTenantA((client) => client.query<{ tenant_id: string }>(`SELECT tenant_id FROM pos_pilot_tenant_allowlist`));
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
    const insert = await sqlError(
      asTenantA((client) => client.query(`INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id) VALUES ($1, $2)`, [UNKNOWN_TENANT, OWNER_A.id])),
    );
    expect(insert.code).toBe("42501");
    const removed = await asTenantA((client) => client.query(`DELETE FROM pos_pilot_tenant_allowlist WHERE tenant_id = $1`, [TENANT_A]));
    expect(removed.rowCount).toBe(0);
    const registry = await sqlError(
      asTenantA((client) =>
        client.query(
          `INSERT INTO pos_pilot_release_registry
             (id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha, artifact_key,
              artifact_version_id, approved_at, approved_by, promotion_run_url)
           VALUES ($1, '1.4.0', $2, 1, 'CN=x', 'pilot',
             'https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/1', $3,
             'pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe', 'v', now(), 'kemetra-owner',
             'https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/1')`,
          [RELEASE_ID, "e".repeat(64), "c".repeat(40)],
        ),
      ),
    );
    expect(registry.code).toBe("42501");
  });
});
