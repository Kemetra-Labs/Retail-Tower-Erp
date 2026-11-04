import { SALE, STORE, mockRealisticApi } from "../e2e/compact-shell-data";
import { DETAIL_ROUTES, mockDetailTemplate } from "../e2e/detail-template-data";
import type { Page } from "../e2e/fixtures";
import { pendingItem } from "../e2e/unknown-items-mocks";
import { maadi, report } from "../unit/sales-by-store-fixtures";
import {
  ERP_INSTANCES,
  ERP_RUNS,
  MEMBERS,
  OVERVIEW_GLANCE,
  SUMMARY,
  erpRun,
  json,
  member,
  mockErp,
  mockMembers,
  mockOverview,
  mockSalesDaily,
  repairItem,
  rows,
  saleRow,
} from "./screen-data";

/**
 * RT-1118: the v4.0 Console screens whose In Review tickets wait on the C2/C4
 * captures, with each screen's own mocks (no live backend, C-5).
 *
 * - `failRead`: the screen's primary read. Answering it with a 500 gives the
 *   "banner under the band" state. Absent where the screen reads nothing.
 * - `dense`: routes registered over `mock` that fill the screen's table with a
 *   full page of rows, and the URL to open. Absent where the screen has no table.
 */
export interface Screen {
  ticket: string;
  slug: string;
  route: string;
  mock: (page: Page) => Promise<void>;
  failRead?: string;
  dense?: { route?: string; mock: (page: Page) => Promise<void> };
}

const DENSE = 25;
const NEEDS_REPAIR = "**/api/v1/catalog/sale-sync-ops/needs-repair**";

async function fulfill(page: Page, glob: string, body: unknown): Promise<void> {
  await page.route(glob, (r) => r.fulfill(json(body)));
}

const salesPage = (items: unknown[]) => ({
  items,
  nextCursor: null,
  asOf: "2026-10-08T09:15:00Z",
  storeRef: STORE,
  storeTimezone: "Africa/Cairo",
});

const DETAIL_READS: Record<keyof typeof DETAIL_ROUTES, string> = {
  sale: `**/api/v1/sales/${SALE}`,
  shift: `**${DETAIL_ROUTES.shift.replace("/shift-closes/", "/api/v1/shift-closes/")}`,
  device: `**${DETAIL_ROUTES.device.replace("/devices/", "/api/v1/devices/")}`,
  product: `**${DETAIL_ROUTES.product.replace("/catalog/", "/api/v1/catalog/")}`,
  store: `**${DETAIL_ROUTES.store.replace("/stores/", "/api/v1/stores/")}`,
};

const detailScreens: Screen[] = (Object.keys(DETAIL_ROUTES) as (keyof typeof DETAIL_ROUTES)[]).map(
  (name) => ({
    ticket: "RT-974",
    slug: `detail-${name}`,
    route: DETAIL_ROUTES[name],
    mock: mockDetailTemplate,
    failRead: DETAIL_READS[name],
  }),
);

export const SCREENS: Screen[] = [
  {
    ticket: "RT-1009",
    slug: "sales-list",
    route: "/sales",
    mock: mockRealisticApi,
    failRead: "**/api/v1/sales?**",
    dense: {
      mock: (page) => fulfill(page, "**/api/v1/sales?**", salesPage(rows(DENSE, saleRow))),
    },
  },
  {
    ticket: "RT-1009",
    slug: "sale-detail",
    route: `/sales/${SALE}`,
    mock: mockDetailTemplate,
    failRead: `**/api/v1/sales/${SALE}`,
  },
  {
    ticket: "RT-1011",
    slug: "erp-connection",
    route: "/erp-connection",
    mock: mockErp,
    failRead: ERP_INSTANCES,
    dense: {
      mock: (page) => fulfill(page, ERP_RUNS, { items: rows(DENSE, erpRun), nextCursor: null }),
    },
  },
  {
    ticket: "RT-1011",
    slug: "sales-needing-repair",
    route: "/sales-needing-repair",
    // compact-shell-data answers this read with sale rows; the list reads the repair-queue shape.
    mock: async (page) => {
      await mockRealisticApi(page);
      await fulfill(page, NEEDS_REPAIR, { items: rows(1, repairItem), nextCursor: null });
    },
    failRead: NEEDS_REPAIR,
    dense: {
      mock: (page) =>
        fulfill(page, NEEDS_REPAIR, { items: rows(DENSE, repairItem), nextCursor: null }),
    },
  },
  {
    ticket: "RT-1014",
    slug: "operators",
    route: "/operators",
    mock: mockMembers,
    failRead: MEMBERS,
    dense: { mock: (page) => fulfill(page, MEMBERS, rows(DENSE, member)) },
  },
  {
    ticket: "RT-1018",
    slug: "unknown-items",
    route: "/unknown-items",
    mock: mockRealisticApi,
    failRead: "**/api/v1/catalog/unknown-items?*",
    dense: {
      mock: (page) =>
        fulfill(page, "**/api/v1/catalog/unknown-items?*", {
          items: rows(DENSE, (i) =>
            pendingItem({
              id: `u${i}`,
              identifier_value: `50123456789${String(i).padStart(5, "0")}`,
              identifier_type: i % 3 === 0 ? "sku" : "barcode",
            }),
          ),
          next_cursor: null,
        }),
    },
  },
  {
    ticket: "RT-1020",
    slug: "reports-index",
    route: "/reports",
    mock: mockRealisticApi,
  },
  {
    ticket: "RT-1020",
    slug: "sales-daily",
    route: "/sales-daily",
    mock: (page) => mockSalesDaily(page),
    failRead: SUMMARY,
    dense: {
      route: "/sales-daily?from=2026-09-24&to=2026-10-23",
      mock: (page) => mockSalesDaily(page, { from: "2026-09-24", to: "2026-10-23" }),
    },
  },
  {
    ticket: "RT-1054",
    slug: "sales-by-store",
    route: "/sales-by-store",
    mock: async (page) => {
      await mockRealisticApi(page);
      await fulfill(page, "**/api/v1/sales-by-store?**", report());
    },
    failRead: "**/api/v1/sales-by-store?**",
    dense: {
      mock: (page) =>
        fulfill(
          page,
          "**/api/v1/sales-by-store?**",
          report({
            stores: rows(12, (i) =>
              maadi({
                storeRef: `0190f000-0000-7000-8000-0000000007${String(i).padStart(2, "0")}`,
                storeName: `فرع رقم ${i} — مول التجمع الخامس`,
                rank: i,
                baselineRank: 13 - i,
              }),
            ),
          }),
        ),
    },
  },
  ...detailScreens,
  {
    ticket: "RT-993",
    slug: "overview",
    route: "/",
    mock: mockOverview,
    failRead: OVERVIEW_GLANCE,
  },
];
