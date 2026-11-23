/**
 * RT-1556 — the sync-failure alert role must be a distinct, non-superuser,
 * NOBYPASSRLS role holding exactly SYNC_FAILURE_ALERT_ROLE_GRANTS, in the same
 * database as DATABASE_URL, and a member of no role. The real-database proof
 * (the role created from the deploy template) is in
 * sync-failure-alert.integration.spec.ts.
 */
import type { Pool } from "pg";

import {
  SYNC_FAILURE_ALERT_ROLE_GRANTS,
  diffSyncFailureAlertGrants,
  verifySyncFailureAlertRole,
} from "../../src/database-role-verifier";
import { AuditDbPool, SyncFailureAlertRoleVerifier } from "../../src/worker.module";
import { SyncFailureAlertDbPool } from "../../src/sync-failure-alert/sync-failure-alert-db-pool";

const DB_ID = { db_name: "rt", db_oid: "16384", server_started: "1760104800" };

interface Held {
  tbl: string;
  col: string | null;
  priv: string;
}

const REQUIRED: Held[] = SYNC_FAILURE_ALERT_ROLE_GRANTS.map(([tbl, col, priv]) => ({ tbl, col, priv }));

interface AlertFixture {
  login?: Record<string, unknown> | null;
  held?: Held[];
  memberOfRole?: boolean;
}

function alertPool(f: AlertFixture = {}): Pool {
  const login =
    f.login === undefined
      ? {
          role_name: "sync_failure_alert",
          session_role: "sync_failure_alert",
          is_superuser: false,
          bypass_rls: false,
          ...DB_ID,
        }
      : f.login;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("pg_roles r") && sql.includes("rolsuper")) return { rows: login === null ? [] : [login] };
    if (sql.includes("pg_auth_members")) return { rows: [{ member_of_role: f.memberOfRole ?? false }] };
    return { rows: f.held ?? REQUIRED };
  });
  return { query } as unknown as Pool;
}

function domainPool(roleName = "app_domain", id: Partial<typeof DB_ID> = {}): Pool {
  const query = jest.fn(async () => ({ rows: [{ role_name: roleName, ...DB_ID, ...id }] }));
  return { query } as unknown as Pool;
}

