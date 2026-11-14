/**
 * RT-1358 — the ERP provisioning service over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0109/0110, the NOBYPASSRLS `app_test`
 * pool, the real module graph). Only the cookie session is faked (header).
 *
 * provisioning-feed.yaml, every operation: the unlock trigger, pull, step ack,
 * credential issue, outcome, and the three platform-admin credential routes;
 * plus the managed-registration guard and the mark-provisioned change.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { Reflector } from "@nestjs/core";

import { AuthGuard } from "../../src/auth/auth.guard";
import { FailClosedAuthGuard } from "../../src/auth/fail-closed-auth.guard";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { SES_PLATFORM, seedAccessFixture } from "../tenant-access-entitlement/__support__/access-fixture";
import {
  auditsOf,
  expireLease,
  managedRegistrations,
  ProvisioningTestModule,
  requestsOf,
  resetProvisioning,
  restrictTenantA,
  seedHeartbeat,
  stepsOf,
  SYSTEM_ACTOR,
} from "./__support__/provisioning-fixture";

const h = scopedHttpHarness({
  label: "RT-1358 provisioning",
  contractId: "provisioning-feed",
  module: ProvisioningTestModule,
  seed: seedAccessFixture,
  providers: idempotencyProviders(),
  // The production global guard (FailClosedAuthGuard) on the provisioning feed: it must stay reachable behind
  // it (@Public + its own guard). Other routes keep the harness's header session.
  beforeInit: (app) => {
    const real = new FailClosedAuthGuard(app.get(Reflector), app.get(AuthGuard, { strict: false }));
    app.useGlobalGuards({
      canActivate: (ctx) => (String(ctx.switchToHttp().getRequest<{ originalUrl?: string }>().originalUrl).startsWith("/api/connector/v1/erpnext/provisioning") ? real.canActivate(ctx) : true),
    });
  },
});

const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";
const unlockPath = (t: string): string => `/api/v1/platform/tenants/${t}/access-entitlement/unlock-request`;
const markPath = (t: string): string => `/api/v1/platform/tenants/${t}/access-entitlement/mark-provisioned`;
const FEED = "/api/connector/v1/erpnext/provisioning/requests";
const CREDS = "/api/v1/platform/erp-provisioner-credentials";

const bearer = (req: request.Test, token: string): request.Test => req.set("Authorization", `Bearer ${token}`);
let keyN = 0;
const key = (): string => `rt1358-key-${Date.now()}-${++keyN}-pad`;

async function issueProvisioner(host = "lab-03"): Promise<string> {
  const res = await h.post(CREDS, SES_PLATFORM, { hostLabel: host }).expect(201);
  h.conforms("IssuedProvisionerCredential", res.body);
  return (res.body as { secret: string }).secret;
}

async function unlockA(): Promise<string> {
  await restrictTenantA(h.env().admin);
  await h.post(unlockPath(TENANT_A), SES_PLATFORM, {}).expect(200);
  return (await requestsOf(h.env().admin))[0]!["id"] as string;
}

const ack = (tok: string, id: string, step: string, attempt: number, extra: object = {}): request.Test =>
  bearer(h.post(`${FEED}/${id}/steps`, null, { step, outcome: "done", attempt, ...extra }), tok).set("Idempotency-Key", `${id}:${step}:${attempt}`);

async function toVerifying(tok: string, id: string): Promise<void> {
  await ack(tok, id, "claimed", 1).expect(200);
  await ack(tok, id, "site_created", 2).expect(200);
  await ack(tok, id, "erp_configured", 3).expect(200);
  await ack(tok, id, "connector_installed", 4).expect(200);
  await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
  await ack(tok, id, "credential_bound", 5).expect(200);
  await ack(tok, id, "verified", 6).expect(200);
}

const outcome = (tok: string, id: string, body: object): request.Test =>
  bearer(h.post(`${FEED}/${id}/outcome`, null, body), tok).set("Idempotency-Key", key());

function succeededBody(siteName: string, stores: object[] = []): object {
  return { outcome: "succeeded", result: { siteName, companyRef: "Example Co", templateVersion: 1, fiscalReadiness: "not_assessed", stores } };
}

beforeEach(async () => {
  if (h.skipped()) return;
  await resetProvisioning(h.env().admin);
});

describe("unlock trigger (adapts RT-1353)", () => {
  it("creates exactly one request and one managed registration; a double submit creates no second", async () => {
    if (h.skipped()) return;
    await restrictTenantA(h.env().admin);
    await h.post(unlockPath(TENANT_A), SES_PLATFORM, {}).expect(200);
    await h.post(unlockPath(TENANT_A), SES_PLATFORM, {}).expect(200);
    const requests = await requestsOf(h.env().admin);
    const regs = await managedRegistrations(h.env().admin);
    expect(requests).toHaveLength(1);
    expect(regs).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "tenant.provision", status: "requested", generation: 1, template_id: "egypt-retail", template_version: 1 });
    expect(requests[0]!["site_name"]).toMatch(/^t[0-9a-f]{20}-dev$/);
    expect(regs[0]).toMatchObject({ managed_by: "provisioner", environment: "dev", erpnext_site_ref: requests[0]!["site_name"], created_by: SYSTEM_ACTOR });
    expect(requests[0]!["connector_registration_id"]).toBe(regs[0]!["id"]);
    expect(await auditsOf(h.env().admin, "erp.provisioning.requested")).toHaveLength(1);
  });

  it("fails closed with 503 and writes nothing when DEPLOYMENT_ENVIRONMENT is unset", async () => {
    if (h.skipped()) return;
    await restrictTenantA(h.env().admin);
    const saved = process.env["DEPLOYMENT_ENVIRONMENT"];
    delete process.env["DEPLOYMENT_ENVIRONMENT"];
    try {
      await h.post(unlockPath(TENANT_A), SES_PLATFORM, {}).expect(503);
    } finally {
      process.env["DEPLOYMENT_ENVIRONMENT"] = saved;
    }
    expect(await requestsOf(h.env().admin)).toHaveLength(0);
    const row = await h.env().admin.query(`SELECT unlock_requested_at FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    expect(row.rows[0].unlock_requested_at).toBeNull();
  });
});

describe("platform-admin provisioner credential routes", () => {
  it("issues once (no-store), refuses a second live one with 409, rotates, and revokes with alreadyRevoked", async () => {
    if (h.skipped()) return;
    const first = await h.post(CREDS, SES_PLATFORM, { hostLabel: "lab-03" }).expect(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    h.conforms("IssuedProvisionerCredential", first.body);
    const exp = new Date((first.body as { expiresAt: string }).expiresAt).getTime();
    expect(exp - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 5000);
    await h.post(CREDS, SES_PLATFORM, { hostLabel: "lab-03" }).expect(409);

    const rotated = await h.post(`${CREDS}/lab-03/rotate`, SES_PLATFORM, {}).expect(201);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expect((rotated.body as { secret: string }).secret).not.toBe((first.body as { secret: string }).secret);
    // the old secret no longer authenticates, the new one does
    await bearer(h.get(FEED, null), (first.body as { secret: string }).secret).expect(401);
    await bearer(h.get(FEED, null), (rotated.body as { secret: string }).secret).expect(200);

    const revoked = await h.post(`${CREDS}/lab-03/revoke`, SES_PLATFORM, {}).expect(200);
    h.conforms("RevokedProvisionerCredential", revoked.body);
    expect(revoked.body.alreadyRevoked).toBe(false);
    const again = await h.post(`${CREDS}/lab-03/revoke`, SES_PLATFORM, {}).expect(200);
    expect(again.body.alreadyRevoked).toBe(true);
    await h.post(`${CREDS}/never-had/revoke`, SES_PLATFORM, {}).expect(404);
    await h.post(`${CREDS}/lab-03/rotate`, SES_PLATFORM, {}).expect(404);
    await bearer(h.get(FEED, null), (rotated.body as { secret: string }).secret).expect(401);
    for (const action of ["issued", "rotated", "revoked", "revoke_noop"]) {
      expect((await auditsOf(h.env().admin, `erp.provisioner_credential.${action}`)).length).toBeGreaterThan(0);
    }
  });

  it("note 3: an expired but unrevoked credential does not block a new issue, which revokes it in the same transaction", async () => {
    if (h.skipped()) return;
    await issueProvisioner("lab-04");
    await h.env().admin.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 day' WHERE id = (SELECT token_id FROM erp_provisioner_credential WHERE host_label = 'lab-04')`,
    );
    await h.post(`${CREDS}/lab-04/rotate`, SES_PLATFORM, {}).expect(404);
    const reissued = await h.post(CREDS, SES_PLATFORM, { hostLabel: "lab-04" }).expect(201);
    expect(reissued.body.hostLabel).toBe("lab-04");
    const rows = await h.env().admin.query(`SELECT revoked_at FROM erp_provisioner_credential WHERE host_label = 'lab-04' ORDER BY created_at`);
    expect(rows.rows.map((r: { revoked_at: Date | null }) => r.revoked_at !== null)).toEqual([true, false]);
    expect(await auditsOf(h.env().admin, "erp.provisioner_credential.expired_revoked")).toHaveLength(1);
  });

  it("is session-only and platform-admin-only; the secret is in no audit row", async () => {
    if (h.skipped()) return;
    await h.post(CREDS, null, { hostLabel: "lab-03" }).expect(401);
    await h.post(CREDS, SES_OWNER_ALL, { hostLabel: "lab-03" }).expect(403);
    await h.post(CREDS, SES_PLATFORM, { hostLabel: "Bad Label" }).expect(400);
    await h.post(CREDS, SES_PLATFORM, { hostLabel: "lab-03", extra: 1 }).expect(400);
    const secret = await issueProvisioner("lab-05");
    const all = await h.env().admin.query(`SELECT metadata::text AS m, target_id::text AS t FROM audit_events`);
    expect(JSON.stringify(all.rows)).not.toContain(secret);
  });
});

describe("feed authentication (connectorProvisionerBearer only)", () => {
  it("accepts only the provisioner bearer; tenant, cookie and revoked credentials get the generic 401", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    await bearer(h.get(FEED, null), tok).expect(200);
    await h.get(FEED, null).expect(401);
    await h.get(FEED, SES_PLATFORM).expect(401);
    await bearer(h.get(FEED, null), "not-a-token").expect(401);
    // a tenant connector credential is refused on the provisioning feed
    await restrictTenantA(h.env().admin);
    const reg = await h.post("/api/v1/connector/instances", SES_OWNER_ALL, { display_name: "x", erpnext_site_ref: "manual-site", environment: "dev" }).expect(201);
    const cred = await h.post(`/api/v1/connector/instances/${reg.body.id}/credentials`, SES_OWNER_ALL, {}).expect(201);
    await bearer(h.get(FEED, null), cred.body.secret).expect(401);
  });

  it("the provisioner token is refused by every other guard (connector feed, session routes)", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    await bearer(h.get("/api/connector/v1/erpnext/postings", null), tok).expect(401);
    await bearer(h.get("/api/v1/connector/instances", null), tok).expect(401);
    await bearer(h.post(CREDS, null, { hostLabel: "lab-09" }), tok).expect(401);
  });

  it("an environment mismatch is the generic 403", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    await h.env().admin.query(`UPDATE erp_provisioner_credential SET environment = 'prod'`);
    const res = await bearer(h.get(FEED, null), tok).expect(403);
    expect(JSON.stringify(res.body)).not.toMatch(/prod|dev/);
  });
});

describe("pull and step acknowledgement", () => {
  it("pull returns requested requests oldest first with the contract shape; a claimed one is not offered", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    const page = await bearer(h.get(FEED, null), tok).expect(200);
    h.conforms("ProvisioningRequestPage", page.body);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ provisioningRequestId: id, kind: "tenant.provision", tenantId: TENANT_A, generation: 1, environment: "dev", attemptFloor: 0, template: { templateId: "egypt-retail", templateVersion: 1 }, locale: { country: "EG", currency: "EGP", timezone: "Africa/Cairo", language: "ar" } });
    expect(page.body.items[0].stores.length).toBeGreaterThan(0);
    await ack(tok, id, "claimed", 1).expect(200);
    expect((await bearer(h.get(FEED, null), tok).expect(200)).body.items).toHaveLength(0);
    // a bad cursor is a 400 and the first page again is safe
    await bearer(h.get(FEED, null).query({ cursor: "garbage" }), tok).expect(400);
  });

  it("caps the pull item's legal name at 140 and a store display name at 135 (an ERPNext Company name is 140; the provisioner adds ' - RT')", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const tok = await issueProvisioner();
    await unlockA();
    const before = await admin.query(`SELECT name FROM tenants WHERE id = $1`, [TENANT_A]);
    const stores = await admin.query(`SELECT id, name FROM stores WHERE tenant_id = $1`, [TENANT_A]);
    await admin.query(`UPDATE tenants SET name = $2 WHERE id = $1`, [TENANT_A, "N".repeat(200)]);
    await admin.query(`UPDATE stores SET name = $2 WHERE tenant_id = $1`, [TENANT_A, "S".repeat(200)]);
    try {
      const page = await bearer(h.get(FEED, null), tok).expect(200);
      h.conforms("ProvisioningRequestPage", page.body);
      expect(page.body.items[0].legalName).toHaveLength(140);
      for (const st of page.body.items[0].stores) expect(st.displayName).toHaveLength(135);
    } finally {
      await admin.query(`UPDATE tenants SET name = $2 WHERE id = $1`, [TENANT_A, before.rows[0].name]);
      for (const st of stores.rows) await admin.query(`UPDATE stores SET name = $2 WHERE id = $1`, [st.id, st.name]);
    }
  });

  it("claim takes a lease, a replay is idempotent, a lost lease is 409, another provisioner is never disclosed", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    const first = await ack(tok, id, "claimed", 1).expect(200);
    h.conforms("StepAckResult", first.body);
    const replay = await ack(tok, id, "claimed", 1).expect(200);
    expect(replay.body.leaseExpiresAt).toBe(first.body.leaseExpiresAt);
    const exp = new Date(first.body.leaseExpiresAt).getTime() - Date.now();
    expect(exp).toBeGreaterThan(14 * 60_000);
    await ack(other, id, "claimed", 1).expect(409);
    await ack(other, id, "site_created", 2).expect(409);
    // same key, different outcome
    await bearer(h.post(`${FEED}/${id}/steps`, null, { step: "claimed", outcome: "conflict", attempt: 1, errorClass: "conflict" }), tok).set("Idempotency-Key", `${id}:claimed:1`).expect(409);
    await ack(tok, id, "site_created", 2).expect(200);
    expect((await stepsOf(h.env().admin, id)).map((s) => s["step"])).toEqual(["claimed", "site_created"]);
    // an attempt at or below the floor with no matching row
    await ack(tok, id, "erp_configured", 2).expect(409);
  });

  it("an expired lease is re-offered and the next provisioner takes over keeping the progress", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2).expect(200);
    await expireLease(h.env().admin, id);
    const page = await bearer(h.get(FEED, null), other).expect(200);
    expect(page.body.items[0]).toMatchObject({ provisioningRequestId: id, attemptFloor: 2 });
    await ack(other, id, "claimed", 3).expect(200);
    expect((await requestsOf(h.env().admin))[0]!["status"]).toBe("site_created");
    await ack(tok, id, "erp_configured", 4).expect(409);
  });

  it("failed_transient backs off and is not offered early; capacity holds without failing", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2, { outcome: "failed_transient", errorClass: "failed_transient", detail: "db down" }).expect(200);
    let row = (await requestsOf(h.env().admin))[0]!;
    expect(row["status"]).toBe("failed_retryable");
    expect(row["lease_id"]).toBeNull();
    expect((await bearer(h.get(FEED, null), tok).expect(200)).body.items).toHaveLength(0);
    await h.env().admin.query(`UPDATE erp_provisioning_request SET not_before = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await bearer(h.get(FEED, null), tok).expect(200)).body.items).toHaveLength(1);
    await ack(tok, id, "claimed", 3).expect(200);
    await ack(tok, id, "site_created", 4, { outcome: "capacity", errorClass: "capacity" }).expect(200);
    row = (await requestsOf(h.env().admin))[0]!;
    expect(row["status"]).toBe("failed_retryable");
    expect(row["last_error_class"]).toBe("capacity");
    expect(new Date(row["not_before"] as string).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("the site ceiling withholds new tenant.provision at 20 sites for the host", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    await unlockA();
    await h.env().admin.query(
      `INSERT INTO erp_provisioning_request (id, tenant_id, kind, status, site_name, template_id, template_version, provisioned_host_label, terminal_at, attempt_floor)
       SELECT gen_random_uuid(), $1, 'tenant.provision', 'succeeded', 'old-' || g, 'egypt-retail', 1, 'lab-03', now(), 1 FROM generate_series(1, 20) g`,
      [TENANT_B],
    );
    expect((await bearer(h.get(FEED, null), tok).expect(200)).body.items).toHaveLength(0);
    await h.env().admin.query(`DELETE FROM erp_provisioning_request WHERE tenant_id = $1 AND status = 'succeeded'`, [TENANT_B]).catch(() => undefined);
  });
});

describe("credential issue (the most powerful call)", () => {
  it("refuses without a live lease, for another provisioner, for an unknown request and in a state that does not allow it: the same 404", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    const credPath = `${FEED}/${id}/credential`;
    const probe = async (t: string, path = credPath): Promise<string> => {
      const body = (await bearer(h.post(path, null, {}), t).expect(404)).body as { error: { code: string; message: string } };
      return JSON.stringify({ code: body.error.code, message: body.error.message });
    };
    const noLease = await probe(tok);
    await ack(tok, id, "claimed", 1).expect(200);
    const claimedState = await probe(tok); // status `claimed` does not allow issue
    await ack(tok, id, "site_created", 2).expect(200);
    const otherLease = await probe(other);
    const unknown = await probe(tok, `${FEED}/0a000000-0000-7000-8000-0000000000ff/credential`);
    expect(new Set([noLease, claimedState, otherLease, unknown]).size).toBe(1);
    expect(await auditsOf(h.env().admin, "erp.provisioning.credential_issued")).toHaveLength(0);
    await expireLease(h.env().admin, id);
    await probe(tok);
  });

  it("refuses a non-managed registration with the same 404", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2).expect(200);
    await h.env().admin.query(`UPDATE connector_registration SET managed_by = NULL WHERE id = (SELECT connector_registration_id FROM erp_provisioning_request WHERE id = $1)`, [id]);
    await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(404);
  });

  it("issues once, no-store, audited with the request id; the secret is in no log, audit row or idempotency store", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2).expect(200);
    const res = await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    h.conforms("IssuedProvisionedCredential", res.body);
    expect(res.body.rotated).toBe(false);
    const expiresInDays = (new Date(res.body.expiresAt).getTime() - new Date(res.body.issuedAt).getTime()) / 86_400_000;
    expect(Math.round(expiresInDays)).toBe(365);
    const audits = await auditsOf(h.env().admin, "erp.provisioning.credential_issued");
    expect(audits).toHaveLength(1);
    expect(audits[0]!["metadata"]).toMatchObject({ provisioning_request_id: id, credential_id: res.body.credentialId, rotated: false });
    expect(audits[0]!["actor_user_id"]).toBe(SYSTEM_ACTOR);
    const dump = await h.env().admin.query(
      `SELECT (SELECT coalesce(string_agg(metadata::text, ' '), '') FROM audit_events) || (SELECT coalesce(string_agg(t::text, ' '), '') FROM idempotency_keys t) AS blob`,
    ).catch(() => ({ rows: [{ blob: "" }] }));
    expect(String(dump.rows[0].blob)).not.toContain(res.body.secret);
    const stored = await h.env().admin.query(`SELECT token_hash FROM auth_tokens WHERE id = $1`, [res.body.credentialId]);
    expect(stored.rows[0].token_hash).not.toBe(res.body.secret);
  });

  it("lost-response test: a repeat for a never-presented credential rotates it; after a heartbeat it is refused", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2).expect(200);
    const first = await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
    const repeat = await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
    expect(repeat.body.rotated).toBe(true);
    expect(repeat.body.secret).not.toBe(first.body.secret);
    const live = await h.env().admin.query(`SELECT id FROM auth_tokens WHERE connector_registration_id = $1 AND scope = 'connector' AND revoked_at IS NULL`, [repeat.body.registrationId]);
    expect(live.rows.map((r: { id: string }) => r.id)).toEqual([repeat.body.credentialId]);
    await seedHeartbeat(h.env().admin, TENANT_A, repeat.body.registrationId);
    await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(404);
  });
});

describe("outcome", () => {
  it("credential_bound needs an issued credential; verified needs credential_bound (400)", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await ack(tok, id, "site_created", 2).expect(200);
    await ack(tok, id, "credential_bound", 3).expect(400);
    await ack(tok, id, "verified", 3).expect(400);
  });

  it("succeeded holds for the first heartbeat, is idempotent, and does NOT change the entitlement", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await toVerifying(tok, id);
    const siteName = (await requestsOf(h.env().admin))[0]!["site_name"] as string;
    await outcome(tok, id, succeededBody(siteName, [{ storeId: "0a000000-0000-7000-8000-00000000a5a1", warehouseRef: "Main - RT", customerRef: "Retail Walk-in" }])).expect(200);
    let row = (await requestsOf(h.env().admin))[0]!;
    // derived "outcome reported" state: verifying with NO lease, the host kept in the audit trail only
    expect(row).toMatchObject({ status: "verifying", lease_id: null, lease_holder: null, lease_expires_at: null });
    const repeat = await outcome(tok, id, succeededBody(siteName, [])).expect(200);
    expect(repeat.headers["idempotent-replayed"]).toBe("true");
    // not offered again while it waits
    expect((await bearer(h.get(FEED, null), tok).expect(200)).body.items).toHaveLength(0);
    const ent = await h.env().admin.query(`SELECT state, provisioned_at FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    expect(ent.rows[0]).toMatchObject({ state: "restricted", provisioned_at: null });
    row = (await requestsOf(h.env().admin))[0]!;
    expect(row["terminal_at"]).toBeNull();
  });

  it("(b) a crash after the verified ack and before the outcome: re-offered once the lease expires, to the next provisioner, once", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    await toVerifying(tok, id);
    expect((await bearer(h.get(FEED, null), other).expect(200)).body.items).toHaveLength(0); // lease still live
    await expireLease(h.env().admin, id);
    const page = await bearer(h.get(FEED, null), other).expect(200);
    expect(page.body.items.map((i: { provisioningRequestId: string }) => i.provisioningRequestId)).toEqual([id]);
    await ack(other, id, "claimed", 7).expect(200);
    expect((await bearer(h.get(FEED, null), other).expect(200)).body.items).toHaveLength(0);
    expect((await requestsOf(h.env().admin))[0]!["status"]).toBe("verifying"); // progress kept
  });

  it("another provisioner cannot replay a step of someone else's lease, a repeat outcome from another host is refused", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner("lab-03");
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await expireLease(h.env().admin, id);
    await bearer(h.post(`${FEED}/${id}/steps`, null, { step: "claimed", outcome: "done", attempt: 1 }), other).set("Idempotency-Key", key()).expect(409);
    await ack(tok, id, "claimed", 2).expect(200);
    await ack(tok, id, "site_created", 3).expect(200);
    await ack(tok, id, "erp_configured", 4).expect(200);
    await ack(tok, id, "connector_installed", 5).expect(200);
    await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
    await ack(tok, id, "credential_bound", 6).expect(200);
    await ack(tok, id, "verified", 7).expect(200);
    const site = (await requestsOf(h.env().admin))[0]!["site_name"] as string;
    await outcome(tok, id, succeededBody(site)).expect(200);
    await outcome(other, id, succeededBody(site)).expect(409);
    await outcome(tok, id, succeededBody(site)).expect(200);
  });

  it("refuses an absurd attempt number and a malformed cursor with 400", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 2_147_483_000).expect(400);
    const forged = Buffer.from(JSON.stringify({ t: "2026-01-01T00:00:00.000Z", i: "-".repeat(36) }), "utf8").toString("base64url");
    await bearer(h.get(FEED, null).query({ cursor: forged }), tok).expect(400);
    const far = Buffer.from(JSON.stringify({ t: "+275760-09-13T00:00:00.000Z", i: id }), "utf8").toString("base64url");
    await bearer(h.get(FEED, null).query({ cursor: far }), tok).expect(400);
  });

  it("succeeded with the heartbeat already seen finishes at once and still leaves the entitlement restricted", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await toVerifying(tok, id);
    const row = (await requestsOf(h.env().admin))[0]!;
    await seedHeartbeat(h.env().admin, TENANT_A, row["connector_registration_id"] as string);
    await outcome(tok, id, succeededBody(row["site_name"] as string)).expect(200);
    expect((await requestsOf(h.env().admin))[0]).toMatchObject({ status: "succeeded" });
    expect(await auditsOf(h.env().admin, "erp.provisioning.succeeded")).toHaveLength(1);
    const ent = await h.env().admin.query(`SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    expect(ent.rows[0].state).toBe("restricted");
    // the platform admin flips it by hand, as before
    await h.post(markPath(TENANT_A), SES_PLATFORM, {}).expect(200);
  });

  it("a mismatching result, a foreign store, a missing lease and an early succeeded are refused", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await outcome(tok, id, succeededBody("x")).expect(400); // not verifying yet
    await ack(tok, id, "site_created", 2).expect(200);
    await ack(tok, id, "erp_configured", 3).expect(200);
    await ack(tok, id, "connector_installed", 4).expect(200);
    await bearer(h.post(`${FEED}/${id}/credential`, null, {}), tok).expect(201);
    await ack(tok, id, "credential_bound", 5).expect(200);
    await ack(tok, id, "verified", 6).expect(200);
    const siteName = (await requestsOf(h.env().admin))[0]!["site_name"] as string;
    await outcome(tok, id, succeededBody("another-site")).expect(400);
    await outcome(tok, id, succeededBody(siteName, [{ storeId: "0b000000-0000-7000-8000-00000000b5b1", warehouseRef: "W", customerRef: "C" }])).expect(400);
    await outcome(other, id, succeededBody(siteName)).expect(409);
    expect((await requestsOf(h.env().admin))[0]!["last_reason"]).toBeNull();
  });

  it("conflict fails the request permanently; a replay is idempotent; the lease is required", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const other = await issueProvisioner("lab-04");
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await outcome(other, id, { outcome: "conflict", reason: "marker" }).expect(409);
    await outcome(tok, id, { outcome: "conflict", reason: "marker" }).expect(200);
    // RT-1389: a terminal row keeps no lease; the replay key is the host in the `failed` audit row.
    expect((await requestsOf(h.env().admin))[0]).toMatchObject({ status: "failed_permanent", last_error_class: "conflict", lease_holder: null, lease_id: null, lease_expires_at: null });
    await outcome(tok, id, { outcome: "conflict", reason: "marker" }).expect(200);
    await outcome(other, id, { outcome: "conflict", reason: "marker" }).expect(409);
    await outcome(tok, id, { outcome: "succeeded" }).expect(400);
  });
});

describe("manual mark-provisioned (RT-1353) with a request", () => {
  it("is refused with 423 provisioning_in_progress while a lease is live", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    const res = await h.post(markPath(TENANT_A), SES_PLATFORM, {}).expect(423);
    expect(res.body.error.code).toBe("provisioning_in_progress");
    expect((await requestsOf(h.env().admin))[0]!["status"]).toBe("claimed");
  });

  it("is allowed with no live lease and cancels the open request in the same transaction", async () => {
    if (h.skipped()) return;
    const id = await unlockA();
    await h.post(markPath(TENANT_A), SES_PLATFORM, {}).expect(200);
    expect((await requestsOf(h.env().admin))[0]).toMatchObject({ id, status: "cancelled" });
    expect(await auditsOf(h.env().admin, "erp.provisioning.cancelled")).toHaveLength(1);
  });

  it("is allowed when the request is failed or absent", async () => {
    if (h.skipped()) return;
    const tok = await issueProvisioner();
    const id = await unlockA();
    await ack(tok, id, "claimed", 1).expect(200);
    await outcome(tok, id, { outcome: "permanently_rejected", reason: "bad" }).expect(200);
    await h.post(markPath(TENANT_A), SES_PLATFORM, {}).expect(200);
  });
});

describe("managed-registration guard", () => {
  it("owner and tenant admin cannot issue, rotate, revoke or disable a managed registration; a platform admin can; isolation holds", async () => {
    if (h.skipped()) return;
    await unlockA();
    const reg = (await managedRegistrations(h.env().admin))[0]!;
    const regId = reg["id"] as string;
    const base = `/api/v1/connector/instances/${regId}`;
    await h.post(`${base}/credentials`, SES_OWNER_ALL, {}).expect(404);
    await h.post(`${base}/credentials/rotate`, SES_OWNER_ALL, {}).set("Idempotency-Key", key()).expect(404);
    await h.post(`${base}/disable`, SES_OWNER_ALL, {}).expect(404);
    const live = await h.env().admin.query(`SELECT count(*)::int AS n FROM auth_tokens WHERE connector_registration_id = $1`, [regId]);
    expect(live.rows[0].n).toBe(0);
    // another tenant's session sees nothing at all
    await h.post(`${base}/credentials`, SES_PLATFORM, {}).expect(404);
    expect((await managedRegistrations(h.env().admin, TENANT_B))).toHaveLength(0);
    // a platform admin who is a member of the tenant can: the owner of tenant A, made a platform admin
    await h.env().admin.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [USER_OWNER_ALL]);
    try {
      const issued = await h.post(`${base}/credentials`, SES_OWNER_ALL, {}).expect(201);
      expect(issued.body.instance_id).toBe(regId);
      await h.post(`${base}/disable`, SES_OWNER_ALL, {}).expect(200);
    } finally {
      await h.env().admin.query(`UPDATE users SET is_platform_admin = false WHERE id = $1`, [USER_OWNER_ALL]);
    }
  });

  it("a non-managed registration keeps working for the owner", async () => {
    if (h.skipped()) return;
    const created = await h.post("/api/v1/connector/instances", SES_OWNER_ALL, { display_name: "hand", erpnext_site_ref: "hand-made-site", environment: "dev" }).expect(201);
    await h.post(`/api/v1/connector/instances/${created.body.id}/credentials`, SES_OWNER_ALL, {}).expect(201);
  });
});
