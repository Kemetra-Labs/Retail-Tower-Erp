/**
 * RT-1389 Phase 2: `0112_erp_provisioning_transitions_host_label` and
 * `0113_erp_provisioning_host_label_backfill` migration test (owner go-ahead for the gated
 * migrations, 2026-11-14, RT-1389 comment 16972). Real PostgreSQL (Testcontainers):
 *   - `erp_provisioning_transition_allowed` agrees with `ERP_PROVISIONING_ALLOWED_TRANSITIONS`
 *     on every (from, to) pair (the SQL and TypeScript tables stay in lockstep);
 *   - NAMED: an illegal raw status change (claimed -> succeeded, succeeded -> requested) is
 *     rejected by the guard trigger (23514), also from the sweep privilege's session; a legal
 *     one and a same-status update pass;
 *   - `provisioned_host_label` is only on `succeeded` rows and never changes once set;
 *   - 0113 as a NOSUPERUSER owner under FORCE RLS (GUC pre-set to ''): the per-host count is the
 *     same before (lease_holder) and after (provisioned_host_label); a hostless succeeded row
 *     stays NULL; failed rows keep their ended lease; a re-run moves 0 rows;
 *   - 0113 down rebuilds the synthetic lease; 0112 down restores the old guard; both re-apply.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1
 * (CI MUST NOT set it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ERP_PROVISIONING_ALLOWED_TRANSITIONS, erpProvisioningTransitionAllowed } from "../../src/helpers/erp-provisioning-transitions";
import { ERP_PROVISIONING_STATUSES } from "../../src/schema/erp-provisioning";
import { applyMigrationsBefore, asApp, asMigrationOwner, errorCode } from "../_helpers/migration-spec";
import { ensureAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_0112 = "0112_erp_provisioning_transitions_host_label.sql";
const sql = (name: string): string => readFileSync(resolve(DRIZZLE_DIR, name), "utf8");

const id = (n: string): string => `11200000-0000-7000-8000-0000000${n}`;
const TENANTS = [id("0a001"), id("0b001"), id("0c001"), id("0d001"), id("0e001"), id("0f001")];
const T = "erp_provisioning_request";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;

const skip = (): boolean => dockerSkipReason !== null && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

/** A request row for `tenant`, written as the superuser (fixtures bypass RLS and the trigger only on UPDATE). */
async function seed(tenant: string, status: string, extra: { holder?: string | null; terminal?: boolean } = {}): Promise<string> {
  const leased = extra.holder !== undefined && extra.holder !== null;
  const r = await guard().admin.query<{ id: string }>(
    `INSERT INTO ${T} (tenant_id, kind, status, site_name, template_id, template_version, lease_holder, lease_id, lease_expires_at, terminal_at)
     VALUES ($1, 'tenant.provision', $2, 's-' || substr(gen_random_uuid()::text, 1, 8), 'egypt-retail', 1,
             $3::text, CASE WHEN $4 THEN gen_random_uuid() END, CASE WHEN $4 THEN now() END, CASE WHEN $5 THEN now() END)
     RETURNING id`,
    [tenant, status, extra.holder ?? null, leased, extra.terminal ?? false],
  );
  return r.rows[0]!.id;
}

