/**
 * RT-1053 — the console sales by store over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `RolesGuard`, `MembershipRepository`). Only cookie authentication is faked
 * (the RT-192 / RT-562 header pattern).
 *
 *   GET /api/v1/sales-by-store  consoleGetSalesByStore
 *
 * What this proves (RT-1053 acceptance):
 *   - the ranking in the chosen currency (D-4 / D-5): total, then count,
 *     then storeRef; unranked stores last; inactive and deleted stores in a
 *     tenant-wide scope with their status (D-6); `rankable: false` for one
 *     store (D-6b);
 *   - exact share, average, baseline total, delta and best day (D-10), and
 *     the baseline bounds for both `compare` values (D-2);
 *   - the per-store facts equal the RT-649 summary's range totals of that
 *     store (same business-date and timezone rules), and money is never added
 *     across currencies;
 *   - dense days with each store's own day state around today;
 *   - role and store scope, tenant isolation, the non-disclosing 404 and 401
 *     for every bearer; validation and the 500-store bound;
 *   - the audit event and its metadata, after a 200 only;
 *   - every 200 and error body validates against the contract schemas.
 *
 * Docker policy (`console-http-harness.ts`): HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { ValidateFunction } from "ajv";
import type request from "supertest";

import type { PgTestEnv } from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import {
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  DASHBOARD_TOKEN,
  DEVICE_TOKEN,
  OPERATOR_TOKEN,
  SES_ADMIN_EMPTY,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_PLATFORM,
  SES_STAFF,
} from "./__support__/console-sales-fixture";
import {
  insertSale,
  S_INACTIVE,
  SES_C_OWNER,
  STORE_C_EXTRA,
  TENANT_C,
} from "./__support__/console-sales-by-store-fixture";
import { seedConsoleSalesByStoreFixture } from "./__support__/console-sales-by-store-fixture";
import { expectValid, useConsoleHttpHarness, type Query } from "./__support__/console-http-harness";

const PATH = "/api/v1/sales-by-store";
const CONTRACT_ID = "console-sales-by-store.openapi";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const OCTOBER = { from: "2026-10-01", to: "2026-10-31", currency: "EGP" };
const DAY_MS = 86_400_000;

interface Money {
  count: number;
  byCurrency: Array<{ currencyCode: string; count: number; total: string }>;
}
interface Facts {
  receivedSales: Money;
  returns: Money;
  voids: Money;
  legacyRefunds: Money;
}
interface StoreDay {
  businessDate: string;
  state: "complete" | "so_far" | "not_begun";
  count: number;
  total: string;
}
interface StoreRow {
  storeRef: string;
  storeName: string;
  storeStatus: string;
  storeTimezone: string;
  currentBusinessDate: string;
  rank: number | null;
  baselineRank: number | null;
  facts: Facts;
  ranking: {
    total: string;
    count: number;
    share: string | null;
    averageSale: string | null;
    baselineTotal: string | null;
    deltaRatio: string | null;
    bestDay: { businessDate: string; total: string } | null;
    days: StoreDay[];
  };
}
interface ByStore {
  from: string;
  to: string;
  currency: string;
  compare: string;
  asOf: string;
  completeness: string;
  baseline: { rule: string; from: string; to: string; dayCount: number };
  rankable: boolean;
  storeCount: number;
  storesWithoutSales: number;
  rangeTotals: Facts;
  days: Array<{ businessDate: string; facts: Facts }>;
  stores: StoreRow[];
}

const http = useConsoleHttpHarness({
  label: "RT-1053 sales by store",
  contractId: CONTRACT_ID,
  seed: seedConsoleSalesByStoreFixture,
});
const audit = http.audit;
let byStoreSchema: ValidateFunction;
let errorSchema: ValidateFunction;

beforeAll(() => {
  byStoreSchema = http.schema("ConsoleSalesByStore");
  errorSchema = http.schema("Error");
});

const skip = (): boolean => http.skip();
const E = (): PgTestEnv => http.env();
const get = (session: string | null, query: Query | string = {}): request.Test => http.get(PATH, session, query);

async function byStore(session: string, query: Query): Promise<ByStore> {
  const res = await get(session, query);
  if (res.status !== 200) throw new Error(`by store ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(byStoreSchema, res.body);
  return res.body as ByStore;
}

async function expectError(res: request.Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expectValid(errorSchema, res.body);
  expect(res.body.error.code).toBe(code);
}

function store(s: ByStore, storeRef: string): StoreRow {
  const found = s.stores.find((x) => x.storeRef === storeRef);
  if (!found) throw new Error(`no store ${storeRef}`);
  return found;
}

/** `YYYY-MM-DD` `days` from `date`. */
function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const egp = (count: number, total: string): Money => ({
  count,
  byCurrency: [{ currencyCode: "EGP", count, total }],
});

