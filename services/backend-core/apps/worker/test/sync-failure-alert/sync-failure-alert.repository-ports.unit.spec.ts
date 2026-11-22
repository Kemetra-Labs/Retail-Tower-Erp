/**
 * RT-1525 — how PgSyncFailureAlertRepository composes the worker ports (tenants, catalog, stores,
 * memberships, auth), on a fake pool, without a database. It pins what the old single statements did:
 * a deleted store's failures are dropped and the catalog order (store, then condition) is kept; a
 * condition is present only for a live store; the recipient rule runs first, and the address read only
 * for the users it admits. The database itself is covered by sync-failure-alert.integration.spec.ts.
 */
import type { Pool } from "pg";

import { PgSyncFailureAlertRepository } from "../../src/sync-failure-alert/sync-failure-alert.repository";

const TENANT = "01890000-0000-7000-8000-00000000000a";
const STORE_A = "01890000-0000-7000-8000-0000000000a0";
const STORE_B = "01890000-0000-7000-8000-0000000000b0";
const STORE_C = "01890000-0000-7000-8000-0000000000c0";
const USER_1 = "01890000-0000-7000-8000-000000000001";
const USER_2 = "01890000-0000-7000-8000-000000000002";

type Answer = { rows: Record<string, unknown>[]; rowCount?: number };
type Rule = { match: RegExp; answer: (params: unknown[]) => Answer };

/** A pool whose one client answers each statement by the first rule that matches its SQL, and records it. */
function fakePool(rules: Rule[]): { pool: Pool; statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: text, params });
      const rule = rules.find((r) => r.match.test(text));
      const a = rule ? rule.answer(params) : { rows: [] };
      return { rows: a.rows, rowCount: a.rowCount ?? a.rows.length };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const ACTIVE_TENANT: Rule = { match: /FROM tenants WHERE id = \$1 AND status = 'active'/, answer: () => ({ rows: [{ x: 1 }] }) };
const domain = (statements: Array<{ sql: string }>, re: RegExp) => statements.filter((s) => re.test(s.sql));

