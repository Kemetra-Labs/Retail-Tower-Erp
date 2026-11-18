/**
 * RT-1453: the `device-health` store-devices port (DB-less, a recording fake client).
 *
 * Store deletion asks this port for the devices of a store with their last stored sale queue. It must
 * read on the caller's client over the fleet-health read model, scoped by tenant and store, in id order,
 * and map a till's queue to `null` (unknown, never zero) when it has no stored beat or a NULL counter.
 */
import type { PoolClient } from "pg";

import { readStoreDeviceFacts } from "../../src/device-health";

const TENANT = "0e170000-0000-4000-8000-0000000a0001";
const STORE = "0e170000-0000-4000-8000-0000000a5001";
const BEAT = new Date("2026-11-16T08:20:00Z");

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    device_id: "d-1",
    store_id: STORE,
    label: "till-1",
    trust_state: "active",
    heartbeat_at: BEAT,
    sale_queue_pending: 0,
    sale_queue_dead_letter: 0,
    sale_queue_held: 0,
    ...overrides,
  };
}

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

describe("readStoreDeviceFacts", () => {
  it("reads one statement on the caller's client: the fleet-health model, tenant and store bound, by id", async () => {
    const f = fakeClient([]);
    await readStoreDeviceFacts(f.client, { tenantId: TENANT, storeId: STORE });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.params).toEqual([TENANT, STORE]);
    expect(f.calls[0]!.sql).toMatch(/LEFT JOIN device_health h ON h\.device_id = d\.id AND h\.tenant_id = d\.tenant_id/);
    expect(f.calls[0]!.sql).toMatch(/WHERE d\.tenant_id = \$1::uuid AND d\.store_id = \$2::uuid\s+ORDER BY d\.id/);
    expect(f.calls[0]!.sql).not.toMatch(/retired_at IS NULL/i); // retired tills are facts too (the audit counts them)
  });

  it("maps identity, trust state, last beat and the stored queue", async () => {
    const f = fakeClient([row({ device_id: "d-1", sale_queue_pending: 2, sale_queue_dead_letter: 1, sale_queue_held: 0 })]);
    const [fact] = await readStoreDeviceFacts(f.client, { tenantId: TENANT, storeId: STORE });
    expect(fact).toEqual({
      deviceId: "d-1",
      label: "till-1",
      trustState: "active",
      lastSeenAt: BEAT,
      queue: { pending: 2, deadLetter: 1, held: 0 },
    });
  });

  it("a queue is unknown (null), never zero: no stored beat, or any NULL counter", async () => {
    const f = fakeClient([
      row({ device_id: "no-beat", heartbeat_at: null, sale_queue_pending: null, sale_queue_dead_letter: null, sale_queue_held: null }),
      row({ device_id: "null-pending", sale_queue_pending: null }),
      row({ device_id: "null-dead", sale_queue_dead_letter: null }),
      row({ device_id: "null-held", sale_queue_held: null }),
      row({ device_id: "zero" }),
    ]);
    const facts = await readStoreDeviceFacts(f.client, { tenantId: TENANT, storeId: STORE });
    expect(facts.map((d) => [d.deviceId, d.queue])).toEqual([
      ["no-beat", null],
      ["null-pending", null],
      ["null-dead", null],
      ["null-held", null],
      ["zero", { pending: 0, deadLetter: 0, held: 0 }],
    ]);
    expect(facts[0]!.lastSeenAt).toBeNull();
  });

  it("carries a retired and a revoked till's trust state through", async () => {
    const f = fakeClient([row({ device_id: "r", trust_state: "retired" }), row({ device_id: "v", trust_state: "revoked" })]);
    const facts = await readStoreDeviceFacts(f.client, { tenantId: TENANT, storeId: STORE });
    expect(facts.map((d) => d.trustState)).toEqual(["retired", "revoked"]);
  });
});