const hostCounts = async (column: "lease_holder" | "provisioned_host_label"): Promise<Record<string, number>> => {
  const r = await guard().admin.query<{ host: string; n: number }>(
    `SELECT ${column} AS host, count(*)::int AS n FROM ${T}
      WHERE kind = 'tenant.provision' AND status = 'succeeded' AND ${column} IS NOT NULL GROUP BY 1`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.host, x.n]));
};

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyMigrationsBefore(env, DRIZZLE_DIR, UP_0112);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       SELECT t, 'tr-' || substr(t::text, 20, 5), 'TR', 'USD' FROM unnest($1::uuid[]) t`,
      [TENANTS],
    );
    await ensureAppRole(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0112-erp-provisioning-transitions-host-label.spec] Docker NOT AVAILABLE, skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("0113 backfill under FORCE RLS as the NOSUPERUSER owner", () => {
  it("moves each succeeded host from the synthetic lease to the label: same per-host count before and after; idempotent", async () => {
    if (skip()) return;
    const e = guard();
    // Old shape (before 0112): succeeded rows remember their host in an ended lease.
    const succeeded = [
      await seed(TENANTS[0]!, "succeeded", { holder: "lab-03", terminal: true }),
      await seed(TENANTS[1]!, "succeeded", { holder: "lab-03", terminal: true }),
      await seed(TENANTS[2]!, "succeeded", { holder: "lab-04", terminal: true }),
    ];
    const hostless = await seed(TENANTS[3]!, "succeeded", { terminal: true });
    const failed = await seed(TENANTS[4]!, "failed_permanent", { holder: "lab-03", terminal: true });
    const live = await seed(TENANTS[5]!, "claimed", { holder: "lab-04" });
    const before = await hostCounts("lease_holder");
    expect(before).toEqual({ "lab-03": 2, "lab-04": 1 });

    await e.admin.query(sql(UP_0112));
    await asMigrationOwner(
      e,
      {
        role: "mig_owner_0113",
        tables: [T],
        functions: [
          "erp_provisioning_request_guard()",
          "erp_provisioning_transition_allowed(text, text)",
          "erp_provisioning_backfill_host_labels()",
        ],
      },
      async () => {
        const client = await e.admin.connect();
        try {
          await client.query("SET ROLE mig_owner_0113");
          await client.query("SELECT set_config('app.current_tenant', '', false)");
          await client.query(sql("0113_erp_provisioning_host_label_backfill.sql"));
          const again = await client.query<{ n: number }>(`SELECT erp_provisioning_backfill_host_labels() AS n`);
          expect(again.rows[0]!.n).toBe(0);
        } finally {
          await client.query("RESET ROLE");
          await client.query("RESET app.current_tenant").catch(() => undefined);
          client.release();
        }
      },
    );

    expect(await hostCounts("provisioned_host_label")).toEqual(before);
    for (const rid of succeeded) {
      const r = await e.admin.query(`SELECT lease_holder, lease_id, lease_expires_at FROM ${T} WHERE id = $1`, [rid]);
      expect(r.rows[0]).toEqual({ lease_holder: null, lease_id: null, lease_expires_at: null });
    }
    const h = await e.admin.query(`SELECT provisioned_host_label FROM ${T} WHERE id = $1`, [hostless]);
    expect(h.rows[0].provisioned_host_label).toBeNull();
    const f = await e.admin.query(`SELECT lease_holder, provisioned_host_label FROM ${T} WHERE id = $1`, [failed]);
    expect(f.rows[0]).toEqual({ lease_holder: "lab-03", provisioned_host_label: null });
    const l = await e.admin.query(`SELECT lease_holder, provisioned_host_label FROM ${T} WHERE id = $1`, [live]);
    expect(l.rows[0]).toEqual({ lease_holder: "lab-04", provisioned_host_label: null });

    // 0113 down rebuilds the synthetic lease (label kept), and is idempotent; up again is a no-op on those rows.
    await e.admin.query(sql("0113_erp_provisioning_host_label_backfill.down.sql"));
    expect(await hostCounts("lease_holder")).toEqual(before);
    expect(await errorCode(() => e.admin.query(sql("0113_erp_provisioning_host_label_backfill.down.sql")))).toBeNull();
    expect(await errorCode(() => e.admin.query(sql("0113_erp_provisioning_host_label_backfill.sql")))).toBeNull();
    expect(await hostCounts("provisioned_host_label")).toEqual(before);
  });
});

describe("0112: the SQL transition table is the TypeScript one", () => {
  it("agrees on every (from, to) pair", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ f: string; t: string; ok: boolean }>(
      `SELECT f, t, erp_provisioning_transition_allowed(f, t) AS ok FROM unnest($1::text[]) f CROSS JOIN unnest($1::text[]) t`,
      [[...ERP_PROVISIONING_STATUSES]],
    );
    expect(r.rows).toHaveLength(ERP_PROVISIONING_STATUSES.length ** 2);
    const mismatches = r.rows.filter((x) => x.ok !== erpProvisioningTransitionAllowed(x.f as never, x.t as never));
    expect(mismatches).toEqual([]);
    const sqlEdges = r.rows.filter((x) => x.ok && x.f !== x.t).length;
    const tsEdges = Object.values(ERP_PROVISIONING_ALLOWED_TRANSITIONS).reduce((n, to) => n + to.length, 0);
    expect(sqlEdges).toBe(tsEdges);
  });
});

describe("0112: the guard trigger", () => {
  it("rejects an illegal raw status change (named), also from the sweep privilege; allows a legal one and same-status writes", async () => {
    if (skip()) return;
    const e = guard();
    const claimed = await seed(TENANTS[0]!, "claimed", { holder: "lab-03" });
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET status = 'succeeded', terminal_at = now() WHERE id = $1`, [claimed]))).toBe("23514");
    expect(
      await errorCode(() =>
        asApp(e, null, async (c) => {
          await c.query("SELECT set_config('app.system_privilege', 'provisioning_sweep', true)");
          await c.query(`UPDATE ${T} SET status = 'succeeded', terminal_at = now() WHERE id = $1`, [claimed]);
        }),
      ),
    ).toBe("23514");
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET lease_expires_at = now() + interval '1 hour' WHERE id = $1`, [claimed]))).toBeNull();
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET status = 'verifying' WHERE id = $1`, [claimed]))).toBeNull();
    const done = await seed(TENANTS[1]!, "succeeded", { terminal: true });
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET status = 'requested', terminal_at = NULL WHERE id = $1`, [done]))).toBe("23514");
  });

  it("keeps provisioned_host_label to succeeded rows and frozen once set", async () => {
    if (skip()) return;
    const e = guard();
    const verifying = await seed(TENANTS[2]!, "verifying");
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET provisioned_host_label = 'lab-03' WHERE id = $1`, [verifying]))).toBe("23514");
    expect(
      await errorCode(() =>
        e.admin.query(`UPDATE ${T} SET status = 'succeeded', terminal_at = now(), provisioned_host_label = 'lab-03' WHERE id = $1`, [verifying]),
      ),
    ).toBeNull();
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET provisioned_host_label = 'lab-04' WHERE id = $1`, [verifying]))).toBe("23514");
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET provisioned_host_label = NULL WHERE id = $1`, [verifying]))).toBe("23514");
  });
});

