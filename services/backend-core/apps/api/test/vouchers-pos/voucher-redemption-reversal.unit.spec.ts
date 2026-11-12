/**
 * RT-1343 (items 1 and 3) — the shared reversal helper and the void's loop over
 * the sale's voucher tenders, on a scripted client (no database): the statement
 * ORDER is the contract here (voucher lock, then redemption lock, then the
 * consumed check as its own statement, then the writes). The database proof is
 * `vouchers-pos.http.integration.spec.ts` and `void-voucher-tender.spec.ts`.
 */
import type { PoolClient } from "pg";

import { reverseVoucherTendersOfVoidedSale } from "../../src/catalog/sales/sale-void-vouchers";
import { reverseRedemptionInTx, type RedemptionRow } from "../../src/vouchers-pos/voucher-redemption-reversal";
import { VoucherRefusal } from "../../src/vouchers-pos/vouchers-pos.errors";
import {
  LOCK_REDEMPTION_SQL,
  LOCK_VOUCHER_SQL,
  REDEMPTION_CONSUMED_BY_SALE_SQL,
  REDEMPTION_SQL,
  RESTORE_VOUCHER_SQL,
  REVERSE_REDEMPTION_SQL,
} from "../../src/vouchers-pos/vouchers-pos.queries";

const TENANT = "0a134300-0000-4000-8000-000000000001";
const STORE = "0a134300-0000-4000-8000-000000000002";
const DEVICE = "0a134300-0000-4000-8000-000000000003";
const CASHIER = "0a134300-0000-4000-8000-000000000004";
const SALE = "0a134300-0000-4000-8000-000000000005";
const R1 = "0a134300-0000-4000-8000-0000000000e1";
const R2 = "0a134300-0000-4000-8000-0000000000e2";
const REVERSED_AT = new Date("2026-11-12T10:00:00.000Z");

const redemptionRow = (id: string, extra: Partial<RedemptionRow> = {}): RedemptionRow => ({
  id,
  store_id: STORE,
  voucher_id: `voucher-of-${id}`,
  payment_attempt_id: "attempt",
  operator_user_id: CASHIER,
  applied_amount_minor: "1000",
  reversed_at: null,
  ...extra,
});

interface Script {
  readonly redemptions: Readonly<Record<string, Partial<RedemptionRow>>>;
  readonly consumed?: boolean;
  readonly restoredRows?: number;
  readonly tenderRedemptions?: readonly string[];
}

interface Call {
  readonly label: string;
  readonly params: ReadonlyArray<unknown>;
}

/** A client that answers each statement of the helper and records the order. */
function scriptedClient(script: Script): { client: PoolClient; calls: Call[] } {
  const calls: Call[] = [];
  const row = (id: unknown): RedemptionRow => redemptionRow(String(id), script.redemptions[String(id)] ?? {});
  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    const record = (label: string) => calls.push({ label, params });
    if (sql === REDEMPTION_SQL) return record("read"), { rows: [row(params[1])], rowCount: 1 };
    if (sql === LOCK_VOUCHER_SQL) return record("lock-voucher"), { rows: [{ id: params[1] }], rowCount: 1 };
    if (sql === LOCK_REDEMPTION_SQL) return record("lock-redemption"), { rows: [row(params[1])], rowCount: 1 };
    if (sql === REDEMPTION_CONSUMED_BY_SALE_SQL) {
      return record("consumed-check"), { rows: [{ consumed: script.consumed === true }], rowCount: 1 };
    }
    if (sql === REVERSE_REDEMPTION_SQL) return record("reverse"), { rows: [{ reversed_at: REVERSED_AT }], rowCount: 1 };
    if (sql === RESTORE_VOUCHER_SQL) return record("restore"), { rows: [], rowCount: script.restoredRows ?? 1 };
    if (/INSERT INTO audit_events/.test(sql)) return record("audit"), { rows: [], rowCount: 1 };
    if (/FROM sale_tenders/.test(sql)) {
      return record("tenders"), { rows: (script.tenderRedemptions ?? []).map((redemption_id) => ({ redemption_id })), rowCount: 0 };
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
  return { client: { query } as unknown as PoolClient, calls };
}

const input = (redemptionId: string, extra: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  storeId: STORE,
  deviceId: DEVICE,
  requestId: null,
  redemptionId,
  ...extra,
});

