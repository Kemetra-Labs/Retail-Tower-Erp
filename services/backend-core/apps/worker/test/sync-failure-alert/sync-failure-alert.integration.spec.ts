/**
 * RT-1034 — sync-failure email alert on real PostgreSQL (every migration applied). The sweep runs as
 * `app_test` (NOSUPERUSER, NOBYPASSRLS) so FORCE RLS applies to every statement, and once more as
 * `sync_failure_alert`, the production role created from the repo's own deploy template
 * (docs/operations/sql/sync-failure-alert-role.sql, RT-1556): read-only on the failure state, write on
 * its own two tables and `audit_events`. That proves the sweep never writes posting, reconciliation or
 * sales state, and that the worker's boot check (verifySyncFailureAlertRole) accepts exactly that role.
 *
 *   S1   cross-tenant RLS on the alert tables under the NOBYPASSRLS runtime role
 *   S3   concurrent / redelivered sweeps and a crash after the send produce one notification
 *   S4   a retry storm is one alert per open condition; it re-arms only after the condition clears
 *   S5   provider outage: failed deliveries are retried, no duplicate after recovery
 *   S8   no secret in logs, delivery rows, audit rows or the job error
 *   S13  the alert holds no write grant on posting / reconciliation / sale tables (RT-1556: the real role)
 *   AC2  100 redeliveries -> exactly one email per recipient
 *   AC3  the alert is delivered within 10 minutes of the failure state appearing (recorded timestamps)
 *   AC4  posting and sale rows are byte-identical after the sweep
 *   AC5  recipients: owner / tenant_admin, plus a store_manager only for a store in `store_access`
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (RT-123 retention-rls precedent).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  guardPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { verifySyncFailureAlertRole } from "../../src/database-role-verifier";
import { RecordingEmailAdapter } from "../../src/email/email.adapter";
import { MAX_SYNC_FAILURE_ALERT_INTERVAL_MS } from "../../src/sync-failure-alert/sync-failure-alert.config";
import {
  SYNC_FAILURE_ALERT_JOB_NAME,
  SyncFailureAlertIncompleteError,
  SyncFailureAlertProcessor,
  type SyncFailureAlertLogLine,
} from "../../src/sync-failure-alert/sync-failure-alert.processor";
import {
  PgSyncFailureAlertRepository,
  SYNC_FAILURE_ALERT_ACTOR_LABEL,
  type SyncFailureAlertRepository,
} from "../../src/sync-failure-alert/sync-failure-alert.repository";

const TENANT_A = "0a000000-0000-7000-8000-000000103401";
const TENANT_B = "0b000000-0000-7000-8000-000000103402";
const STORE_A1 = "0a000000-0000-7000-8000-000000103410";
const STORE_A2 = "0a000000-0000-7000-8000-000000103411";
const STORE_B1 = "0b000000-0000-7000-8000-000000103412";
const U_OWNER = "0a000000-0000-7000-8000-0000001034a1";
const U_ADMIN = "0a000000-0000-7000-8000-0000001034a2";
const U_MGR_A1 = "0a000000-0000-7000-8000-0000001034a3"; // store_manager with access to A1
const U_MGR_A2 = "0a000000-0000-7000-8000-0000001034a4"; // store_manager with access to A2 only
const U_MGR_ALL = "0a000000-0000-7000-8000-0000001034a5"; // store_manager, kind 'all' (no store_access row)
const U_STAFF = "0a000000-0000-7000-8000-0000001034a6";
const U_REVOKED = "0a000000-0000-7000-8000-0000001034a7"; // admin whose membership is revoked
const U_DELETED = "0a000000-0000-7000-8000-0000001034a8"; // admin whose user is soft-deleted
const U_B_OWNER = "0b000000-0000-7000-8000-0000001034b1";

const T0 = new Date("2026-11-21T10:00:00.000Z");
const EMAIL = (id: string): string => `u-${id.slice(-2)}@fixture.invalid`;

let env: PgTestEnv | null = null;
let alertPool: Pool | null = null;
let seq = 0;
const roleIds = new Map<string, string>();

const admin = (): Pool => env!.admin;

const ALERT_ROLE = "sync_failure_alert";
const ALERT_ROLE_PASSWORD = "sync_failure_alert_test";
const ALERT_ROLE_TEMPLATE = resolve(
  __dirname,
  "../../../../docs/operations/sql/sync-failure-alert-role.sql",
);

/**
 * Creates a role from the production deploy template. The template is a psql script: the one meta-command
 * (`\set ON_ERROR_STOP on`) is dropped and the psql variable `alert_role` is substituted, which is all psql
 * does with it. The password is set separately, as in the runbook.
 */
