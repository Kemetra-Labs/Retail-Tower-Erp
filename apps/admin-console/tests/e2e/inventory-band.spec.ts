/**
 * RT-1016 — the Inventory header bands in a real layout (v4.0 «Ink & Receipt»).
 * At 1280px each band is within 132px and nothing in it is clipped; on a phone
 * (390px) a very long Arabic tenant and store name wrap rather than widening the
 * page. The stores list, a store page and a product page are measured, and a
 * screenshot of each is attached for the PR's C4 captures. The sections' numbered
 * badges are decoration: axe still passes on each route (C7). Under forced
 * colours the band drops its Ink fill and ornament for Canvas/CanvasText (C2).
 * `INVENTORY_SHOTS=<dir>` also writes the captures to that folder.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

const CAIRO = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const LOCATION = "0190f000-0000-7000-8000-0000000007d1";
const OLD_LOCATION = "0190f000-0000-7000-8000-0000000007d2";
const INV = "/api/inventory/v1";

const LONG_TENANT = "شركة الأفق الجديدة للتجارة والتوزيع وإدارة سلاسل الإمداد والتجزئة بالتجزئة";
const LONG_STORE = "فرع كايرو فستيفال سيتي مول التجمع الخامس القاهرة الجديدة الدور الثاني";

const store = {
  id: CAIRO,
  tenant_id: "t1",
  code: "CAI",
  name: LONG_STORE,
  timezone: "Africa/Cairo",
  is_active: true,
};

const ctx = {
  user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
  active_tenant: { id: "t1", name: LONG_TENANT },
  active_store: null,
  active_role_code: "owner",
  memberships: [{ tenant_id: "t1", tenant_name: LONG_TENANT, role_code: "owner" }],
};

const movement = {
  id: "0190f000-0000-7000-8000-000000000f01",
  storeId: CAIRO,
  movementType: "outbound",
  quantity: "-2.0000",
  stockingUnit: "kg",
  tenantProductRef: PRODUCT,
  reason: "عيّنة تذوّق للعملاء في المعرض الرئيسي بالدور الثاني",
  occurredAt: "2026-10-18T09:00:00Z",
  receivedAt: "2026-10-18T09:00:01Z",
  createdBy: "0190f000-0000-7000-8000-000000000a01",
  origin: "retail",
  integrationState: "reconciliation_required",
  erpConfirmedAt: null,
  stockLocationId: LOCATION,
  inventoryStatus: "sellable",
  positionInterpreted: false,
  trackingIdentityId: null,
};

const location = (id: string, kind: string, name: string, isActive: boolean) => ({
  id,
  storeId: CAIRO,
  code: name.toUpperCase(),
  name,
  kind,
  isActive,
});

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mock(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx)));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**${INV}/stores/${CAIRO}/movements**`, (r) =>
    r.fulfill(json({ items: [movement], nextCursor: "cursor-2" })),
  );
  await page.route(`**${INV}/stores/${CAIRO}/locations`, (r) =>
    r.fulfill(
      json({
        items: [
          location(LOCATION, "primary", "Main floor", true),
          location(OLD_LOCATION, "storage", "Old roof store", false),
        ],
      }),
    ),
  );
  await page.route(`**${INV}/on-hand/${CAIRO}/${PRODUCT}`, (r) =>
    r.fulfill(
      json({
        storeId: CAIRO,
        productId: PRODUCT,
        quantity: "-1.2500",
        stockingUnit: "kg",
        negativeBalance: true,
        sellableQuantity: "-1.2500",
        statusQuantities: [
          { inventoryStatus: "sellable", quantity: "-1.2500" },
          { inventoryStatus: "damaged", quantity: "0.0000" },
        ],
      }),
    ),
  );
  await page.route(`**${INV}/products/${PRODUCT}/tracking-identities**`, (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );
}

interface Layout {
  height: number;
  /** Every fact value and action sits inside the band's box. */
  allInside: boolean;
  pageOverflow: number;
}

function measure(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    const box = band.getBoundingClientRect();
    const parts = [...band.querySelectorAll("dd, .list-band__end")];
    const allInside = parts.every((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    return {
      height: Math.round(box.height),
      allInside,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** Writes a capture to `INVENTORY_SHOTS` when it is set; otherwise nothing. */
async function save(name: string, body: Buffer): Promise<void> {
  const dir = process.env.INVENTORY_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await import("node:fs/promises").then((fs) => fs.writeFile(join(dir, `${name}.png`), body));
}

const ROUTES = [
  { name: "stores", path: "/inventory", ready: "h1", facts: false },
  { name: "store", path: `/inventory/stores/${CAIRO}`, ready: "dl.list-band__facts", facts: true },
  {
    name: "product",
    path: `/inventory/stores/${CAIRO}/products/${PRODUCT}`,
    ready: "dl.list-band__facts",
    facts: true,
  },
] as const;

for (const width of [1280, 390]) {
  for (const route of ROUTES) {
    test(`${width}: ${route.name} band holds, nothing clips, the page never scrolls sideways`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await mock(page);
      await page.goto(route.path);
      await page.locator(route.ready).first().waitFor();
      await page.locator(".section-panel, table").first().waitFor();
      const layout = await measure(page);
      if (width >= 1280) expect(layout.height).toBeLessThanOrEqual(132);
      expect(layout.allInside).toBe(true);
      expect(layout.pageOverflow).toBe(0);
      if (route.facts) await expect(page.locator("dl.list-band__facts dd")).not.toHaveCount(0);
      else await expect(page.locator("dl.list-band__facts")).toHaveCount(0);
      await expectNoAxeViolations(page, `inventory ${route.name} ${width}`);
      const shot = await page.screenshot({ fullPage: true });
      await testInfo.attach(`inventory-${route.name}-${width}`, {
        body: shot,
        contentType: "image/png",
      });
      await save(`${route.name}-${width}-${testInfo.project.name}`, shot);
    });
  }
}

test("1280: the product's negative balance is a banner under the band, the band keeps its colour", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.goto(`/inventory/stores/${CAIRO}/products/${PRODUCT}`);
  const band = page.locator("header.list-band");
  await expect(band.getByTestId("on-hand-quantity")).toHaveText("-1.2500 kg");
  const before = await band.evaluate((el) => getComputedStyle(el).backgroundColor);
  const banner = page.getByText(/On-hand is below zero|الرصيد أقل من صفر/);
  await expect(banner).toBeVisible();
  // The warning is outside the band, below it, and the band's fill is the Ink fill.
  expect(await band.getByText(/below zero|أقل من صفر/).count()).toBe(0);
  const bandBottom = (await band.boundingBox())?.y ?? 0;
  expect((await banner.boundingBox())?.y ?? 0).toBeGreaterThan(bandBottom);
  expect(before).not.toBe("rgba(0, 0, 0, 0)");
});

test("1280 forced colours: the band is Canvas/CanvasText with no ornament", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await mock(page);
  await page.goto(`/inventory/stores/${CAIRO}`);
  const band = page.locator("header.list-band");
  await expect(band.locator("dl.list-band__facts dd")).not.toHaveCount(0);
  const style = await band.evaluate((el) => {
    const css = getComputedStyle(el);
    return { image: css.backgroundImage, border: css.borderTopStyle, width: css.borderTopWidth };
  });
  expect(style.image).toBe("none");
  expect(style.border).toBe("solid");
  expect(style.width).toBe("1px");
  const shot = await page.screenshot({ fullPage: true });
  await testInfo.attach("inventory-store-forced-colors", { body: shot, contentType: "image/png" });
  await save(`store-forced-colors-${testInfo.project.name}`, shot);
});