describe("reverseRedemptionInTx (RT-1343 item 1)", () => {
  it("locks the voucher, then the redemption, then checks consumption as its own statement, then writes", async () => {
    const { client, calls } = scriptedClient({ redemptions: {} });
    const done = await reverseRedemptionInTx(client, input(R1));
    expect(calls.map((c) => c.label)).toEqual([
      "read",
      "lock-voucher",
      "lock-redemption",
      "consumed-check",
      "reverse",
      "restore",
      "audit",
    ]);
    expect(done).toEqual({ redemptionId: R1, reversedAt: REVERSED_AT, alreadyReversed: false });
    // No allowed sale: the check is told NULL.
    expect(calls.find((c) => c.label === "consumed-check")!.params).toEqual([TENANT, R1, null]);
  });

  it("returns the original reversed_at before the consumed check when it is already reversed (a POS retry after a void)", async () => {
    const original = new Date("2026-11-12T09:00:00.000Z");
    const { client, calls } = scriptedClient({ redemptions: { [R1]: { reversed_at: original } }, consumed: true });
    const done = await reverseRedemptionInTx(client, input(R1));
    expect(done).toEqual({ redemptionId: R1, reversedAt: original, alreadyReversed: true });
    expect(calls.map((c) => c.label)).toEqual(["read", "lock-voucher", "lock-redemption"]);
  });

  it("refuses redemption_consumed_by_sale when another sale's tender pays with it, and changes nothing", async () => {
    const { client, calls } = scriptedClient({ redemptions: {}, consumed: true });
    const err = await reverseRedemptionInTx(client, input(R1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoucherRefusal);
    expect((err as VoucherRefusal).code).toBe("redemption_consumed_by_sale");
    expect(calls.map((c) => c.label)).toEqual(["read", "lock-voucher", "lock-redemption", "consumed-check"]);
  });

  it("passes the voiding sale so its own tender does not block the reverse", async () => {
    const { client, calls } = scriptedClient({ redemptions: {}, consumed: false });
    await reverseRedemptionInTx(client, input(R1, { allowConsumingSaleId: SALE }));
    expect(calls.find((c) => c.label === "consumed-check")!.params).toEqual([TENANT, R1, SALE]);
    const audit = calls.find((c) => c.label === "audit")!;
    expect(JSON.parse(String(audit.params[7]))).toMatchObject({ redemption_id: R1, reversed_by_device_id: DEVICE, sale_id: SALE });
  });

  it("refuses another store before taking any lock", async () => {
    const { client, calls } = scriptedClient({ redemptions: { [R1]: { store_id: "0a134300-0000-4000-8000-0000000000ff" } } });
    const err = await reverseRedemptionInTx(client, input(R1)).catch((e: unknown) => e);
    expect((err as VoucherRefusal).code).toBe("redemption_branch_mismatch");
    expect(calls.map((c) => c.label)).toEqual(["read"]);
  });

  it("fails closed with a plain Error when the voucher of an open redemption is not redeemed", async () => {
    const { client } = scriptedClient({ redemptions: {}, restoredRows: 0 });
    const err = await reverseRedemptionInTx(client, input(R1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VoucherRefusal);
  });
});

describe("reverseVoucherTendersOfVoidedSale (RT-1343 item 3)", () => {
  it("reverses each voucher tender's redemption in redemption-id order, allowing only the voided sale's own tender", async () => {
    const { client, calls } = scriptedClient({ redemptions: {}, tenderRedemptions: [R1, R2] });
    const reversed = await reverseVoucherTendersOfVoidedSale(client, {
      tenantId: TENANT,
      storeId: STORE,
      saleId: SALE,
      deviceId: DEVICE,
      requestId: null,
    });
    expect(reversed).toBe(2);
    expect(calls.filter((c) => c.label === "reverse").map((c) => c.params[1])).toEqual([R1, R2]);
    for (const c of calls.filter((x) => x.label === "consumed-check")) expect(c.params[2]).toBe(SALE);
    expect(calls[0]!.label).toBe("tenders");
  });

  it("counts only the redemptions it reversed now (one already reversed is left alone)", async () => {
    const { client } = scriptedClient({
      redemptions: { [R2]: { reversed_at: new Date("2026-11-12T09:00:00.000Z") } },
      tenderRedemptions: [R1, R2],
    });
    const reversed = await reverseVoucherTendersOfVoidedSale(client, {
      tenantId: TENANT,
      storeId: STORE,
      saleId: SALE,
      deviceId: DEVICE,
      requestId: null,
    });
    expect(reversed).toBe(1);
  });

  it("does nothing for a sale without voucher tenders", async () => {
    const { client, calls } = scriptedClient({ redemptions: {}, tenderRedemptions: [] });
    const reversed = await reverseVoucherTendersOfVoidedSale(client, {
      tenantId: TENANT,
      storeId: STORE,
      saleId: SALE,
      deviceId: DEVICE,
      requestId: null,
    });
    expect(reversed).toBe(0);
    expect(calls.map((c) => c.label)).toEqual(["tenders"]);
  });
});
