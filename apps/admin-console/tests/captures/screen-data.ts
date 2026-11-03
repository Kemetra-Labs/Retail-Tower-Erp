import { STORE, context, mockRealisticApi } from "../e2e/compact-shell-data";
import type { Page } from "../e2e/fixtures";
import { CAIRO, storeSummary } from "../unit/sales-daily-fixtures";

/**
 * RT-1118: the per-screen mocked Backend-Core bodies the captures need beyond
 * `mockRealisticApi` (compact-shell-data). They are copied from the e2e specs
 * that own them (erp-status, users-band, overview, sales-daily): a spec file
 * cannot be imported without registering its tests. Contract shapes only; the
 * names and figures are fixtures.
 */

export const FIXED_NOW = new Date("2026-10-23T09:00:00Z");

/** A long Arabic tenant name, as users-band.spec.ts measures the band with. */
export const LONG_TENANT_AR =
  "نورثستار للتجزئة والتوزيع والخدمات اللوجستية بالقاهرة الجديدة والتجمع الخامس";

export const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The 500 envelope shift-v4.spec.ts uses for "a failed load puts a banner under the band". */
export const FAILED = json(
  { error: { code: "system_failure", message: "x", request_id: "req-rt1118" } },
  500,
);

/** The compact-shell context with another tenant name (same id, role and store). */
export function contextNamed(tenantName: string) {
  return {
    ...context,
    active_tenant: { id: "t1", name: tenantName },
    memberships: context.memberships.map((m) => ({ ...m, tenant_name: tenantName })),
  };
}

const uuid = (prefix: string, i: number) =>
  `0190f000-0000-7000-8000-${prefix}${String(i).padStart(12 - prefix.length, "0")}`;

// --- Sales (compact-shell-data's sale row, which that file does not export) ---

export function saleRow(i: number, over: Record<string, unknown> = {}) {
  return {
    saleRef: uuid("5b", i),
    storeRef: STORE,
    saleNumber: `R-${String(i).padStart(4, "0")}-CFC-1000`,
    businessDate: "2026-10-07",
    occurredAt: "2026-10-07T10:30:00Z",
    receivedAt: "2026-10-07T10:30:04Z",
    device: { deviceRef: null, label: "كاشير المدخل الرئيسي 1", labelSource: "snapshot" },
    operator: { userRef: null, displayName: "محمد عبد الرحمن السيد", nameSource: "snapshot" },
    currencyCode: "EGP",
    posTotal: `${1000 + i * 37}.5000`,
    syncStatus: "synced",
    voided: i % 7 === 0,
    returnState: i % 5 === 0 ? "partial" : "none",
    erpPostingState: i % 3 === 0 ? "failed" : "unknown",
    ...over,
  };
}

export const rows = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i + 1));

// --- ERPNext connection & sync status (erp-status.spec.ts mockBase) ---

const INSTANCE = "0190f000-0000-7000-8000-0000000000e1";

const instance = {
  id: INSTANCE,
  display_name: "Northstar ERP",
  erpnext_site_ref: "erp.northstar.eg",
  environment: "pilot",
  created_at: "2026-09-01T08:00:00Z",
  disabled_at: null,
  active_credential: null,
};

const health = {
  connectorId: INSTANCE,
  displayName: "Northstar ERP",
  environment: "pilot",
  erpnextSiteRef: "erp.northstar.eg",
  lastSeenAt: null,
  liveness: "never_seen",
  secondsSinceLastSeen: null,
  connectorVersion: null,
  backlogIndicator: null,
  erpnextReachable: null,
  reportedFieldsAt: null,
};

const erpSummary = {
  domains: [
    { domain: "posting", status: "ok", headlineCount: 0, detail: "No posting dead-letters" },
    { domain: "reconciliation", status: "attention", headlineCount: 2, detail: null },
    { domain: "connector_health", status: "not_available", headlineCount: null, detail: null },
    { domain: "product_master", status: "not_available", headlineCount: null, detail: null },
  ],
};

export function erpRun(i: number) {
  return {
    runId: uuid("d", i),
    storeId: STORE,
    kind: i % 2 === 0 ? "stock" : "price",
    trigger: "scheduled",
    status: i % 4 === 0 ? "failed" : "completed",
    startedAt: "2026-10-12T02:00:00Z",
    finishedAt: "2026-10-12T02:03:00Z",
    mismatchSummary: { negative_on_hand: i % 3 },
  };
}

export const ERP_RUNS = "**/api/v1/catalog/erpnext-sync-ops/reconciliation-runs**";
export const ERP_INSTANCES = "**/api/v1/connector/instances";