async function createAlertRoleFromTemplate(roleName: string): Promise<Pool> {
  const sql = readFileSync(ALERT_ROLE_TEMPLATE, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n")
    .replaceAll(':"alert_role"', `"${roleName}"`)
    .replaceAll(":'alert_role'", `'${roleName}'`);
  expect(sql).not.toContain(":alert_role"); // every psql variable was substituted
  await admin().query(sql);
  await admin().query(`ALTER ROLE "${roleName}" PASSWORD '${ALERT_ROLE_PASSWORD}'`);
  return guardPool(
    new Pool({
      connectionString: `postgres://${roleName}:${ALERT_ROLE_PASSWORD}@${env!.host}:${env!.port}/test`,
    }),
  );
}

async function seedRoleMembership(
  tenant: string,
  user: string,
  roleCode: string,
  kind: "all" | "specific",
  opts: { revoked?: boolean; stores?: string[] } = {},
): Promise<void> {
  const membershipId = `${tenant.slice(0, 8)}-0000-7000-8000-${String(1034500 + ++seq).padStart(12, "0")}`;
  const a = admin();
  // One role row per (tenant, code): roles_tenant_code_uidx is UNIQUE (tenant_id, code).
  const roleKey = `${tenant}|${roleCode}`;
  let roleId = roleIds.get(roleKey);
  if (roleId === undefined) {
    roleId = `${tenant.slice(0, 8)}-0000-7000-8000-${String(1034000 + seq).padStart(12, "0")}`;
    roleIds.set(roleKey, roleId);
    await a.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`, [roleId, tenant, roleCode]);
  }
  await a.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [membershipId, tenant, user, roleId, kind, opts.revoked ? new Date() : null],
  );
  for (const store of opts.stores ?? []) {
    await a.query(`INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $2, $3)`, [
      membershipId,
      store,
      tenant,
    ]);
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[sync-failure-alert.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = admin();
  await a.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'rt1034-a', 'A', 'active'), ($2, 'rt1034-b', 'B', 'active')`,
    [TENANT_A, TENANT_B],
  );
  for (const u of [U_OWNER, U_ADMIN, U_MGR_A1, U_MGR_A2, U_MGR_ALL, U_STAFF, U_REVOKED, U_DELETED, U_B_OWNER]) {
    await a.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, NULL)`, [u, EMAIL(u)]);
  }
  await a.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [U_DELETED]);
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $4, 'A1', 'Alpha One'), ($2, $4, 'A2', 'Alpha Two'), ($3, $5, 'B1', 'Beta One')`,
    [STORE_A1, STORE_A2, STORE_B1, TENANT_A, TENANT_B],
  );
  await seedRoleMembership(TENANT_A, U_OWNER, "owner", "all");
  await seedRoleMembership(TENANT_A, U_ADMIN, "tenant_admin", "all");
  await seedRoleMembership(TENANT_A, U_MGR_A1, "store_manager", "specific", { stores: [STORE_A1] });
  await seedRoleMembership(TENANT_A, U_MGR_A2, "store_manager", "specific", { stores: [STORE_A2] });
  await seedRoleMembership(TENANT_A, U_MGR_ALL, "store_manager", "all");
  await seedRoleMembership(TENANT_A, U_STAFF, "store_staff", "specific", { stores: [STORE_A1] });
  await seedRoleMembership(TENANT_A, U_REVOKED, "tenant_admin", "all", { revoked: true });
  await seedRoleMembership(TENANT_A, U_DELETED, "tenant_admin", "all");
  await seedRoleMembership(TENANT_B, U_B_OWNER, "owner", "all");

  // The production least-privilege role, from the repo's own deploy template (RT-1556, S13).
  alertPool = await createAlertRoleFromTemplate(ALERT_ROLE);
}, 180_000);

afterAll(async () => {
  if (alertPool) await alertPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
});

beforeEach(async () => {
  if (!env) return;
  const a = admin();
  await a.query(`DELETE FROM sync_failure_alert_deliveries`);
  await a.query(`DELETE FROM sync_failure_alert_windows`);
  await a.query(`DELETE FROM erpnext_posting_status`);
  await a.query(`DELETE FROM sales`);
});

