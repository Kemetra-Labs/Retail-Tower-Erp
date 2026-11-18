/**
 * RT-1453: the `inventory` store Count Sessions port (DB-less, a recording fake client).
 *
 * Store deletion asks this port for the open Count Sessions of a store instead of naming `count_sessions`
 * and importing the open-state list. The guard count has no cap; the list is capped and by id.
 */
import type { PoolClient } from "pg";

import { countOpenCountSessionsOfStore, listOpenCountSessionsOfStore } from "../../src/inventory";
import { OPEN_COUNT_SESSION_STATES } from "../../src/inventory/count-sessions/count-sessions-setting.service";

const STORE = "0e170000-0000-4000-8000-0000000a5001";

function fakeClient(rows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

describe("countOpenCountSessionsOfStore", () => {
  it("counts every open session of the store, no row cap, with the one open-state list", async () => {
    const f = fakeClient([{ n: 7 }]);
    await expect(countOpenCountSessionsOfStore(f.client, STORE)).resolves.toBe(7);
    expect(f.calls[0]!.params).toEqual([STORE, OPEN_COUNT_SESSION_STATES]);
    expect(f.calls[0]!.sql).not.toMatch(/LIMIT/i);
  });

  it("is zero when the statement returns no row", async () => {
    await expect(countOpenCountSessionsOfStore(fakeClient([]).client, STORE)).resolves.toBe(0);
  });
});

describe("listOpenCountSessionsOfStore", () => {
  it("lists open sessions by id, capped, and names the session and its state", async () => {
    const f = fakeClient([
      { id: "s-1", state: "open" },
      { id: "s-2", state: "needs_attention" },
    ]);
    const list = await listOpenCountSessionsOfStore(f.client, STORE, 200);
    expect(list).toEqual([
      { sessionId: "s-1", status: "open" },
      { sessionId: "s-2", status: "needs_attention" },
    ]);
    expect(f.calls[0]!.params).toEqual([STORE, OPEN_COUNT_SESSION_STATES, 200]);
    expect(f.calls[0]!.sql).toMatch(/ORDER BY id LIMIT \$3/);
  });
});