describe("SYNC_FAILURE_ALERT_ROLE_GRANTS", () => {
  it("grants no write on posting, reconciliation or sales tables and no DELETE or TRUNCATE anywhere", () => {
    for (const [tbl, , priv] of SYNC_FAILURE_ALERT_ROLE_GRANTS) {
      expect(["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]).not.toContain(priv);
      if (priv === "INSERT" || priv === "UPDATE") {
        expect([
          "audit_events",
          "sync_failure_alert_windows",
          "sync_failure_alert_deliveries",
        ]).toContain(tbl);
      }
    }
  });

  it("reads users only through the id, email and deleted_at columns", () => {
    expect(SYNC_FAILURE_ALERT_ROLE_GRANTS.filter(([tbl]) => tbl === "users")).toEqual([
      ["users", "id", "SELECT"],
      ["users", "email", "SELECT"],
      ["users", "deleted_at", "SELECT"],
    ]);
  });
});

describe("diffSyncFailureAlertGrants", () => {
  it("is empty for exactly the required grants", () => {
    expect(diffSyncFailureAlertGrants(REQUIRED)).toEqual({ missing: [], extra: [] });
  });

  it("names a missing grant", () => {
    const held = REQUIRED.filter((h) => !(h.tbl === "sales" && h.priv === "SELECT"));
    expect(diffSyncFailureAlertGrants(held)).toEqual({ missing: ["SELECT ON sales"], extra: [] });
  });

  it("names a column grant that is missing", () => {
    const held = REQUIRED.filter((h) => h.col !== "email");
    expect(diffSyncFailureAlertGrants(held).missing).toEqual(["SELECT ON users (email)"]);
  });

  it("names an extra grant", () => {
    const held = [...REQUIRED, { tbl: "erpnext_posting_status", col: null, priv: "UPDATE" }];
    expect(diffSyncFailureAlertGrants(held)).toEqual({
      missing: [],
      extra: ["UPDATE ON erpnext_posting_status"],
    });
  });
});

describe("verifySyncFailureAlertRole", () => {
  it("accepts a distinct role holding exactly the required grants", async () => {
    await expect(verifySyncFailureAlertRole(alertPool(), domainPool())).resolves.toBeUndefined();
  });

  it("rejects when the role cannot be resolved", async () => {
    await expect(verifySyncFailureAlertRole(alertPool({ login: null }), domainPool())).rejects.toThrow(
      /SYNC_FAILURE_ALERT_DATABASE_URL role could not be resolved/,
    );
  });

  it.each([
    ["a superuser", { is_superuser: true }],
    ["a BYPASSRLS role", { bypass_rls: true }],
  ])("rejects %s", async (_name, patch) => {
    const login = {
      role_name: "sync_failure_alert",
      session_role: "sync_failure_alert",
      is_superuser: false,
      bypass_rls: false,
      ...DB_ID,
      ...patch,
    };
    await expect(verifySyncFailureAlertRole(alertPool({ login }), domainPool())).rejects.toThrow(
      /must be non-superuser and must not have BYPASSRLS/,
    );
  });

  it("rejects a session that only switched to the role (session_user differs)", async () => {
    const login = {
      role_name: "sync_failure_alert",
      session_role: "postgres",
      is_superuser: false,
      bypass_rls: false,
      ...DB_ID,
    };
    await expect(verifySyncFailureAlertRole(alertPool({ login }), domainPool())).rejects.toThrow(
      /must log in as itself/,
    );
  });

  it.each([
    ["another database on the same server", { db_name: "rt_staging", db_oid: "16999" }],
    ["the same database name on another server", { server_started: "1759300000" }],
  ])("rejects a URL pointing at %s", async (_name, id) => {
    await expect(verifySyncFailureAlertRole(alertPool(), domainPool("app_domain", id))).rejects.toThrow(
      /must connect to the same database as DATABASE_URL/,
    );
  });

  it("rejects the same role as DATABASE_URL", async () => {
    await expect(verifySyncFailureAlertRole(alertPool(), domainPool("sync_failure_alert"))).rejects.toThrow(
      /must be a different role from DATABASE_URL/,
    );
  });

  it("rejects a role missing a required grant, naming it", async () => {
    const held = REQUIRED.filter((h) => !(h.tbl === "sync_failure_alert_windows" && h.priv === "UPDATE"));
    await expect(verifySyncFailureAlertRole(alertPool({ held }), domainPool())).rejects.toThrow(
      /is missing required grants: UPDATE ON sync_failure_alert_windows$/,
    );
  });

  it.each([
    ["UPDATE ON erpnext_posting_status", { tbl: "erpnext_posting_status", col: null, priv: "UPDATE" }],
    ["INSERT ON sales", { tbl: "sales", col: null, priv: "INSERT" }],
    ["DELETE ON sync_failure_alert_windows", { tbl: "sync_failure_alert_windows", col: null, priv: "DELETE" }],
    ["TRUNCATE ON sync_failure_alert_deliveries", { tbl: "sync_failure_alert_deliveries", col: null, priv: "TRUNCATE" }],
    ["SELECT ON users", { tbl: "users", col: null, priv: "SELECT" }],
    ["SELECT ON users (password_hash)", { tbl: "users", col: "password_hash", priv: "SELECT" }],
    ["UPDATE ON audit_events", { tbl: "audit_events", col: null, priv: "UPDATE" }],
    ["USAGE ON some_sequence", { tbl: "some_sequence", col: null, priv: "USAGE" }],
  ])("refuses an extra grant: %s", async (label, extra) => {
    await expect(
      verifySyncFailureAlertRole(alertPool({ held: [...REQUIRED, extra] }), domainPool()),
    ).rejects.toThrow(new RegExp(`holds privileges beyond the sync-failure alert grants: .*${label.replace(/[()]/g, "\\$&")}`));
  });

  it("rejects a role that is a member of any role", async () => {
    await expect(
      verifySyncFailureAlertRole(alertPool({ memberOfRole: true }), domainPool()),
    ).rejects.toThrow(/must be a member of no role/);
  });
});

describe("SyncFailureAlertRoleVerifier", () => {
  const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
  const ORIGINAL_VERIFY = process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
  const badAlert = (): Pool =>
    alertPool({ held: [...REQUIRED, { tbl: "sales", col: null, priv: "UPDATE" }] });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VERIFY === undefined) delete process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
    else process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = ORIGINAL_VERIFY;
  });

  it("fails boot in production when the alert role holds an extra grant", async () => {
    process.env["NODE_ENV"] = "production";
    const verifier = new SyncFailureAlertRoleVerifier(
      new AuditDbPool(domainPool()),
      new SyncFailureAlertDbPool(badAlert(), true),
    );
    await expect(verifier.onModuleInit()).rejects.toThrow(/UPDATE ON sales/);
  });

  it("runs outside production when VERIFY_DATABASE_POOL_BOUNDARY=1", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["VERIFY_DATABASE_POOL_BOUNDARY"] = "1";
    const verifier = new SyncFailureAlertRoleVerifier(
      new AuditDbPool(domainPool()),
      new SyncFailureAlertDbPool(badAlert(), true),
    );
    await expect(verifier.onModuleInit()).rejects.toThrow(/UPDATE ON sales/);
  });

  it("does not check a borrowed domain pool (the dedicated URL is not configured)", async () => {
    process.env["NODE_ENV"] = "production";
    const domain = domainPool();
    await expect(
      new SyncFailureAlertRoleVerifier(
        new AuditDbPool(domain),
        new SyncFailureAlertDbPool(domain, false),
      ).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(domain.query).not.toHaveBeenCalled();
  });

  it("does not query outside production without the opt-in", async () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["VERIFY_DATABASE_POOL_BOUNDARY"];
    const pool = badAlert();
    await new SyncFailureAlertRoleVerifier(
      new AuditDbPool(domainPool()),
      new SyncFailureAlertDbPool(pool, true),
    ).onModuleInit();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips the no-DB path", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(
      new SyncFailureAlertRoleVerifier(
        new AuditDbPool(null),
        new SyncFailureAlertDbPool(null, false),
      ).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