// ===========================================================================
// Ranking and figures
// ===========================================================================

describe("RT-1053 sales by store — ranking of a tenant-wide scope", () => {
  it("states the request, the baseline and received_only", async () => {
    if (skip()) return;
    const before = Date.now();
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    expect(s).toMatchObject({
      ...OCTOBER,
      compare: "previous_period",
      completeness: "received_only",
      baseline: {
        rule: "previous_equal_length",
        from: "2026-08-31",
        to: "2026-09-30",
        dayCount: 31,
      },
      rankable: true,
      storeCount: 4,
      storesWithoutSales: 0,
    });
    expect(Date.parse(s.asOf)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.days.map((d) => d.businessDate)).toHaveLength(31);
  });

  it("ranks by total, then count, then storeRef, with every status and name (D-4, D-6, D-8)", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    const tied = [STORE_A_Y, S_DELETED].sort();
    expect(s.stores.map((x) => [x.storeRef, x.rank])).toEqual([
      [STORE_A_X, 1],
      [S_INACTIVE, 2],
      [tied[0], 3],
      [tied[1], 4],
    ]);
    expect(store(s, STORE_A_X)).toMatchObject({
      storeStatus: "active",
      storeTimezone: "Africa/Cairo",
      storeName: "T340 Store A-X",
    });
    expect(store(s, STORE_A_Y)).toMatchObject({
      storeStatus: "active",
      storeTimezone: "America/New_York",
    });
    expect(store(s, S_INACTIVE)).toMatchObject({
      storeStatus: "inactive",
      storeName: "RT-1053 Inactive",
    });
    expect(store(s, S_DELETED)).toMatchObject({
      storeStatus: "deleted",
      storeName: "RT-192 Deleted",
    });
  });

  it("computes share, average, baseline, delta and best day exactly (D-2, D-10)", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    expect(store(s, STORE_A_X)).toMatchObject({ baselineRank: 2 });
    expect(store(s, STORE_A_X).ranking).toMatchObject({
      total: "112.5000",
      count: 9,
      share: "0.7500",
      averageSale: "12.5000",
      baselineTotal: "12.5000",
      deltaRatio: "8.0000",
      bestDay: { businessDate: "2026-10-03", total: "25.0000" },
    });
    // The September bulk: 520 × 1.00 plus two 12.50 sales.
    expect(store(s, STORE_A_Y)).toMatchObject({ baselineRank: 1 });
    expect(store(s, STORE_A_Y).ranking).toMatchObject({
      total: "12.5000",
      count: 1,
      share: "0.0833",
      baselineTotal: "545.0000",
      deltaRatio: "-0.9771",
    });
    expect(store(s, S_INACTIVE)).toMatchObject({ baselineRank: null });
    expect(store(s, S_INACTIVE).ranking).toMatchObject({
      averageSale: "6.2500",
      baselineTotal: "0.0000",
      deltaRatio: null,
    });
  });

  it("returns the baseline bounds but no baseline figure with compare=none", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, { ...OCTOBER, compare: "none" });
    expect(s.compare).toBe("none");
    expect(s.baseline).toEqual({
      rule: "previous_equal_length",
      from: "2026-08-31",
      to: "2026-09-30",
      dayCount: 31,
    });
    for (const x of s.stores) {
      expect(x.baselineRank).toBeNull();
      expect(x.ranking.baselineTotal).toBeNull();
      expect(x.ranking.deltaRatio).toBeNull();
    }
  });

  it("ranks in the chosen currency only and never adds across currencies", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, { ...OCTOBER, currency: "USD" });
    expect(s.stores.map((x) => [x.storeRef, x.rank])[0]).toEqual([STORE_A_X, 1]);
    expect(s.stores.slice(1).every((x) => x.rank === null)).toBe(true);
    expect(s.stores.slice(1).map((x) => x.storeRef)).toEqual([STORE_A_Y, S_DELETED, S_INACTIVE].sort());
    expect(s.storesWithoutSales).toBe(3);
    expect(store(s, STORE_A_X).ranking).toMatchObject({
      total: "10.0000",
      count: 1,
      share: "1.0000",
    });
    expect(store(s, STORE_A_X).facts.receivedSales.byCurrency).toEqual([
      { currencyCode: "EGP", count: 9, total: "112.5000" },
      { currencyCode: "USD", count: 1, total: "10.0000" },
    ]);
  });

  it("treats a currency with no fact as valid: every store unranked", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, { ...OCTOBER, currency: "JPY" });
    expect(s.stores.every((x) => x.rank === null && x.ranking.share === null)).toBe(true);
    expect(s.storesWithoutSales).toBe(4);
    expect(s.stores.map((x) => x.storeRef)).toEqual([STORE_A_X, STORE_A_Y, S_DELETED, S_INACTIVE].sort());
  });

  it("gives each store the RT-649 summary's facts of that store and range", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    for (const storeRef of [STORE_A_X, STORE_A_Y]) {
      const res = await http.get("/api/v1/sales-summary", SES_OWNER_ALL, {
        store_id: storeRef,
        from: OCTOBER.from,
        to: OCTOBER.to,
      });
      expect(res.status).toBe(200);
      const totals = res.body.stores[0].rangeTotals;
      expect(store(s, storeRef).facts).toEqual({
        receivedSales: totals.receivedSales,
        returns: totals.returns,
        voids: totals.voids,
        legacyRefunds: totals.legacyRefunds,
      });
    }
    // Voids and returns on their own business dates; legacy refunds by the Cairo local date.
    const x = store(s, STORE_A_X);
    expect(x.facts.voids).toEqual(egp(1, "12.5000"));
    expect(x.facts.returns).toEqual(egp(2, "20.0000"));
    expect(s.days.find((d) => d.businessDate === "2026-10-04")!.facts.legacyRefunds).toEqual(egp(1, "2.0000"));
    expect(s.days.find((d) => d.businessDate === "2026-10-05")!.facts.legacyRefunds).toEqual(egp(1, "2.0000"));
  });

  it("makes the scope totals and days the sum of the stores, per currency", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    expect(s.rangeTotals.receivedSales.byCurrency).toEqual([
      { currencyCode: "EGP", count: 13, total: "150.0000" },
      { currencyCode: "USD", count: 1, total: "10.0000" },
    ]);
    const dayCount = s.days.reduce((n, d) => n + d.facts.receivedSales.count, 0);
    expect(dayCount).toBe(s.rangeTotals.receivedSales.count);
    expect(s.days.find((d) => d.businessDate === "2026-10-02")!.facts.receivedSales).toEqual(egp(3, "37.5000"));
  });

  it("returns dense per-store days in the ranking currency", async () => {
    if (skip()) return;
    const x = store(await byStore(SES_OWNER_ALL, OCTOBER), STORE_A_X);
    expect(x.ranking.days).toHaveLength(31);
    expect(x.ranking.days[0]).toMatchObject({
      businessDate: "2026-10-01",
      count: 1,
      total: "12.5000",
    });
    expect(x.ranking.days[14]).toMatchObject({
      businessDate: "2026-10-15",
      count: 0,
      total: "0.0000",
    });
    // The USD sale of 10-07 is not in the EGP days.
    expect(x.ranking.days[6]).toMatchObject({
      businessDate: "2026-10-07",
      count: 0,
      total: "0.0000",
    });
  });
});

