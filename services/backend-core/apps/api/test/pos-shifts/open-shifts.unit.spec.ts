/**
 * RT-1453: the `pos-shifts` open-shifts port (DB-less, a recording fake client).
 *
 * Store deletion and the Console open-shifts list ask this port instead of querying `shifts`,
 * `users` and `devices` themselves. It must (a) read on the caller's client in the order the caller
 * asks for, (b) judge every shift with the one stuck verdict (`readVerdict`, Console rule: no caller
 * token) and derive `forceCloseEligible` from the contract's blockers, and (c) never run two
 * statements at once on one client.
 */
import type { PoolClient } from "pg";

import { countStoreOpenShifts, readStoreOpenShifts, STUCK_THRESHOLD_MINUTES } from "../../src/pos-shifts";

const TENANT = "0e170000-0000-4000-8000-0000000a0001";
const STORE = "0e170000-0000-4000-8000-0000000a5001";

function dbRow(n: number): Record<string, unknown> {
  return {
    shift_id: `0192f5a2-3b4c-7d8e-9f01-23456789ab0${n}`,
    tenant_id: TENANT,
    store_id: STORE,
    opening_device_id: `0e170000-0000-4000-8000-0000000e000${n}`,
    opening_cashier_user_id: `0e170000-0000-4000-8000-0000000c000${n}`,
    opened_at: new Date(`2026-11-16T0${n}:00:00Z`),
    lifecycle_state: "open",
    source: "cash_up",
    currency_code: "EGP",
    opening_float: "500.0000",
    received_at: null,
    opened_on_terminal_label: `till-${n}`,
    display_name: n === 1 ? "Cashier Cat" : null,
    last_seen_at: null,
    trust_state: "active",
  };
}

interface Recorded {
  sql: string;
  params: unknown[];
}

/** A fake client: the list statement returns `rows`; each verdict statement returns the next verdict. */
function fakeClient(rows: Record<string, unknown>[], verdicts: Array<{ stale: boolean; op: boolean; adm: boolean }>) {
  const calls: Recorded[] = [];
  let inFlight = 0;
  let overlapped = false;
  let verdictIndex = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      calls.push({ sql, params });
      await Promise.resolve();
      inFlight -= 1;
      if (/FROM shifts s/.test(sql)) return { rows };
      if (/count\(\*\)::int AS n FROM shifts/.test(sql)) return { rows: [{ n: 7 }] };
      const v = verdicts[verdictIndex++]!;
      return { rows: [{ stale: v.stale, live_operator_session: v.op, live_cashier_admission: v.adm }] };
    },
  } as unknown as PoolClient;
  return { client, calls, overlapped: () => overlapped };
}

describe("readStoreOpenShifts", () => {
  it("lists newest first or oldest first by a constant statement, with tenant, store and limit bound", async () => {
    const newest = fakeClient([], []);
    await readStoreOpenShifts(newest.client, { tenantId: TENANT, storeId: STORE }, { limit: 200, order: "newest_first" });
    const oldest = fakeClient([], []);
    await readStoreOpenShifts(oldest.client, { tenantId: TENANT, storeId: STORE }, { limit: 50, order: "oldest_first" });

    expect(newest.calls).toHaveLength(1);
    expect(newest.calls[0]!.sql).toMatch(/ORDER BY s\.opened_at DESC, s\.shift_id DESC\s+LIMIT \$3/);
    expect(newest.calls[0]!.params).toEqual([TENANT, STORE, 200]);
    expect(oldest.calls[0]!.sql).toMatch(/ORDER BY s\.opened_at, s\.shift_id\s+LIMIT \$3/);
    expect(oldest.calls[0]!.sql).not.toMatch(/DESC/);
    expect(oldest.calls[0]!.params).toEqual([TENANT, STORE, 50]);
    for (const c of [...newest.calls, ...oldest.calls]) expect(c.sql).toMatch(/s\.lifecycle_state = 'open'/);
  });

  it("returns each shift with the cashier, the terminal and the Console-rule verdict; eligible = no blocker", async () => {
    const f = fakeClient(
      [dbRow(1), dbRow(2), dbRow(3), dbRow(4)],
      [
        { stale: true, op: false, adm: false }, // stuck: eligible
        { stale: false, op: false, adm: false }, // not stale
        { stale: true, op: true, adm: false }, // live operator session
        { stale: true, op: false, adm: true }, // live cashier admission
      ],
    );
    const reads = await readStoreOpenShifts(f.client, { tenantId: TENANT, storeId: STORE }, { limit: 200, order: "oldest_first" });

    expect(reads.map((r) => r.forceCloseEligible)).toEqual([true, false, false, false]);
    expect(reads[0]).toMatchObject({
      cashierDisplayName: "Cashier Cat",
      terminal: { label: "till-1", lastSeenAt: null, trustState: "active" },
      verdict: { stale: true, liveOperatorSession: false, liveCashierAdmission: false },
      shift: { shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab01", storeId: STORE, openedOnTerminalLabel: "till-1", notCounted: false },
    });
    expect(reads[1]!.cashierDisplayName).toBeNull();

    // One verdict statement per shift, the Console rule: threshold bound, NO caller token ($5 null).
    const verdictCalls = f.calls.slice(1);
    expect(verdictCalls).toHaveLength(4);
    for (const c of verdictCalls) {
      expect(c.params[1]).toBe(STUCK_THRESHOLD_MINUTES);
      expect(c.params[4]).toBeNull();
    }
    expect(f.overlapped()).toBe(false);
  });

  it("takes the threshold from the caller when it gives one", async () => {
    const f = fakeClient([dbRow(1)], [{ stale: true, op: false, adm: false }]);
    await readStoreOpenShifts(f.client, { tenantId: TENANT, storeId: STORE }, { limit: 10, order: "newest_first", thresholdMinutes: 42 });
    expect(f.calls[1]!.params[1]).toBe(42);
  });

  it("fails closed when a verdict row is missing: not stale, live", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        return /FROM shifts s/.test(sql) ? { rows: [dbRow(1)] } : { rows: [] };
      },
    } as unknown as PoolClient;
    const [read] = await readStoreOpenShifts(client, { tenantId: TENANT, storeId: STORE }, { limit: 1, order: "oldest_first" });
    expect(read!.forceCloseEligible).toBe(false);
    expect(read!.verdict).toEqual({ stale: false, liveOperatorSession: true, liveCashierAdmission: true });
  });
});

describe("countStoreOpenShifts", () => {
  it("counts every open shift of the store with no row cap", async () => {
    const f = fakeClient([], []);
    await expect(countStoreOpenShifts(f.client, STORE)).resolves.toBe(7);
    expect(f.calls[0]!.params).toEqual([STORE]);
    expect(f.calls[0]!.sql).not.toMatch(/LIMIT/i);
  });
});