async function seedSale(tenant: string, store: string, syncStatus: string): Promise<string> {
  seq += 1;
  const r = await admin().query<{ id: string }>(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                        source_system, external_id, payload_hash, created_by, sync_status)
     VALUES (gen_random_uuid(), $1, $2, 'USD', 5, '2026-11-21T09:00:00Z', '2026-11-21', 'pos-t1034', $3, $4,
             $5, $6)
     RETURNING id`,
    [tenant, store, `t1034-${seq}`, "a".repeat(64), tenant === TENANT_A ? U_OWNER : U_B_OWNER, syncStatus],
  );
  return r.rows[0]!.id;
}

async function seedPosting(tenant: string, store: string, status: string): Promise<string> {
  const saleId = await seedSale(tenant, store, "synced");
  await admin().query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status,
        document_ref, rejection_category)
     VALUES (gen_random_uuid(), $1, $2, $3, 'sale_post', $3, 'pos-t1034', $4, $5, $6, $7, $8)`,
    [
      tenant,
      store,
      saleId,
      `p-${saleId}`,
      "b".repeat(64),
      status,
      status === "posted" ? "SINV-1" : null,
      status === "permanently_rejected" ? "unmapped_item" : null,
    ],
  );
  return saleId;
}

function makeProcessor(
  repoPool: Pool,
  adapter = new RecordingEmailAdapter(),
  clock: () => Date = () => T0,
  repo: SyncFailureAlertRepository = new PgSyncFailureAlertRepository(repoPool),
) {
  const logs: SyncFailureAlertLogLine[] = [];
  const processor = new SyncFailureAlertProcessor(repo, adapter, true, () => undefined, clock, (l) => logs.push(l));
  return { processor, adapter, logs };
}

const sweep = (p: SyncFailureAlertProcessor) => p.process(SYNC_FAILURE_ALERT_JOB_NAME, {});
const recipientsOf = (adapter: RecordingEmailAdapter): string[] => adapter.sent.map((m) => m.to).sort();

async function windows(tenant = TENANT_A) {
  const r = await admin().query(
    `SELECT store_id, condition_key, window_seq, failure_count, cleared_at FROM sync_failure_alert_windows
      WHERE tenant_id = $1 ORDER BY store_id, condition_key, window_seq`,
    [tenant],
  );
  return r.rows as { store_id: string; condition_key: string; window_seq: number; failure_count: number; cleared_at: Date | null }[];
}

const SKIP = (): boolean => env === null;

/** Alert audit rows of the CURRENT test (audit_events is append-only, so earlier tests' rows stay). */
const ALERT_AUDIT_SQL = `
  SELECT a.* FROM audit_events a
   WHERE a.actor_label = '${SYNC_FAILURE_ALERT_ACTOR_LABEL}'
     AND (a.target_id IN (SELECT id FROM sync_failure_alert_windows)
          OR a.target_id IN (SELECT id FROM sync_failure_alert_deliveries))`;

