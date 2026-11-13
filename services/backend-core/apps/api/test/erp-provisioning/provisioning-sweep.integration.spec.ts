/**
 * RT-1358 — the worker sweep (`sweepErpProvisioning`) against real Postgres on the
 * NOBYPASSRLS pool: lease reclaim (status kept, audited, offered again) and the
 * first-heartbeat hold (succeeded on a heartbeat, failed with an alert on timeout).
 * It never touches the tenant access state.
 */
import "reflect-metadata";

import { sweepErpProvisioning } from "@data-pulse-2/db";

import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import { resetProvisioning, seedHeartbeat } from "./__support__/provisioning-fixture";

let env: PgTestEnv | null = null;
let skipped = false;
const HOUR = 3_600_000;
let siteN = 0;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReadStoreScope(env);
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${String(err)}`);
    skipped = true;
  }
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (skipped) return;
  await resetProvisioning(env!.admin);
});

async function seedRequest(over: { status: string; lease?: "expired" | "live" | "none"; reason?: string | null; tenant?: string }): Promise<{ id: string; registrationId: string }> {
  const admin = env!.admin;
  const site = `tdeadbeefdeadbeef${String(++siteN).padStart(4, "0")}-dev`;
  const reg = await admin.query<{ id: string }>(
    `INSERT INTO connector_registration (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, managed_by)
     VALUES (gen_random_uuid(), $1, 'm', $2, 'dev', '00000000-0000-7000-8000-000000001357', 'provisioner') RETURNING id`,
    [over.tenant ?? TENANT_A, site],
  );
  const leased = over.lease === "expired" || over.lease === "live";
  const expires = over.lease === "live" ? `now() + interval '10 minutes'` : `now() - interval '1 minute'`;
  const r = await admin.query<{ id: string }>(
    `INSERT INTO erp_provisioning_request
       (id, tenant_id, kind, status, site_name, template_id, template_version, connector_registration_id, lease_holder, lease_id, lease_expires_at, last_reason, attempt_floor)
     VALUES (gen_random_uuid(), $1, 'tenant.provision', $2, '${site}', 'egypt-retail', 1, $3,
             ${leased ? "'lab-03'" : "NULL"}, ${leased ? "gen_random_uuid()" : "NULL"}, ${leased ? expires : "NULL"}, $4, 1)
     RETURNING id`,
    [over.tenant ?? TENANT_A, over.status, reg.rows[0]!.id, over.reason ?? null],
  );
  return { id: r.rows[0]!.id, registrationId: reg.rows[0]!.id };
}

const row = async (id: string): Promise<Record<string, unknown>> => (await env!.admin.query(`SELECT * FROM erp_provisioning_request WHERE id = $1`, [id])).rows[0];

describe("sweepErpProvisioning", () => {
  it("reclaims an expired lease: lease cleared, status kept, audited once, offered again; a live lease is left alone", async () => {
    if (skipped) return;
    const stale = await seedRequest({ status: "erp_configured", lease: "expired" });
    const live = await seedRequest({ status: "site_created", lease: "live", tenant: TENANT_B });
    const first = await sweepErpProvisioning(env!.app, { now: new Date(), heartbeatTimeoutMs: HOUR });
    expect(first).toEqual({ leasesReclaimed: 1, succeeded: 0, timedOut: 0 });
    expect(await row(stale.id)).toMatchObject({ status: "erp_configured", lease_id: null, lease_holder: null, lease_expires_at: null });
    expect((await row(live.id))["lease_id"]).not.toBeNull();
    const again = await sweepErpProvisioning(env!.app, { now: new Date(), heartbeatTimeoutMs: HOUR });
    expect(again.leasesReclaimed).toBe(0);
    const audits = await env!.admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'erp.provisioning.lease_expired' AND target_id = $1`, [stale.id]);
    expect(audits.rows[0].n).toBe(1);
  });

  /** A request whose provisioner reported `succeeded`: `verifying`, NO lease; the host is in the audit trail. */
  async function seedReported(tenant?: string): Promise<{ id: string; registrationId: string }> {
    const r = await seedRequest({ status: "verifying", lease: "none", ...(tenant ? { tenant } : {}) });
    await env!.admin.query(
      `INSERT INTO audit_events (id, actor_user_id, actor_label, tenant_id, action, target_type, target_id, metadata)
       VALUES (gen_random_uuid(), '00000000-0000-7000-8000-000000001357', 'provisioner:lab-03', $1, 'erp.provisioning.step_recorded', 'erp_provisioning_request', $2, '{"outcome":"succeeded_reported","host":"lab-03"}'::jsonb)`,
      [tenant ?? TENANT_A, r.id],
    );
    return r;
  }

  it("never reclaims a verifying request: an expired lease there is a crash before the outcome and stays as it is", async () => {
    if (skipped) return;
    const crashed = await seedRequest({ status: "verifying", lease: "expired" });
    const res = await sweepErpProvisioning(env!.app, { now: new Date(), heartbeatTimeoutMs: HOUR });
    expect(res).toEqual({ leasesReclaimed: 0, succeeded: 0, timedOut: 0 });
    expect(await row(crashed.id)).toMatchObject({ status: "verifying", lease_holder: "lab-03" });
    expect((await row(crashed.id))["lease_id"]).not.toBeNull();
  });

  it("a reported request waits for the heartbeat untouched, and is never offered again", async () => {
    if (skipped) return;
    const r = await seedReported();
    const res = await sweepErpProvisioning(env!.app, { now: new Date(), heartbeatTimeoutMs: HOUR });
    expect(res).toEqual({ leasesReclaimed: 0, succeeded: 0, timedOut: 0 });
    expect(await row(r.id)).toMatchObject({ status: "verifying", lease_id: null, lease_holder: null });
  });

  it("finishes a reported request once the first heartbeat arrived, records the host, and leaves the entitlement alone", async () => {
    if (skipped) return;
    await env!.admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted')`, [TENANT_A]);
    const r = await seedReported();
    await seedHeartbeat(env!.admin, TENANT_A, r.registrationId);
    const res = await sweepErpProvisioning(env!.app, { now: new Date(), heartbeatTimeoutMs: HOUR });
    expect(res.succeeded).toBe(1);
    const after = await row(r.id);
    expect(after).toMatchObject({ status: "succeeded", last_reason: null, lease_holder: "lab-03" });
    expect(after["terminal_at"]).not.toBeNull();
    const ent = await env!.admin.query(`SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    expect(ent.rows[0].state).toBe("restricted");
  });

  it("(c) fails a reported request with an alert after the heartbeat timeout, and not before", async () => {
    if (skipped) return;
    const r = await seedReported();
    const early = await seedReported(TENANT_B);
    const soon = await sweepErpProvisioning(env!.app, { now: new Date(Date.now() + 5 * 60_000), heartbeatTimeoutMs: HOUR });
    expect(soon.timedOut).toBe(0);
    const res = await sweepErpProvisioning(env!.app, { now: new Date(Date.now() + 2 * HOUR), heartbeatTimeoutMs: HOUR });
    expect(res.timedOut).toBe(2);
    expect(await row(r.id)).toMatchObject({ status: "failed_permanent", last_reason: "first heartbeat not seen in time" });
    expect((await row(early.id))["status"]).toBe("failed_permanent");
    const alert = await env!.admin.query(`SELECT metadata FROM audit_events WHERE action = 'erp.provisioning.failed' AND target_id = $1`, [r.id]);
    expect(alert.rows[0].metadata).toMatchObject({ alert: true });
  });
});
