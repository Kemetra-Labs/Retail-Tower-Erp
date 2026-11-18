/**
 * RT-1453: the `catalog` store warehouse-refs port (DB-less, a recording fake client).
 *
 * Store deletion asks this port for the active ERPNext warehouse mappings of a store instead of naming
 * `erpnext_warehouse_map`. Active = not retired; by id; capped at the caller's limit.
 */
import type { PoolClient } from "pg";

import { listActiveWarehouseRefsOfStore } from "../../src/catalog";

const STORE = "0e170000-0000-4000-8000-0000000a5001";

describe("listActiveWarehouseRefsOfStore", () => {
  it("lists the warehouse refs of the store's non-retired mappings by id, capped", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ ref: "Stores - RT" }, { ref: "Returns - RT" }] };
      },
    } as unknown as PoolClient;
    await expect(listActiveWarehouseRefsOfStore(client, STORE, 50)).resolves.toEqual(["Stores - RT", "Returns - RT"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([STORE, 50]);
    expect(calls[0]!.sql).toMatch(/retired_at IS NULL ORDER BY id LIMIT \$2/);
  });
});