describe("RT-1034 sync-failure alert (PostgreSQL)", () => {
  it("AC5: alerts the owner and tenant_admin, plus only the store_manager with access to the store", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const { processor, adapter } = makeProcessor(env!.app);
    const result = await sweep(processor);

    expect(result).toMatchObject({ fired: 1, delivered: 4, failed: 0 });
    // Positive: owner, tenant_admin, the store_manager with a store_access row for A1, and the store_manager
    // with tenant-wide access (kind 'all', the API's callerStoreScope "tenant" rule). Negative: the manager
    // of A2 only, store_staff, a revoked membership, a deleted user, the other tenant's owner.
    expect(recipientsOf(adapter)).toEqual([EMAIL(U_ADMIN), EMAIL(U_MGR_A1), EMAIL(U_MGR_ALL), EMAIL(U_OWNER)].sort());
    for (const out of [U_MGR_A2, U_STAFF, U_REVOKED, U_DELETED, U_B_OWNER]) {
      expect(adapter.sent.map((m) => m.to)).not.toContain(EMAIL(out));
    }
  });

  it("AC5: another store's failure alerts that store's manager, not the first store's", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A2, "failed-needs-repair");
    const { processor, adapter } = makeProcessor(env!.app);
    await sweep(processor);
    expect(recipientsOf(adapter)).toEqual([EMAIL(U_ADMIN), EMAIL(U_MGR_A2), EMAIL(U_MGR_ALL), EMAIL(U_OWNER)].sort());
    expect(adapter.sent.map((m) => m.to)).not.toContain(EMAIL(U_MGR_A1));
  });

  it("AC5 (send time): a recipient revoked between listing and sending gets no email", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const real = new PgSyncFailureAlertRepository(env!.app);
    const revokeAfterListing: SyncFailureAlertRepository = Object.create(real, {
      listRecipients: {
        value: async (tenantId: string, storeId: string) => {
          const list = await real.listRecipients(tenantId, storeId);
          await admin().query(`UPDATE memberships SET revoked_at = now() WHERE user_id = $1`, [U_MGR_A1]);
          return list;
        },
      },
    }) as SyncFailureAlertRepository;
    const { processor, adapter } = makeProcessor(env!.app, new RecordingEmailAdapter(), () => T0, revokeAfterListing);
    const result = await sweep(processor);
    await admin().query(`UPDATE memberships SET revoked_at = NULL WHERE user_id = $1`, [U_MGR_A1]);

    expect(adapter.sent.map((m) => m.to)).not.toContain(EMAIL(U_MGR_A1));
    expect(result.failed).toBe(1);
    const row = await admin().query(
      `SELECT status, last_error_class FROM sync_failure_alert_deliveries WHERE recipient_user_id = $1`,
      [U_MGR_A1],
    );
    expect(row.rows[0]).toEqual({ status: "failed", last_error_class: "RecipientNotAuthorized" });
  });

  it("reads both failure conditions and nothing else (posted and pending rows alert nobody)", async () => {
    if (SKIP()) return;
    await seedPosting(TENANT_A, STORE_A1, "posted");
    await seedPosting(TENANT_A, STORE_A1, "pending");
    await seedPosting(TENANT_A, STORE_A1, "failed_transient");
    await seedSale(TENANT_A, STORE_A1, "failed-retryable");
    const { processor, adapter } = makeProcessor(env!.app);
    expect(await sweep(processor)).toMatchObject({ fired: 0, delivered: 0 });
    expect(adapter.sent).toHaveLength(0);

    await seedPosting(TENANT_A, STORE_A1, "permanently_rejected");
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    expect(await sweep(processor)).toMatchObject({ fired: 2 });
    expect((await windows()).map((w) => w.condition_key)).toEqual([
      "posting_permanently_rejected",
      "sale_failed_needs_repair",
    ]);
  });

  it("AC2: 100 redeliveries of the same condition send exactly one email per recipient", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const { processor, adapter } = makeProcessor(env!.app);
    for (let i = 0; i < 100; i += 1) await sweep(processor);
    expect(adapter.sent).toHaveLength(4);
    const rows = await admin().query(`SELECT count(*)::int AS n FROM sync_failure_alert_deliveries`);
    expect(rows.rows[0].n).toBe(4);
    const audit = await admin().query(
      `SELECT action, count(*)::int AS n FROM (${ALERT_AUDIT_SQL}) x GROUP BY action ORDER BY action`,
    );
    expect(audit.rows).toEqual([
      { action: "sync_failure_alert.delivered", n: 4 },
      { action: "sync_failure_alert.fired", n: 1 },
      { action: "sync_failure_alert.suppressed", n: 1 },
    ]);
  });

  it("S3: concurrent sweeps (two replicas) claim each delivery once", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const adapter = new RecordingEmailAdapter();
    const a = makeProcessor(env!.app, adapter);
    const b = makeProcessor(env!.app, adapter);
    await Promise.all([sweep(a.processor), sweep(b.processor), sweep(a.processor), sweep(b.processor)]);
    expect(adapter.sent).toHaveLength(4);
    expect((await windows()).filter((w) => w.cleared_at === null)).toHaveLength(1);
  });

  it("S3: a worker killed after the provider accepted the mail never sends it again", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const real = new PgSyncFailureAlertRepository(env!.app);
    let killed = false;
    const killsOnce: SyncFailureAlertRepository = Object.create(real, {
      markDelivered: {
        value: async (input: Parameters<SyncFailureAlertRepository["markDelivered"]>[0]) => {
          if (!killed && input.deliveryId) {
            killed = true;
            throw new Error("worker killed after send");
          }
          return real.markDelivered(input);
        },
      },
    }) as SyncFailureAlertRepository;
    const adapter = new RecordingEmailAdapter();
    const { processor } = makeProcessor(env!.app, adapter, () => T0, killsOnce);
    await expect(sweep(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    for (let i = 0; i < 5; i += 1) await sweep(processor);
    expect(adapter.sent).toHaveLength(4); // the killed delivery's mail was sent once, never again
  });

  it("S4: a retry storm is one alert; the condition re-arms only after it clears", async () => {
    if (SKIP()) return;
    const saleId = await seedPosting(TENANT_A, STORE_A1, "permanently_rejected");
    const { processor, adapter } = makeProcessor(env!.app);
    for (let i = 0; i < 5; i += 1) {
      await admin().query(`UPDATE erpnext_posting_status SET retry_count = retry_count + 1 WHERE sale_id = $1`, [saleId]);
      await sweep(processor);
    }
    expect(adapter.sent).toHaveLength(4);
    expect(await windows()).toHaveLength(1);

    // The condition clears: the window closes and nothing is sent.
    await admin().query(
      `UPDATE erpnext_posting_status SET status = 'posted', document_ref = 'SINV-9', rejection_category = NULL
        WHERE sale_id = $1`,
      [saleId],
    );
    expect(await sweep(processor)).toMatchObject({ cleared: 1, fired: 0 });
    expect((await windows())[0]!.cleared_at).not.toBeNull();
    expect(adapter.sent).toHaveLength(4);

    // It fails again: a second window, a second alert.
    await seedPosting(TENANT_A, STORE_A1, "permanently_rejected");
    expect(await sweep(processor)).toMatchObject({ fired: 1, delivered: 4 });
    expect(adapter.sent).toHaveLength(8);
    expect((await windows()).map((w) => w.window_seq)).toEqual([1, 2]);
  });

  it("S5: a provider outage fails the job; the recovery sends once and never again", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const adapter = new RecordingEmailAdapter();
    const { processor } = makeProcessor(env!.app, adapter);
    adapter.reject = new Error("provider 503");
    await expect(sweep(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    await expect(sweep(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    const failed = await admin().query(`SELECT status, attempts FROM sync_failure_alert_deliveries`);
    expect(failed.rows.every((r: { status: string }) => r.status === "failed")).toBe(true);

    delete adapter.reject;
    const sentDuringOutage = adapter.sent.length;
    expect(await sweep(processor)).toMatchObject({ delivered: 4, failed: 0 });
    await sweep(processor);
    await sweep(processor);
    expect(adapter.sent.length - sentDuringOutage).toBe(4);
    const done = await admin().query(`SELECT DISTINCT status, attempts FROM sync_failure_alert_deliveries`);
    expect(done.rows).toEqual([{ status: "delivered", attempts: 3 }]);
  });

  it("S8: a secret in the provider error is in no log, delivery row, audit row or job error", async () => {
    if (SKIP()) return;
    const secret = ["AKIA", "S8CANARY", "0123456789"].join("");
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const adapter = new RecordingEmailAdapter();
    const { processor, logs } = makeProcessor(env!.app, adapter);
    adapter.reject = new Error(`SignatureDoesNotMatch ${secret}`);
    let jobError = "";
    try {
      await sweep(processor);
    } catch (err) {
      jobError = (err as Error).message;
    }
    const rows = await admin().query(`SELECT to_jsonb(d) AS r FROM sync_failure_alert_deliveries d`);
    const win = await admin().query(`SELECT to_jsonb(w) AS r FROM sync_failure_alert_windows w`);
    const audit = await admin().query(`SELECT to_jsonb(x) AS r FROM (${ALERT_AUDIT_SQL}) x`);
    const everything = JSON.stringify({ logs, rows: rows.rows, win: win.rows, audit: audit.rows, jobError });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("SignatureDoesNotMatch");
    expect(everything).not.toContain("@fixture.invalid"); // no recipient address is stored or logged
  });

  it("AC3: the alert is delivered within 10 minutes of the failure appearing (recorded timestamps)", async () => {
    if (SKIP()) return;
    // The failure state appears in the database (the sale's own DB-sourced created_at); the sweep runs on
    // the REAL clock, so delivered_at is a measured time, not an injected one.
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const { processor } = makeProcessor(env!.app, new RecordingEmailAdapter(), () => new Date());
    await sweep(processor);
    const r = await admin().query<{ delivered_at: Date; failure_at: Date }>(
      `SELECT d.delivered_at, (SELECT min(created_at) FROM sales WHERE tenant_id = d.tenant_id) AS failure_at
         FROM sync_failure_alert_deliveries d WHERE d.status = 'delivered'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    const latencies = r.rows.map((row) => row.delivered_at.getTime() - row.failure_at.getTime());
    // eslint-disable-next-line no-console
    console.info(`[AC3] failure_at ${r.rows[0]!.failure_at.toISOString()} delivered_at ${r.rows[0]!.delivered_at.toISOString()} sweep latency ${Math.max(...latencies)} ms`);
    // The sweep itself adds seconds at most; the schedule adds at most one interval plus the BullMQ retry
    // window (15 s), which the scheduler spec bounds against the 10-minute target.
    // Asserted against the configurable CAP (a deployment may set any interval up to it), not the default.
    expect(Math.max(...latencies) + MAX_SYNC_FAILURE_ALERT_INTERVAL_MS + 15_000).toBeLessThan(10 * 60 * 1000);
  });

  it("S3 (the one unrecoverable case): a crash that also loses the outcome write leaves the claim stuck, reported as stale, never doubled", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const real = new PgSyncFailureAlertRepository(env!.app);
    let crashed = false;
    const crashesOnce: SyncFailureAlertRepository = Object.create(real, {
      authorizedEmail: {
        value: async (tenantId: string, storeId: string, userId: string) => {
          if (!crashed) {
            crashed = true;
            throw new Error("worker killed between claim and send");
          }
          return real.authorizedEmail(tenantId, storeId, userId);
        },
      },
      // The process is gone: not even the outcome write happens.
      markFailed: { value: async () => Promise.reject(new Error("process gone")) },
    }) as SyncFailureAlertRepository;
    const adapter = new RecordingEmailAdapter();
    const { processor } = makeProcessor(env!.app, adapter, () => T0, crashesOnce);
    await expect(sweep(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    for (let i = 0; i < 3; i += 1) await sweep(processor);
    // The first recipient's claim is stuck at 'claimed' and is never re-sent: one email lost, none doubled.
    expect(adapter.sent).toHaveLength(3);
    const stuck = await admin().query(`SELECT count(*)::int AS n FROM sync_failure_alert_deliveries WHERE status = 'claimed'`);
    expect(stuck.rows[0].n).toBe(1);

    // About two intervals later the stuck claim is reported once (metric outcome + a system audit row).
    const later = new Date(T0.getTime() + 3 * MAX_SYNC_FAILURE_ALERT_INTERVAL_MS);
    const outcomes: string[] = [];
    const reporter = new SyncFailureAlertProcessor(
      real,
      adapter,
      true,
      (o) => outcomes.push(o),
      () => later,
      () => undefined,
      2 * MAX_SYNC_FAILURE_ALERT_INTERVAL_MS,
    );
    await sweep(reporter);
    await sweep(reporter);
    expect(outcomes.filter((o) => o === "stale")).toHaveLength(1);
    const audit = await admin().query(
      `SELECT count(*)::int AS n FROM (${ALERT_AUDIT_SQL}) x WHERE x.action = 'sync_failure_alert.stale_claim'`,
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("a send-time re-check that throws releases the claim, and the retry sends it once", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const real = new PgSyncFailureAlertRepository(env!.app);
    let failures = 1;
    const flaky: SyncFailureAlertRepository = Object.create(real, {
      authorizedEmail: {
        value: async (tenantId: string, storeId: string, userId: string) => {
          if (failures-- > 0) throw new Error("pool timeout");
          return real.authorizedEmail(tenantId, storeId, userId);
        },
      },
    }) as SyncFailureAlertRepository;
    const adapter = new RecordingEmailAdapter();
    const { processor } = makeProcessor(env!.app, adapter, () => T0, flaky);
    await expect(sweep(processor)).rejects.toBeInstanceOf(SyncFailureAlertIncompleteError);
    await sweep(processor);
    await sweep(processor);
    expect(adapter.sent).toHaveLength(4);
    const states = await admin().query(`SELECT DISTINCT status FROM sync_failure_alert_deliveries`);
    expect(states.rows).toEqual([{ status: "delivered" }]);
    const released = await admin().query(
      `SELECT count(*)::int AS n FROM (${ALERT_AUDIT_SQL}) x
        WHERE x.action = 'sync_failure_alert.failed' AND x.metadata->>'error_class' = 'PreSendError'`,
    );
    expect(released.rows[0].n).toBe(1);
  });

  it("a window is not closed on a stale observation: the condition is re-read under the lock", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const repo = new PgSyncFailureAlertRepository(env!.app);
    const observed = (await repo.observeConditions(TENANT_A))!;
    await repo.reconcileWindows(TENANT_A, observed, T0);
    // A concurrent sweep that observed "nothing" before the failure (re)appeared tries to close the window.
    const stale = await repo.reconcileWindows(TENANT_A, [], new Date(T0.getTime() + 1000));
    expect(stale.cleared).toBe(0);
    expect((await windows())[0]!.cleared_at).toBeNull();
    // Once the failure is really gone the same call closes it.
    await admin().query(`DELETE FROM sales WHERE tenant_id = $1`, [TENANT_A]);
    const real = await repo.reconcileWindows(TENANT_A, [], new Date(T0.getTime() + 2000));
    expect(real.cleared).toBe(1);
  });

  it("a suspended tenant is not alerted: no window, no email, and nothing is written", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    await admin().query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_A]);
    try {
      const { processor, adapter } = makeProcessor(env!.app);
      expect(await sweep(processor)).toMatchObject({ fired: 0, delivered: 0, failedTenants: 0 });
      expect(adapter.sent).toHaveLength(0);
      expect(await windows()).toHaveLength(0);
    } finally {
      await admin().query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_A]);
    }
    await admin().query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [TENANT_A]);
    try {
      const { processor, adapter } = makeProcessor(env!.app);
      await sweep(processor);
      expect(adapter.sent).toHaveLength(0);
    } finally {
      await admin().query(`UPDATE tenants SET deleted_at = NULL WHERE id = $1`, [TENANT_A]);
    }
  });

  it("S1: tenant A cannot read or write tenant B's alert rows under the NOBYPASSRLS runtime role", async () => {
    if (SKIP()) return;
    await seedSale(TENANT_B, STORE_B1, "failed-needs-repair");
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const { processor } = makeProcessor(env!.app);
    await sweep(processor);

    const inA = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (c) => {
      const w = await c.query(`SELECT tenant_id FROM sync_failure_alert_windows`);
      const d = await c.query(`SELECT tenant_id FROM sync_failure_alert_deliveries`);
      return { w: w.rows, d: d.rows };
    });
    expect(inA.w.length).toBeGreaterThan(0);
    expect([...inA.w, ...inA.d].every((r: { tenant_id: string }) => r.tenant_id === TENANT_A)).toBe(true);

    await expect(
      runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
        c.query(
          `INSERT INTO sync_failure_alert_windows (id, tenant_id, store_id, condition_key, window_seq, failure_count)
           VALUES (gen_random_uuid(), $1, $2, 'sale_failed_needs_repair', 9, 1)`,
          [TENANT_B, STORE_B1],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const noContext = await env!.app.query(`SELECT count(*)::int AS n FROM sync_failure_alert_windows`);
    expect(noContext.rows[0].n).toBe(0); // no tenant GUC -> no rows
    const updated = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      c.query(`UPDATE sync_failure_alert_windows SET failure_count = 99 WHERE tenant_id = $1`, [TENANT_B]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("S13 + AC4: the whole sweep runs as the production alert role and still delivers one alert", async () => {
    if (SKIP()) return;
    await seedPosting(TENANT_A, STORE_A1, "permanently_rejected");
    await seedSale(TENANT_A, STORE_A1, "failed-needs-repair");
    const snapshot = async () =>
      JSON.stringify([
        (await admin().query(`SELECT * FROM erpnext_posting_status ORDER BY id`)).rows,
        (await admin().query(`SELECT * FROM sales ORDER BY id`)).rows,
      ]);
    const before = await snapshot();

    const { processor, adapter } = makeProcessor(alertPool!);
    const result = await sweep(processor);
    expect(result).toMatchObject({ fired: 2, failed: 0, failedTenants: 0 });
    expect(adapter.sent.length).toBeGreaterThan(0); // the alert is still delivered
    expect(result.delivered).toBe(adapter.sent.length);
    expect(await snapshot()).toBe(before); // AC4: posting and sale state unchanged

    const who = await alertPool!.query<{ u: string; s: string }>(`SELECT current_user AS u, session_user AS s`);
    expect(who.rows[0]).toEqual({ u: ALERT_ROLE, s: ALERT_ROLE });
  });

  it("RT-1556: the alert role cannot write posting, reconciliation or sales tables, nor delete anything", async () => {
    if (SKIP()) return;
    await seedPosting(TENANT_A, STORE_A1, "permanently_rejected");

    for (const table of [
      "erpnext_posting_status",
      "sales",
      "erpnext_reconciliation_run",
      "erpnext_warehouse_map",
      "sale_lines",
      "tenants",
      "stores",
      "memberships",
    ]) {
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await admin().query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [ALERT_ROLE, table, priv]);
        expect({ table, priv, ok: r.rows[0].ok }).toEqual({ table, priv, ok: false });
      }
    }
    for (const priv of ["DELETE", "TRUNCATE"]) {
      for (const table of ["sync_failure_alert_windows", "sync_failure_alert_deliveries", "audit_events"]) {
        const r = await admin().query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [ALERT_ROLE, table, priv]);
        expect({ table, priv, ok: r.rows[0].ok }).toEqual({ table, priv, ok: false });
      }
    }

    // And a real statement as that role is refused with 42501 (permission denied), not by RLS.
    for (const statement of [
      `UPDATE erpnext_posting_status SET status = 'pending'`,
      `DELETE FROM erpnext_posting_status`,
      `UPDATE sales SET sync_status = 'synced'`,
      `DELETE FROM sales`,
      `UPDATE erpnext_reconciliation_run SET status = 'failed'`,
      `DELETE FROM sync_failure_alert_windows`,
      `TRUNCATE sync_failure_alert_deliveries`,
    ]) {
      await expect(
        runWithTenantContext(alertPool!, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) => c.query(statement)),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("RT-1556: the worker's boot check accepts the role created from the template", async () => {
    if (SKIP()) return;
    await expect(verifySyncFailureAlertRole(alertPool!, env!.app)).resolves.toBeUndefined();
  });

  it.each([
    ["UPDATE ON erpnext_posting_status", `GRANT UPDATE ON erpnext_posting_status TO`],
    ["INSERT ON sales", `GRANT INSERT ON sales TO`],
    ["DELETE ON sync_failure_alert_windows", `GRANT DELETE ON sync_failure_alert_windows TO`],
    ["SELECT ON users", `GRANT SELECT ON users TO`],
    ["SELECT ON users (password_hash)", `GRANT SELECT (password_hash) ON users TO`],
  ])("RT-1556: the worker's boot check refuses an extra grant (%s)", async (label, grant) => {
    if (SKIP()) return;
    const roleName = `rt1556_extra_${++seq}`;
    const pool = await createAlertRoleFromTemplate(roleName);
    try {
      await admin().query(`${grant} "${roleName}"`);
      await expect(verifySyncFailureAlertRole(pool, env!.app)).rejects.toThrow(
        new RegExp(`beyond the sync-failure alert grants: .*${label.replace(/[()]/g, "\\$&")}`),
      );
    } finally {
      await pool.end().catch(() => undefined);
      await admin().query(`DROP OWNED BY "${roleName}"`);
      await admin().query(`DROP ROLE "${roleName}"`);
    }
  });

  it("RT-1556: the worker's boot check refuses a missing grant and a role membership", async () => {
    if (SKIP()) return;
    const roleName = `rt1556_short_${++seq}`;
    const pool = await createAlertRoleFromTemplate(roleName);
    try {
      await admin().query(`REVOKE UPDATE ON sync_failure_alert_deliveries FROM "${roleName}"`);
      await expect(verifySyncFailureAlertRole(pool, env!.app)).rejects.toThrow(
        /is missing required grants: UPDATE ON sync_failure_alert_deliveries$/,
      );
      await admin().query(`GRANT UPDATE ON sync_failure_alert_deliveries TO "${roleName}"`);
      await admin().query(`GRANT pg_read_all_stats TO "${roleName}"`);
      await expect(verifySyncFailureAlertRole(pool, env!.app)).rejects.toThrow(/must be a member of no role/);
    } finally {
      await pool.end().catch(() => undefined);
      await admin().query(`DROP OWNED BY "${roleName}"`);
      await admin().query(`DROP ROLE "${roleName}"`);
    }
  });

  it("S13: the repository SQL names no write on any table but its own two and audit_events", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/sync-failure-alert/sync-failure-alert.repository.ts"),
      "utf8",
    );
    const writes = [...source.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+([a-z_]+)/gi)].map(
      (m) => m[2]!.toLowerCase(),
    );
    const allowed = new Set(["sync_failure_alert_windows", "sync_failure_alert_deliveries", "audit_events"]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((t) => !allowed.has(t))).toEqual([]);
  });
});