export async function mockErp(page: Page): Promise<void> {
  await mockRealisticApi(page);
  await page.route(ERP_INSTANCES, (r) => r.fulfill(json({ items: [instance] })));
  await page.route("**/api/v1/connector/health", (r) => r.fulfill(json({ items: [health] })));
  await page.route("**/api/v1/catalog/erpnext-sync-ops/summary**", (r) =>
    r.fulfill(json(erpSummary)),
  );
  await page.route("**/api/v1/catalog/erpnext-sync-ops/posting-backlog**", (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(ERP_RUNS, (r) => r.fulfill(json({ items: [erpRun(1)], nextCursor: null })));
}

// --- Users / operators (users-band.spec.ts) ---

export function member(i: number) {
  const roles = ["tenant_admin", "store_manager", "manager", "cashier", "auditor"];
  const names = ["منى السيد", "كريم عادل", "هالة فوزي", "يوسف ناصر", null, "طارق منير"];
  const stores = i % 4;
  return {
    membership_id: `m-${i}`,
    user: {
      id: `u-${i}`,
      email: `member${i}@northstar-retail.eg`,
      display_name: names[i % names.length],
    },
    role_code: roles[i % roles.length],
    store_access_kind: stores === 0 ? "all" : "specific",
    accessible_store_ids: Array.from({ length: stores }, (_, s) => `s${s}`),
    revoked_at: i % 6 === 5 ? "2026-06-01T00:00:00Z" : null,
  };
}

export const MEMBERS = "**/api/v1/tenants/t1/members";

export async function mockMembers(page: Page): Promise<void> {
  await mockRealisticApi(page);
  await page.route(MEMBERS, (r) => r.fulfill(json(rows(7, member))));
}

// --- Daily sales (reports-v4.spec.ts) ---

export const SUMMARY = "**/api/v1/sales-summary?**";

export async function mockSalesDaily(page: Page, range?: { from: string; to: string }) {
  await mockRealisticApi(page);
  const summary = storeSummary(
    { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
    range,
  );
  await page.route(SUMMARY, (r) => r.fulfill(json(summary)));
}

// --- Overview (overview.spec.ts mock, without its per-store bookkeeping) ---

const LOW_STOCK = {
  asOf: "2026-10-23T08:00:00Z",
  completeness: "received_only",
  storeId: null,
  limit: 10,
  evaluatedCount: 4,
  belowReorderCount: 1,
  criticalCount: 1,
  unknownOnHandCount: 0,
  negativeOnHandCount: 0,
  truncated: false,
  items: [
    {
      storeId: STORE,
      storeName: "فرع كايرو فستيفال سيتي مول التجمع الخامس",
      storeStatus: "active",
      productId: "0190f000-0000-7000-8000-0000000000b1",
      productName: "زيت زيتون بكر ممتاز 1 لتر",
      stockingUnit: "box",
      sellableOnHand: "2.0000",
      reorderLevel: "10.0000",
      criticalLevel: "3.0000",
      thresholdSource: "tenant",
      band: "critical",
      levelRatio: "0.2000",
    },
  ],
};

const snapshot = {
  status: "fresh",
  erpnextWarehouseRef: "Stores - NSR",
  runId: "0190f000-0000-7000-8000-0000000000f1",
  readAt: "2026-10-23T07:58:12.000Z",
  recordedAt: "2026-10-23T08:00:03.000Z",
  staleAfterSeconds: 86400,
  reportedEntryCount: 42,
  pendingRequest: null,
};

export const OVERVIEW_GLANCE = "**/api/v1/sales-summary**";

export async function mockOverview(page: Page): Promise<void> {
  await mockRealisticApi(page);
  const ids = (n: number) => rows(n, (i) => ({ id: `row-${i}` }));
  await page.route("**/api/v1/catalog/erpnext-reconciliation/negative-on-hand/stores**", (r) =>
    r.fulfill(
      json({
        items: [{ storeId: STORE, storeName: "فرع كايرو فستيفال", snapshot, negativeItemCount: 7 }],
        nextCursor: null,
      }),
    ),
  );
  await page.route(OVERVIEW_GLANCE, (r) =>
    r.fulfill(
      json(
        storeSummary(
          { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" },
          { from: "2026-10-22", to: "2026-10-24" },
        ),
      ),
    ),
  );
  await page.route("**/api/v1/inventory/low-stock**", (r) => r.fulfill(json(LOW_STOCK)));
  await page.route("**/api/v1/devices?**", (r) =>
    r.fulfill(json({ items: ids(3), nextCursor: null })),
  );
  await page.route("**/api/v1/shift-closes**", (r) =>
    r.fulfill(json({ items: ids(2), nextCursor: null })),
  );
  await page.route("**/api/v1/catalog/unknown-items**", (r) =>
    r.fulfill(json({ items: ids(5), next_cursor: null })),
  );
}
