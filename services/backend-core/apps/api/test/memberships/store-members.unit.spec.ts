/**
 * RT-1453: the `memberships` store-members port (DB-less, a recording fake client).
 *
 * Store deletion asks this port which live memberships with specific access reach a store, with their
 * role and every store they reach; "only store" is decided by the caller. One statement, bound to the
 * store, by user id, no row cap.
 */
import type { PoolClient } from "pg";

import { listSpecificAccessMembersOfStore } from "../../src/memberships";

const STORE = "0e170000-0000-4000-8000-0000000a5001";

describe("listSpecificAccessMembersOfStore", () => {
  it("reads one statement bound to the store: live, specific access, by user id, no cap", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return {
          rows: [
            { user_id: "u-1", role_code: "store_manager", store_ids: [STORE] },
            { user_id: "u-2", role_code: "cashier", store_ids: [STORE, "s-2"] },
          ],
        };
      },
    } as unknown as PoolClient;

    const members = await listSpecificAccessMembersOfStore(client, STORE);

    expect(members).toEqual([
      { userId: "u-1", roleCode: "store_manager", storeIds: [STORE] },
      { userId: "u-2", roleCode: "cashier", storeIds: [STORE, "s-2"] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([STORE]);
    expect(calls[0]!.sql).toMatch(/m\.deleted_at IS NULL/);
    expect(calls[0]!.sql).toMatch(/m\.store_access_kind = 'specific'/);
    expect(calls[0]!.sql).toMatch(/ORDER BY m\.user_id/);
    expect(calls[0]!.sql).not.toMatch(/LIMIT/i);
  });
});
