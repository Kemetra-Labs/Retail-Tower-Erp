/**
 * RT-1292: the REAL `PosPilotReleasesModule`, with its environment-derived
 * configuration and its shipped presigner binding, over real Postgres. The
 * never-cross spec builds its own module around a fake presigner; this one boots
 * what production boots, so the wiring is tested rather than assumed.
 *
 * The pilot pin and the bucket are set (the lane is configured) but the pilot S3
 * key (`POS_PILOT_RELEASE_S3_*`, RT-1297) is not, so the shipped binding is
 * `null`. An otherwise eligible, allowlisted tenant must therefore get exactly
 * `{ "available": false }` and no audit row: an unconfigured lane fails closed,
 * never with an error and never with a URL. (Pin unset and bucket unset are
 * pinned by the config unit spec; the bound presigner by
 * `pos-pilot-release.real-module-s3.spec.ts`.)
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

process.env["POS_PILOT_RELEASE_PUBLISHER"] = "CN=Kemetra POS PILOT, O=Kemetra Labs";
process.env["POS_PILOT_RELEASE_BUCKET"] = "pilot-bucket";
delete process.env["POS_PILOT_RELEASE_URL_TTL_SECONDS"];
delete process.env["POS_RELEASE_PRODUCTION_PUBLISHER"];
delete process.env["POS_PILOT_RELEASE_S3_REGION"];
delete process.env["POS_PILOT_RELEASE_S3_ACCESS_KEY_ID"];
delete process.env["POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY"];

import { PosPilotReleasesModule } from "../../src/pos-pilot-releases/pos-pilot-releases.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { OWNER_A, PLATFORM_ADMIN, TENANT_A, seedDeviceHealthFixture } from "../device-health/__support__/device-health-fixture";

const h = scopedHttpHarness({
  label: "RT-1292 real module",
  contractId: "pos-pilot-releases.openapi",
  module: PosPilotReleasesModule,
  seed: seedDeviceHealthFixture,
});

const RELEASE_ID = "0190f5a2-3b4c-7d8e-9f01-000000002929";

it("fails closed with the null presigner (no S3 key set): an eligible, allowlisted tenant gets { available: false }", async () => {
  if (h.skipped()) return;
  const admin = h.env().admin;
  await admin.query(`DELETE FROM pos_pilot_release_registry`);
  await admin.query(`DELETE FROM pos_pilot_tenant_allowlist`);
  await admin.query(
    `INSERT INTO pos_pilot_release_registry
       (id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha, artifact_key,
        artifact_version_id, approved_at, approved_by, promotion_run_url, activated_at, activated_by_user_id)
     VALUES ($1, '1.4.0', $2, 185483052, 'CN=Kemetra POS PILOT, O=Kemetra Labs', 'pilot',
       'https://github.com/Kemetra-Labs/Retail-Tower-Erp/attestations/1', $3,
       'pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe', 'verid-1.4.0', now(), 'kemetra-owner',
       'https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/1', now(), $4)`,
    [RELEASE_ID, "a".repeat(64), "c".repeat(40), PLATFORM_ADMIN.id],
  );
  await admin.query(`INSERT INTO pos_pilot_tenant_allowlist (tenant_id, added_by_user_id) VALUES ($1, $2)`, [TENANT_A, PLATFORM_ADMIN.id]);
  const before = Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = $1`, ["pos.pilot_release.download_link_issued"])).rows[0]!.n);

  const res = await h.get("/api/v1/pos-pilot-releases/latest", OWNER_A.session);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ available: false });
  h.conforms("LatestPilotRelease", res.body);
  const after = Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = $1`, ["pos.pilot_release.download_link_issued"])).rows[0]!.n);
  expect(after).toBe(before);
});
