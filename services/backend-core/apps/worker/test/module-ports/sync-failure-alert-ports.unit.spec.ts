/**
 * RT-1525 — the worker ports the sync-failure alert reads and writes through (one per owning module of
 * module-map.json). The SQL moved from sync-failure-alert.repository.ts; these specs pin that each port
 * runs on the CALLER's client, keeps the RT-1034 rule and filters, and needs no query for an empty input.
 * The database behaviour is covered by test/sync-failure-alert/sync-failure-alert.integration.spec.ts.
 */
import { insertSystemAuditEvent } from "../../src/audit";
import { liveUserEmails } from "../../src/auth";
import { syncFailureCounts, syncFailurePresent } from "../../src/catalog";
import { storeAlertRecipientUserIds } from "../../src/memberships";
import { liveStoreNames } from "../../src/stores";
import { isTenantActive } from "../../src/tenants";

const TENANT = "01890000-0000-7000-8000-00000000000a";
const STORE = "01890000-0000-7000-8000-00000000000b";
const USER_A = "01890000-0000-7000-8000-0000000000a1";
const USER_B = "01890000-0000-7000-8000-0000000000b1";

type Row = Record<string, unknown>;

function client(rows: Row[] = [], rowCount?: number): { query: jest.Mock; sql: () => string[]; params: () => unknown[][] } {
  const query = jest.fn(async () => ({ rows, rowCount: rowCount ?? rows.length }));
  const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
  return {
    query,
    sql: () => query.mock.calls.map((c) => squash(c[0] as string)),
    params: () => query.mock.calls.map((c) => c[1] as unknown[]),
  };
}

describe("worker tenants port", () => {
  it("isTenantActive: active and not deleted, on the caller's client", async () => {
    const c = client([{ "?column?": 1 }]);
    expect(await isTenantActive(c, TENANT)).toBe(true);
    expect(c.sql()[0]).toBe("SELECT 1 FROM tenants WHERE id = $1 AND status = 'active' AND deleted_at IS NULL");
    expect(await isTenantActive(client([], 0), TENANT)).toBe(false);
  });
});

describe("worker catalog port", () => {
  it("syncFailureCounts reads both conditions SELECT-only, ordered by store then condition, without stores", async () => {
    const c = client([{ store_id: STORE, condition_key: "sale_failed_needs_repair", failure_count: 2 }]);
    expect(await syncFailureCounts(c, TENANT)).toEqual([{ storeId: STORE, condition: "sale_failed_needs_repair", failureCount: 2 }]);
    const sql = c.sql()[0]!;
    expect(sql).toContain("FROM erpnext_posting_status s WHERE s.tenant_id = $1 AND s.status = 'permanently_rejected'");
    expect(sql).toContain("FROM sales sa WHERE sa.tenant_id = $1 AND sa.sync_status = 'failed-needs-repair'");
    expect(sql).toMatch(/ORDER BY store_id, condition_key$/);
    expect(sql).not.toMatch(/\bstores\b|\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("syncFailurePresent re-reads one store's condition", async () => {
    const c = client([{ "?column?": 1 }]);
    expect(await syncFailurePresent(c, TENANT, STORE, "posting_permanently_rejected")).toBe(true);
    expect(c.params()[0]).toEqual([TENANT, STORE]);
    expect(await syncFailurePresent(client([], 0), TENANT, STORE, "sale_failed_needs_repair")).toBe(false);
  });
});

describe("worker stores port", () => {
  it("liveStoreNames keeps only the tenant's non-deleted stores, and runs no query for no ids", async () => {
    const c = client([{ id: STORE, name: "Main" }]);
    expect(await liveStoreNames(c, TENANT, [STORE])).toEqual(new Map([[STORE, "Main"]]));
    expect(c.sql()[0]).toBe("SELECT id, name FROM stores WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL");
    const empty = client();
    expect(await liveStoreNames(empty, TENANT, [])).toEqual(new Map());
    expect(empty.query).not.toHaveBeenCalled();
  });
});

describe("worker memberships port", () => {
  it("storeAlertRecipientUserIds keeps the RT-1034 rule (owner, tenant_admin, store_manager with access) and dedupes", async () => {
    const c = client([{ user_id: USER_A }, { user_id: USER_B }, { user_id: USER_A }]);
    expect(await storeAlertRecipientUserIds(c, TENANT, STORE)).toEqual([USER_A, USER_B]);
    const sql = c.sql()[0]!;
    expect(sql).toContain("m.revoked_at IS NULL AND m.deleted_at IS NULL");
    expect(sql).toContain("r.code IN ('owner', 'tenant_admin')");
    expect(sql).toContain("r.code = 'store_manager'");
    expect(sql).toContain("m.store_access_kind = 'all'");
    expect(sql).toContain("sa.store_id = $2");
    expect(sql).not.toMatch(/\busers\b/);
    expect(c.params()[0]).toEqual([TENANT, STORE]);
  });

  it("with onlyUserId, it checks that one user", async () => {
    const c = client([{ user_id: USER_A }]);
    expect(await storeAlertRecipientUserIds(c, TENANT, STORE, USER_A)).toEqual([USER_A]);
    expect(c.sql()[0]).toMatch(/AND m\.user_id = \$3$/);
    expect(c.params()[0]).toEqual([TENANT, STORE, USER_A]);
  });
});

describe("worker auth port", () => {
  it("liveUserEmails reads live users ordered by id, and runs no query for no ids", async () => {
    const c = client([{ user_id: USER_A, email: "a@example.invalid" }]);
    expect(await liveUserEmails(c, [USER_A])).toEqual([{ userId: USER_A, email: "a@example.invalid" }]);
    expect(c.sql()[0]).toBe("SELECT u.id AS user_id, u.email FROM users u WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL ORDER BY u.id");
    const empty = client();
    expect(await liveUserEmails(empty, [])).toEqual([]);
    expect(empty.query).not.toHaveBeenCalled();
  });
});

describe("worker audit port", () => {
  it("insertSystemAuditEvent writes a system-actor row once (ON CONFLICT DO NOTHING) and reports whether it wrote", async () => {
    const c = client([], 1);
    const written = await insertSystemAuditEvent(c, {
      id: "01890000-0000-5000-a000-000000000001",
      actorLabel: "system:sync-failure-alert-sweep",
      tenantId: TENANT,
      storeId: STORE,
      action: "sync_failure_alert.fired",
      targetType: "sync_failure_alert_window",
      targetId: "01890000-0000-7000-8000-0000000000ff",
      metadata: { condition_key: "sale_failed_needs_repair", window_seq: 1, failure_count: 2 },
    });
    expect(written).toBe(1);
    expect(c.sql()[0]).toBe(
      "INSERT INTO audit_events (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, metadata) " +
        "VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8::jsonb) ON CONFLICT (id) DO NOTHING",
    );
    expect(c.params()[0]).toEqual([
      "01890000-0000-5000-a000-000000000001",
      "system:sync-failure-alert-sweep",
      TENANT,
      STORE,
      "sync_failure_alert.fired",
      "sync_failure_alert_window",
      "01890000-0000-7000-8000-0000000000ff",
      JSON.stringify({ condition_key: "sale_failed_needs_repair", window_seq: 1, failure_count: 2 }),
    ]);
    const again = { id: "x", actorLabel: "l", tenantId: TENANT, storeId: STORE, action: "a", targetType: "t", targetId: "i", metadata: {} };
    expect(await insertSystemAuditEvent(client([], 0), again)).toBe(0);
  });
});