describe("0112: down and up again", () => {
  it("the down restores the 0109 guard (no transition check) and drops the column; the up re-applies", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM ${T}`);
    await e.admin.query(sql("0113_erp_provisioning_host_label_backfill.down.sql"));
    await e.admin.query(sql("0112_erp_provisioning_transitions_host_label.down.sql"));
    const col = await e.admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name = 'provisioned_host_label'`, [T]);
    expect(col.rows[0].n).toBe(0);
    const claimed = await seed(TENANTS[3]!, "claimed");
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET status = 'succeeded', terminal_at = now() WHERE id = $1`, [claimed]))).toBeNull();
    await e.admin.query(`DELETE FROM ${T}`);
    expect(await errorCode(() => e.admin.query(sql("0112_erp_provisioning_transitions_host_label.down.sql")))).toBeNull();
    expect(await errorCode(() => e.admin.query(sql(UP_0112)))).toBeNull();
    expect(await errorCode(() => e.admin.query(sql("0113_erp_provisioning_host_label_backfill.sql")))).toBeNull();
    const claimed2 = await seed(TENANTS[4]!, "claimed");
    expect(await errorCode(() => e.admin.query(`UPDATE ${T} SET status = 'succeeded', terminal_at = now() WHERE id = $1`, [claimed2]))).toBe("23514");
  });
});