// ===========================================================================
// Day states around today (the clock of the run)
// ===========================================================================

describe("RT-1053 sales by store — day states", () => {
  const SO_FAR_SALE = "0a000000-0000-7000-8000-0000001053b1";

  it("marks each store's own current business date so_far, earlier dates complete and later dates not_begun", async () => {
    if (skip()) return;
    const today = new Date().toISOString().slice(0, 10);
    const range = { from: shift(today, -15), to: shift(today, 15), currency: "XTS" };
    const local = await E().admin.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS d`);
    await insertSale(E().admin, {
      id: SO_FAR_SALE,
      storeId: STORE_A_X,
      currency: "XTS",
      total: "3.0000",
      occurredAt: new Date().toISOString(),
      businessDate: local.rows[0]!.d,
    });
    try {
      const s = await byStore(SES_OWNER_ALL, range);
      for (const x of s.stores) {
        expect(x.ranking.days).toHaveLength(31);
        for (const d of x.ranking.days) {
          const expected =
            d.businessDate < x.currentBusinessDate
              ? "complete"
              : d.businessDate === x.currentBusinessDate
                ? "so_far"
                : "not_begun";
          expect(d.state).toBe(expected);
        }
        expect(x.ranking.days.filter((d) => d.state === "so_far")).toHaveLength(1);
      }
      const x = store(s, STORE_A_X);
      expect(x.currentBusinessDate).toBe(local.rows[0]!.d);
      expect(x.ranking.days.find((d) => d.state === "so_far")).toMatchObject({
        count: 1,
        total: "3.0000",
      });
      expect(s.rankable).toBe(true);
      expect(x.rank).toBe(1);
    } finally {
      await E().admin.query(`DELETE FROM sales WHERE id = $1`, [SO_FAR_SALE]);
    }
  });
});

// ===========================================================================
// Scope, isolation and refusals
// ===========================================================================

describe("RT-1053 sales by store — scope and isolation", () => {
  it.each([
    ["owner, all, X active (not narrowed)", SES_OWNER_ALL_ACTIVE, [STORE_A_X, STORE_A_Y, S_DELETED, S_INACTIVE]],
    ["owner, specific (X + deleted)", SES_OWNER_SPEC, [STORE_A_X]],
    ["tenant_admin, specific (X)", SES_ADMIN_SPEC, [STORE_A_X]],
    ["store_manager, specific (X + Y)", SES_MANAGER, [STORE_A_X, STORE_A_Y]],
    ["store_manager, Y active (narrowed)", SES_MANAGER_ACTIVE, [STORE_A_Y]],
    ["platform admin, no active store", SES_PLATFORM, [STORE_A_X, STORE_A_Y, S_DELETED, S_INACTIVE]],
    ["tenant_admin with no live store", SES_ADMIN_EMPTY, []],
  ])("%s: the stores and figures of its scope only", async (_label, session, stores) => {
    if (skip()) return;
    const s = await byStore(session, OCTOBER);
    expect(s.stores.map((x) => x.storeRef).sort()).toEqual([...stores].sort());
    expect(s.storeCount).toBe(stores.length);
    expect(s.rankable).toBe(stores.length >= 2);
    const counts = s.stores.reduce((n, x) => n + x.facts.receivedSales.count, 0);
    expect(s.rangeTotals.receivedSales.count).toBe(counts);
  });

  it("ranks within the scope only: a two-store manager's shares add up over X and Y", async () => {
    if (skip()) return;
    const s = await byStore(SES_MANAGER, OCTOBER);
    expect(s.stores.map((x) => [x.storeRef, x.rank])).toEqual([
      [STORE_A_X, 1],
      [STORE_A_Y, 2],
    ]);
    expect(store(s, STORE_A_X).ranking.share).toBe("0.9000");
    expect(store(s, STORE_A_Y).ranking.share).toBe("0.1000");
  });

  it("one store is not rankable: no rank, no baseline rank (D-6b)", async () => {
    if (skip()) return;
    const s = await byStore(SES_ADMIN_SPEC, OCTOBER);
    expect(s).toMatchObject({ rankable: false, storeCount: 1, storesWithoutSales: 0 });
    expect(s.stores[0]).toMatchObject({ storeRef: STORE_A_X, rank: null, baselineRank: null });
    expect(s.stores[0]!.ranking).toMatchObject({ share: "1.0000", deltaRatio: "8.0000" });
  });

  it("an empty scope is a 200 of zeros with dense scope days", async () => {
    if (skip()) return;
    const s = await byStore(SES_ADMIN_EMPTY, OCTOBER);
    expect(s).toMatchObject({ storeCount: 0, storesWithoutSales: 0, rankable: false, stores: [] });
    expect(s.rangeTotals.receivedSales).toEqual({ count: 0, byCurrency: [] });
    expect(s.days).toHaveLength(31);
  });

  it("never shows another tenant's store or figure (RLS)", async () => {
    if (skip()) return;
    const s = await byStore(SES_OWNER_ALL, OCTOBER);
    expect(s.stores.map((x) => x.storeRef)).not.toContain(STORE_B_X);
    const tenantA = await E().admin.query<{ id: string }>(`SELECT id::text FROM stores WHERE tenant_id = $1`, [
      TENANT_A,
    ]);
    expect(s.stores.map((x) => x.storeRef).sort()).toEqual(tenantA.rows.map((r) => r.id).sort());
    // Tenant B's B_OCT02 (12.50 EGP on 10-02) is not in the scope day.
    expect(s.days.find((d) => d.businessDate === "2026-10-02")!.facts.receivedSales).toEqual(egp(3, "37.5000"));
    const c = await byStore(SES_C_OWNER, OCTOBER);
    expect(c.stores.some((x) => [STORE_A_X, STORE_A_Y, S_DELETED, S_INACTIVE].includes(x.storeRef))).toBe(false);
    expect(c.rangeTotals.receivedSales).toEqual({ count: 0, byCurrency: [] });
  });

  it("store_staff is the non-disclosing 404, before any validation", async () => {
    if (skip()) return;
    for (const query of [OCTOBER, { from: "x" }]) {
      const res = await get(SES_STAFF, query);
      await expectError(res, 404, "not_found");
      expect({ ...res.body.error, request_id: undefined }).toEqual({
        ...NOT_FOUND,
        request_id: undefined,
      });
    }
  });

  it.each([
    ["a dashboard_api token", DASHBOARD_TOKEN],
    ["a POS operator token", OPERATOR_TOKEN],
    ["a device token", DEVICE_TOKEN],
  ])("%s is 401", async (_label, token) => {
    if (skip()) return;
    const res = await get(null, OCTOBER).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("no session is 401", async () => {
    if (skip()) return;
    expect((await get(null, OCTOBER)).status).toBe(401);
  });
});

describe("RT-1053 sales by store — validation and the 500-store bound", () => {
  it.each([
    ["no currency", { from: OCTOBER.from, to: OCTOBER.to }],
    ["a lower-case currency", { ...OCTOBER, currency: "egp" }],
    ["32 business days", { ...OCTOBER, to: "2026-11-01" }],
    ["to before from", { ...OCTOBER, from: "2026-10-02", to: "2026-10-01" }],
    ["a non-calendar date", { ...OCTOBER, from: "2026-02-30" }],
    ["an unknown compare", { ...OCTOBER, compare: "last_year" }],
    ["store_id", { ...OCTOBER, store_id: STORE_A_X }],
    ["page_size", { ...OCTOBER, page_size: 10 }],
    ["tenant_id", { ...OCTOBER, tenant_id: TENANT_A }],
  ])("%s is 400 validation_error", async (_label, query) => {
    if (skip()) return;
    await expectError(await get(SES_OWNER_ALL, query), 400, "validation_error");
  });

  it("a repeated key is 400 validation_error", async () => {
    if (skip()) return;
    await expectError(
      await get(SES_OWNER_ALL, "from=2026-10-01&to=2026-10-31&currency=EGP&currency=USD"),
      400,
      "validation_error",
    );
  });

  it("500 stores is a 200; the 501st makes it 400 scope_too_large, never truncated or audited", async () => {
    if (skip()) return;
    const full = await byStore(SES_C_OWNER, OCTOBER);
    expect(full.storeCount).toBe(500);
    expect(full.stores).toHaveLength(500);
    await E().admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'c-extra', 'Store C extra')`,
      [STORE_C_EXTRA, TENANT_C],
    );
    try {
      audit.payloads.length = 0;
      await expectError(await get(SES_C_OWNER, OCTOBER), 400, "scope_too_large");
      await new Promise((r) => setTimeout(r, 50));
      expect(audit.payloads.filter((p) => JSON.stringify(p).includes("console_sales.by_store_read"))).toHaveLength(0);
    } finally {
      await E().admin.query(`DELETE FROM stores WHERE id = $1`, [STORE_C_EXTRA]);
    }
  });
});

// ===========================================================================
// Audit
// ===========================================================================

describe("RT-1053 sales by store — audit", () => {
  it("emits one console_sales.by_store_read with no figure or name, after a 200 only", async () => {
    if (skip()) return;
    audit.payloads.length = 0;
    await byStore(SES_OWNER_ALL, OCTOBER);
    await get(SES_OWNER_ALL, { from: "2026-10-01" });
    await get(SES_STAFF, OCTOBER);
    await new Promise((r) => setTimeout(r, 50));
    const events = audit.payloads.filter((p) => JSON.stringify(p).includes("console_sales.by_store_read"));
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events[0]);
    expect(text).toContain('"currency":"EGP"');
    expect(text).toContain('"compare":"previous_period"');
    expect(text).toContain('"store_count":4');
    expect(text).not.toContain("112.5000");
    expect(text).not.toContain("T340 Store A-X");
  });
});
