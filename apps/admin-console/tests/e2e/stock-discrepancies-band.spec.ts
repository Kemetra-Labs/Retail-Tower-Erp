import { expectNoAxeViolations } from "./axe";
/**
 * RT-1017 — the ERPNext stock discrepancy band in a real layout. The list band
 * carries no facts and no action (the page is paged and the API serves no
 * whole-set figure): from 1200px it stays within 132px with a very long Arabic
 * tenant name; on a phone it is a plain light header and the page never scrolls
 * sideways. The store page's one primary sits in the band. Both routes pass
 * axe. Forced colours map the band and the panels to system colours.
 */
import { LONG_TENANT, user } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

const S1 = "0190f000-0000-7000-8000-0000000000a1";
const S2 = "0190f000-0000-7000-8000-0000000000a2";
/** Wider than a phone at any font: it can only fit by wrapping. */
const UNBROKEN = "فرعكايروفستيفالسيتيمولالتجمعالخامسالقاهرةالجديدة".repeat(2);

const ctx = {
  user,
  active_tenant: { id: "t1", name: LONG_TENANT },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [{ tenant_id: "t1", tenant_name: LONG_TENANT, role_code: "tenant_admin" }],
};

const fresh = {
  status: "fresh",
  erpnextWarehouseRef: "Stores - NSR",
  runId: "0190f000-0000-7000-8000-0000000000b1",
  readAt: "2026-10-04T07:58:12.000Z",
  recordedAt: "2026-10-04T08:00:03.000Z",
  staleAfterSeconds: 86400,
  reportedEntryCount: 312,
  pendingRequest: null,
};
const stale = {
  ...fresh,
  status: "stale",
  pendingRequest: {
    runId: "0190f000-0000-7000-8000-0000000000b2",
    requestedAt: "2026-10-05T09:15:00Z",
  },
};
const none = {
  ...fresh,
  status: "no_snapshot",
  runId: null,
  readAt: null,
  recordedAt: null,
  reportedEntryCount: null,
};

const storesPage = {
  items: [
    { storeId: S1, storeName: UNBROKEN, snapshot: stale, negativeItemCount: 2 },
    { storeId: S2, storeName: "Zamalek", snapshot: none, negativeItemCount: 0 },
  ],
  nextCursor: "c2",
};
const storePage = {
  storeId: S1,
  snapshot: stale,
  items: [
    {
      discrepancyKind: "erpnext_negative_on_hand",
      erpnextItemRef: { doctype: "Item", name: "ITM-00412" },
      mappingStatus: "mapped",
      tenantProduct: { id: "0190f000-0000-7000-8000-0000000000c1", name: "مياه معدنية 1.5 لتر" },
      erpnextWarehouseRef: "Stores - NSR",
      quantity: "-18",
      stockUom: "Nos",
    },
  ],
  nextCursor: null,
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
  await page.route("**/api/v1/catalog/erpnext-reconciliation/negative-on-hand/stores**", (r) =>
    r.fulfill(json(storesPage)),
  );
  await page.route(
    `**/api/v1/catalog/erpnext-reconciliation/stores/${S1}/negative-on-hand**`,
    (r) => r.fulfill(json(storePage)),
  );
}

async function open(page: Page, width: number, path: string): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mockApi(page);
  await page.goto(path);
  await page.locator("header.list-band").waitFor();
  await page.locator(".stock-results").waitFor();
}

interface Layout {
  height: number;
  pageOverflow: number;
  factsCount: number;
  h1InBand: boolean;
}

function measure(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    return {
      height: Math.round(band.getBoundingClientRect().height),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      factsCount: band.querySelectorAll("dl.list-band__facts").length,
      h1InBand: band.querySelector("h1") !== null,
    };
  });
}

test("1280: the list band is within 132px with a very long Arabic tenant, and has no facts", async ({
  page,
}) => {
  await open(page, 1280, "/stock-discrepancies");
  const layout = await measure(page);
  expect(layout.height).toBeLessThanOrEqual(132);
  expect(layout.factsCount).toBe(0);
  expect(layout.h1InBand).toBe(true);
  expect(layout.pageOverflow).toBe(0);
});

test("390: a long unbroken store name wraps; the page never scrolls sideways", async ({ page }) => {
  await open(page, 390, "/stock-discrepancies");
  const layout = await measure(page);
  expect(layout.pageOverflow).toBe(0);
  // The name wraps inside a cell with a floor; it never squeezes the column to a letter.
  const cell = await page
    .locator(".stock-table .stock-store")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(cell).toBeGreaterThanOrEqual(200);
  // Below 640px the band is a plain light header: no Ink ground.
  const ground = await page
    .locator("header.list-band")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ground).not.toBe("rgb(10, 33, 37)");
});

test("390: the store page keeps its primary and the page never scrolls sideways", async ({
  page,
  t,
}) => {
  await open(page, 390, `/stock-discrepancies/${S1}`);
  const layout = await measure(page);
  expect(layout.pageOverflow).toBe(0);
  // A pending request blocks the primary, with its reason beside it.
  const primary = page.locator("header.list-band").getByRole("button", {
    name: t("stock.refresh.action"),
  });
  await expect(primary).toBeDisabled();
  await expect(page.locator("header.list-band")).toContainText(t("stock.refresh.blocked.pending"));
});

test("axe: the list and the store page have no WCAG 2.1 A/AA violations", async ({ page }) => {
  await open(page, 1280, "/stock-discrepancies");
  await expectNoAxeViolations(page, "stock-discrepancies list");
  await page.goto(`/stock-discrepancies/${S1}`);
  await page.locator("header.list-band").waitFor();
  await page.locator(".stock-results").waitFor();
  await expectNoAxeViolations(page, "stock-discrepancies store");
});

test("forced colours: the band and the panels map to system colours, no ornament", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, 1280, "/stock-discrepancies");
  const band = await page.locator("header.list-band").evaluate((el) => ({
    image: getComputedStyle(el).backgroundImage,
    border: getComputedStyle(el).borderTopStyle,
  }));
  expect(band.image).toBe("none");
  expect(band.border).toBe("solid");
  const shadow = await page
    .locator(".stock-results")
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toBe("none");
});
