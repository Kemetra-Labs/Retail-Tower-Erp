/**
 * RT-1297: the REAL `PosPilotReleasesModule` with the pilot S3 key set, over real
 * Postgres. The sibling real-module spec boots the module with no key and
 * pins the fail-closed `null` binding; this one boots it with a complete (fake)
 * key and proves the shipped binding signs: an eligible, allowlisted tenant gets
 * a presigned URL that names the verified object version and a bounded expiry,
 * the secret key appears nowhere in the response or the audit row, and exactly
 * one audit row is written for the issued link (no URL in it).
 *
 * Presigning is local, so no bucket or network is involved.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

const KEY_ID = "AKIAFAKEKEYID000000";
const SECRET = "fake-secret-value-not-real";
process.env["POS_PILOT_RELEASE_PUBLISHER"] = "CN=Kemetra POS PILOT, O=Kemetra Labs";
process.env["POS_PILOT_RELEASE_BUCKET"] = "pilot-bucket";
process.env["POS_PILOT_RELEASE_S3_REGION"] = "us-east-1";
process.env["POS_PILOT_RELEASE_S3_ACCESS_KEY_ID"] = KEY_ID;
process.env["POS_PILOT_RELEASE_S3_SECRET_ACCESS_KEY"] = SECRET;
delete process.env["POS_PILOT_RELEASE_URL_TTL_SECONDS"];
delete process.env["POS_RELEASE_PRODUCTION_PUBLISHER"];

import { PosPilotReleasesModule } from "../../src/pos-pilot-releases/pos-pilot-releases.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { OWNER_A, PLATFORM_ADMIN, TENANT_A, seedDeviceHealthFixture } from "../device-health/__support__/device-health-fixture";

const h = scopedHttpHarness({
  label: "RT-1297 real module with the S3 presigner",
  contractId: "pos-pilot-releases.openapi",
  module: PosPilotReleasesModule,
  seed: seedDeviceHealthFixture,
});

const RELEASE_ID = "0190f5a2-3b4c-7d8e-9f01-000000002930";
const ISSUED = "pos.pilot_release.download_link_issued";

it("signs with the shipped binding: a version-pinned, bounded URL, one URL-free audit row, no secret anywhere", async () => {
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
  const before = Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = $1`, [ISSUED])).rows[0]!.n);

  const res = await h.get("/api/v1/pos-pilot-releases/latest", OWNER_A.session);

  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  h.conforms("LatestPilotRelease", res.body);
  const body = res.body as { available: true; downloadUrl: string; expiresAt: string };
  expect(body.available).toBe(true);
  const url = new URL(body.downloadUrl);
  expect(url.hostname).toBe("pilot-bucket.s3.us-east-1.amazonaws.com");
  expect(url.pathname).toBe("/pos/pilot/1.4.0/POS-Pulse-Setup-1.4.0.exe");
  expect(url.searchParams.get("versionId")).toBe("verid-1.4.0");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  expect(url.searchParams.get("X-Amz-Credential")).toContain(`${KEY_ID}/`);
  expect(JSON.stringify(res.body)).not.toContain(SECRET);

  const audits = await admin.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC, id DESC`,
    [ISSUED],
  );
  expect(audits.rows).toHaveLength(before + 1);
  const row = JSON.stringify(audits.rows[0]);
  expect(row).not.toContain("X-Amz");
  expect(row).not.toContain(SECRET);
  expect(audits.rows[0]!.metadata).toEqual({ releaseId: RELEASE_ID, version: "1.4.0" });
});
