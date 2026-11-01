import type {
  MoneyFacts,
  SalesByStore,
  StoreDay,
  StoreSalesByStore,
} from "@/lib/sales-by-store-queries";

/**
 * RT-1054 sales-by-store payloads, typed against the generated contract. Every
 * figure is a string the "server" served: tests assert the page prints it, and
 * never that it computed anything.
 */

export const MAADI = "0190f000-0000-7000-8000-0000000007a1";
export const NASR = "0190f000-0000-7000-8000-0000000007a2";
export const ZAMALEK = "0190f000-0000-7000-8000-0000000007a3";
export const AS_OF = "2026-10-23T09:15:00Z";
export const FROM = "2026-10-21";
export const TO = "2026-10-23";

export function facts(count: number, lines: [string, number, string][] = []): MoneyFacts {
  return {
    count,
    byCurrency: lines.map(([currencyCode, n, total]) => ({ currencyCode, count: n, total })),
  };
}

export const NO_FACTS = facts(0);

function days(
  totals: [string, string, string],
  state: [StoreDay["state"], StoreDay["state"], StoreDay["state"]] = [
    "complete",
    "complete",
    "so_far",
  ],
): StoreDay[] {
  return [FROM, "2026-10-22", TO].map((businessDate, i) => ({
    businessDate,
    state: state[i],
    count: totals[i] === "0.0000" ? 0 : 3,
    total: totals[i],
  }));
}

type StoreOver = Partial<StoreSalesByStore>;

export function maadi(over: StoreOver = {}): StoreSalesByStore {
  return {
    storeRef: MAADI,
    storeName: "Maadi Branch",
    storeStatus: "active",
    storeTimezone: "Africa/Cairo",
    currentBusinessDate: TO,
    rank: 1,
    baselineRank: 1,
    facts: {
      receivedSales: facts(1388, [
        ["EGP", 1388, "512640.2500"],
        ["USD", 2, "120.0000"],
      ]),
      returns: facts(28, [["EGP", 28, "9100.0000"]]),
      voids: facts(17, [["EGP", 17, "4200.5000"]]),
      legacyRefunds: facts(1, [["EGP", 1, "250.0000"]]),
    },
    ranking: {
      total: "512640.2500",
      count: 1388,
      share: "0.3463",
      averageSale: "369.3372",
      baselineTotal: "486210.4000",
      deltaRatio: "0.0544",
      bestDay: { businessDate: "2026-10-22", total: "200000.0000" },
      days: days(["150000.0000", "200000.0000", "162640.2500"]),
    },
    ...over,
  };
}

export function nasr(over: StoreOver = {}): StoreSalesByStore {
  return {
    storeRef: NASR,
    storeName: "Nasr City Branch",
    storeStatus: "active",
    storeTimezone: "Africa/Cairo",
    currentBusinessDate: TO,
    rank: 2,
    baselineRank: 3,
    facts: {
      receivedSales: facts(1162, [["EGP", 1162, "431905.5000"]]),
      returns: facts(23, [["EGP", 23, "5000.0000"]]),
      voids: NO_FACTS,
      legacyRefunds: NO_FACTS,
    },
    ranking: {
      total: "431905.5000",
      count: 1162,
      share: "0.2918",
      averageSale: "371.6967",
      baselineTotal: "389870.1000",
      deltaRatio: "-0.1077",
      bestDay: { businessDate: FROM, total: "180000.0000" },
      days: days(["180000.0000", "100000.0000", "151905.5000"]),
    },
    ...over,
  };
}

export function zamalek(over: StoreOver = {}): StoreSalesByStore {
  return {
    storeRef: ZAMALEK,
    storeName: "Zamalek Branch",
    storeStatus: "inactive",
    storeTimezone: "Africa/Cairo",
    currentBusinessDate: TO,
    rank: null,
    baselineRank: null,
    facts: { receivedSales: NO_FACTS, returns: NO_FACTS, voids: NO_FACTS, legacyRefunds: NO_FACTS },
    ranking: {
      total: "0.0000",
      count: 0,
      share: "0.0000",
      averageSale: null,
      baselineTotal: "0.0000",
      deltaRatio: null,
      bestDay: null,
      days: days(["0.0000", "0.0000", "0.0000"]),
    },
    ...over,
  };
}

export function report(over: Partial<SalesByStore> = {}): SalesByStore {
  const stores = over.stores ?? [maadi(), nasr(), zamalek()];
  return {
    from: FROM,
    to: TO,
    currency: "EGP",
    compare: "previous_period",
    asOf: AS_OF,
    completeness: "received_only",
    baseline: { rule: "previous_equal_length", from: "2026-10-18", to: "2026-10-20", dayCount: 3 },
    rankable: stores.length > 1,
    storeCount: stores.length,
    storesWithoutSales: stores.filter((s) => s.rank === null).length,
    rangeTotals: {
      receivedSales: facts(2550, [
        ["EGP", 2550, "944545.7500"],
        ["USD", 2, "120.0000"],
      ]),
      returns: facts(51, [["EGP", 51, "14100.0000"]]),
      voids: facts(17, [["EGP", 17, "4200.5000"]]),
      legacyRefunds: facts(1, [["EGP", 1, "250.0000"]]),
    },
    days: [FROM, "2026-10-22", TO].map((businessDate) => ({
      businessDate,
      facts: {
        receivedSales: NO_FACTS,
        returns: NO_FACTS,
        voids: NO_FACTS,
        legacyRefunds: NO_FACTS,
      },
    })),
    stores,
    ...over,
  };
}

export function failure(status: number, code = "system_failure", requestId = "req-7") {
  return { status, error: { error: { code, message: "x", request_id: requestId } } };
}