describe("PgSyncFailureAlertRepository composes the worker ports (RT-1525)", () => {
  it("observeConditions drops a deleted store's failures and keeps catalog's store-then-condition order", async () => {
    const { pool, statements } = fakePool([
      ACTIVE_TENANT,
      {
        match: /FROM erpnext_posting_status s WHERE s\.tenant_id = \$1 AND s\.status = 'permanently_rejected' GROUP BY/,
        answer: () => ({
          rows: [
            { store_id: STORE_A, condition_key: "posting_permanently_rejected", failure_count: 2 },
            { store_id: STORE_A, condition_key: "sale_failed_needs_repair", failure_count: 1 },
            { store_id: STORE_B, condition_key: "sale_failed_needs_repair", failure_count: 4 },
            { store_id: STORE_C, condition_key: "posting_permanently_rejected", failure_count: 3 },
          ],
        }),
      },
      // STORE_B is deleted: stores returns only the live ones.
      { match: /FROM stores WHERE tenant_id = \$1 AND id = ANY/, answer: () => ({ rows: [{ id: STORE_C, name: "C" }, { id: STORE_A, name: "A" }] }) },
    ]);
    const observed = await new PgSyncFailureAlertRepository(pool).observeConditions(TENANT);
    expect(observed).toEqual([
      { storeId: STORE_A, storeName: "A", condition: "posting_permanently_rejected", failureCount: 2 },
      { storeId: STORE_A, storeName: "A", condition: "sale_failed_needs_repair", failureCount: 1 },
      { storeId: STORE_C, storeName: "C", condition: "posting_permanently_rejected", failureCount: 3 },
    ]);
    // One stores read, for the distinct ids, in the tenant's transaction.
    const storeReads = domain(statements, /FROM stores/);
    expect(storeReads).toHaveLength(1);
    expect(storeReads[0]!.params).toEqual([TENANT, [STORE_A, STORE_B, STORE_C]]);
  });

  it("observeConditions returns null for an inactive tenant and reads no failure state", async () => {
    const { pool, statements } = fakePool([{ match: /FROM tenants WHERE id = \$1/, answer: () => ({ rows: [], rowCount: 0 }) }]);
    expect(await new PgSyncFailureAlertRepository(pool).observeConditions(TENANT)).toBeNull();
    expect(domain(statements, /erpnext_posting_status|FROM sales|FROM stores/)).toEqual([]);
  });

  it("listRecipients reads addresses only for the users the memberships rule admits, ordered by user id", async () => {
    const { pool, statements } = fakePool([
      { match: /FROM memberships m JOIN roles r/, answer: () => ({ rows: [{ user_id: USER_2 }, { user_id: USER_1 }] }) },
      {
        match: /FROM users u WHERE u\.id = ANY/,
        answer: () => ({ rows: [{ user_id: USER_1, email: "one@example.invalid" }, { user_id: USER_2, email: "two@example.invalid" }] }),
      },
    ]);
    const recipients = await new PgSyncFailureAlertRepository(pool).listRecipients(TENANT, STORE_A);
    expect(recipients).toEqual([
      { userId: USER_1, email: "one@example.invalid" },
      { userId: USER_2, email: "two@example.invalid" },
    ]);
    expect(domain(statements, /FROM memberships/)[0]!.params).toEqual([TENANT, STORE_A]);
    expect(domain(statements, /FROM users/)[0]!.params).toEqual([[USER_2, USER_1]]);
  });

  it("listRecipients with nobody admitted reads no users", async () => {
    const { pool, statements } = fakePool([{ match: /FROM memberships m JOIN roles r/, answer: () => ({ rows: [] }) }]);
    expect(await new PgSyncFailureAlertRepository(pool).listRecipients(TENANT, STORE_A)).toEqual([]);
    expect(domain(statements, /FROM users/)).toEqual([]);
  });

  it("authorizedEmail checks the one user against the rule, then returns their live address or null", async () => {
    const admitted = fakePool([
      { match: /FROM memberships m JOIN roles r .* AND m\.user_id = \$3$/, answer: () => ({ rows: [{ user_id: USER_1 }] }) },
      { match: /FROM users u WHERE u\.id = ANY/, answer: () => ({ rows: [{ user_id: USER_1, email: "one@example.invalid" }] }) },
    ]);
    expect(await new PgSyncFailureAlertRepository(admitted.pool).authorizedEmail(TENANT, STORE_A, USER_1)).toBe("one@example.invalid");
    expect(domain(admitted.statements, /FROM memberships/)[0]!.params).toEqual([TENANT, STORE_A, USER_1]);

    const revoked = fakePool([{ match: /FROM memberships m JOIN roles r/, answer: () => ({ rows: [] }) }]);
    expect(await new PgSyncFailureAlertRepository(revoked.pool).authorizedEmail(TENANT, STORE_A, USER_1)).toBeNull();
    expect(domain(revoked.statements, /FROM users/)).toEqual([]);

    const deletedUser = fakePool([
      { match: /FROM memberships m JOIN roles r/, answer: () => ({ rows: [{ user_id: USER_1 }] }) },
      { match: /FROM users u WHERE u\.id = ANY/, answer: () => ({ rows: [] }) },
    ]);
    expect(await new PgSyncFailureAlertRepository(deletedUser.pool).authorizedEmail(TENANT, STORE_A, USER_1)).toBeNull();
  });

  describe("a cleared window closes only when its condition is gone for a live store", () => {
    const OPEN_WINDOW: Rule = {
      match: /SELECT id, store_id, condition_key FROM sync_failure_alert_windows WHERE tenant_id = \$1 AND cleared_at IS NULL/,
      answer: () => ({ rows: [{ id: "w1", store_id: STORE_A, condition_key: "sale_failed_needs_repair" }] }),
    };
    const CLOSE: Rule = { match: /UPDATE sync_failure_alert_windows SET cleared_at/, answer: () => ({ rows: [], rowCount: 1 }) };
    const failurePresent = (present: boolean): Rule => ({
      match: /SELECT 1 FROM sales sa WHERE sa\.tenant_id = \$1 AND sa\.store_id = \$2/,
      answer: () => ({ rows: present ? [{ x: 1 }] : [], rowCount: present ? 1 : 0 }),
    });
    const storeLive = (live: boolean): Rule => ({
      match: /FROM stores WHERE tenant_id = \$1 AND id = ANY/,
      answer: () => ({ rows: live ? [{ id: STORE_A, name: "A" }] : [] }),
    });
    const run = async (rules: Rule[]) => {
      const { pool, statements } = fakePool([OPEN_WINDOW, CLOSE, ...rules]);
      const result = await new PgSyncFailureAlertRepository(pool).reconcileWindows(TENANT, [], new Date("2026-11-22T10:00:00Z"));
      return { result, statements };
    };

    it("failures gone: closes, without reading stores", async () => {
      const { result, statements } = await run([failurePresent(false)]);
      expect(result.cleared).toBe(1);
      expect(domain(statements, /FROM stores/)).toEqual([]);
    });

    it("failures still there but the store is deleted: closes (the old JOIN stores ... deleted_at IS NULL)", async () => {
      const { result } = await run([failurePresent(true), storeLive(false)]);
      expect(result.cleared).toBe(1);
    });

    it("failures still there on a live store: the window stays open", async () => {
      const { result, statements } = await run([failurePresent(true), storeLive(true)]);
      expect(result.cleared).toBe(0);
      expect(domain(statements, /UPDATE sync_failure_alert_windows SET cleared_at/)).toEqual([]);
    });
  });
});
