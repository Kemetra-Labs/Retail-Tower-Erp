/**
 * RT-1358 — note 1 of the #569 review, proven against real Postgres: the
 * `app.is_provisioner` setting is enforced by code, never together with
 * `app.is_platform_admin`, and a provisioner session cannot write the tenant
 * access state or read the credential store (0109 policies).
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";

import { runAsProvisioner } from "../../src/erp-provisioning/provisioner-context";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { TENANT_A } from "../catalog/__support__/isolation-harness";
import { seedReadStoreScope } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";

let env: PgTestEnv | null = null;
let skipped = false;

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

describe("runAsProvisioner", () => {
  it("sets the provisioner setting and always sets platform admin to false", async () => {
    if (skipped) return;
    const seen = await runAsProvisioner(env!.app, async (client) => {
      const r = await client.query(`SELECT current_setting('app.is_provisioner', true) AS prov, current_setting('app.is_platform_admin', true) AS admin`);
      return r.rows[0];
    });
    expect(seen).toEqual({ prov: "true", admin: "false" });
  });

  it("the setting does not leak to the next use of the pool", async () => {
    if (skipped) return;
    await runAsProvisioner(env!.app, async () => undefined);
    const r = await env!.app.query(`SELECT coalesce(current_setting('app.is_provisioner', true), '') AS prov`);
    expect(r.rows[0].prov).toBe("");
  });

  it("the platform-admin context (verifier, credential routes) never carries the provisioner setting", async () => {
    if (skipped) return;
    const seen = await runWithTenantContext(env!.app, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const r = await client.query(`SELECT coalesce(current_setting('app.is_provisioner', true), '') AS prov, current_setting('app.is_platform_admin', true) AS admin`);
      return r.rows[0];
    });
    expect(seen).toEqual({ prov: "", admin: "true" });
  });

  it("a provisioner session cannot change the tenant access state", async () => {
    if (skipped) return;
    await env!.admin.query(`INSERT INTO tenant_access_entitlements (tenant_id, state) VALUES ($1, 'restricted') ON CONFLICT DO NOTHING`, [TENANT_A]);
    try {
      const updated = await runAsProvisioner(env!.app, async (client) => {
        const r = await client.query(`UPDATE tenant_access_entitlements SET state = 'unrestricted' WHERE tenant_id = $1`, [TENANT_A]);
        return r.rowCount;
      });
      expect(updated).toBe(0);
      await expect(
        runAsProvisioner(env!.app, async (client) => {
          await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
          await client.query(`UPDATE tenant_access_entitlements SET state = 'unrestricted' WHERE tenant_id = $1`, [TENANT_A]);
          const after = await client.query(`SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
          if (after.rows[0].state === "unrestricted") throw new Error("flipped");
        }),
      ).resolves.toBeUndefined();
      const row = await env!.admin.query(`SELECT state FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
      expect(row.rows[0].state).toBe("restricted");
    } finally {
      await env!.admin.query(`DELETE FROM tenant_access_entitlements WHERE tenant_id = $1`, [TENANT_A]);
    }
  });

  it("a provisioner session cannot read the credential store or create a request", async () => {
    if (skipped) return;
    const seen = await runAsProvisioner(env!.app, async (client) => {
      const r = await client.query(`SELECT count(*)::int AS n FROM erp_provisioner_credential`);
      return r.rows[0].n;
    });
    expect(seen).toBe(0);
    await expect(
      runAsProvisioner(env!.app, async (client) => {
        await client.query(
          `INSERT INTO erp_provisioning_request (tenant_id, kind, site_name, template_id, template_version) VALUES ($1, 'tenant.provision', 'x', 'egypt-retail', 1)`,
          [TENANT_A],
        );
      }),
    ).rejects.toThrow();
  });
});
