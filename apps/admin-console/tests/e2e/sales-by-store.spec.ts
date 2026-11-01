/**
 * RT-1054 the «Sales by store» report in a real layout: axe passes in both
 * locales, the page never scrolls sideways at 390 (the tables scroll inside
 * their own regions), and the report shows the served figures. Run once per
 * locale by the Playwright projects.
 */
import { report } from "../unit/sales-by-store-fixtures";
import { expectNoAxeViolations } from "./axe";
import { mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

async function openReport(page: Page, body: unknown = report()): Promise<void> {
  await mockRealisticApi(page);
  await page.clock.setFixedTime(new Date("2026-10-23T09:00:00Z"));
  await page.route("**/api/v1/sales-by-store?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
  await page.goto("/sales-by-store");
  await page.locator(".sbs-report").waitFor();
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("sales by store at 1280: served figures, one leader row, axe passes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openReport(page);
  await expect(page.locator(".sbs-row")).toHaveCount(3);
  await expect(page.locator(".sbs-row--leader")).toHaveCount(1);
  expect(await page.locator("header.list-band dd").count()).toBe(3);
  const band = await page.locator("header.list-band").boundingBox();
  expect(band?.height ?? 0).toBeLessThanOrEqual(132);
  await expectNoAxeViolations(page, "/sales-by-store at 1280");
});

test("sales by store at 390: no sideways scroll, the panel and tables present", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openReport(page);
  expect(await overflow(page)).toBe(0);
  await expect(page.locator(".sbs-panel")).toBeVisible();
  await expect(page.locator(".sbs-matrix")).toBeAttached();
  await expectNoAxeViolations(page, "/sales-by-store at 390");
});

test("sales by store: a refused scope shows the notice with no table, axe passes", async ({
  page,
}) => {
  await mockRealisticApi(page);
  await page.route("**/api/v1/sales-by-store?**", (r) =>
    r.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "scope_too_large", message: "x", request_id: "req-1" },
      }),
    }),
  );
  await page.goto("/sales-by-store");
  await expect(page.locator(".list-state--empty")).toBeVisible();
  await expect(page.locator(".sbs-report")).toHaveCount(0);
  await expectNoAxeViolations(page, "/sales-by-store scope_too_large");
});

test("sales by store: the Reports index opens it", async ({ page }) => {
  await mockRealisticApi(page);
  await page.route("**/api/v1/sales-by-store?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(report()) }),
  );
  await page.goto("/reports");
  await page.locator('a[href="/sales-by-store"]').first().click();
  await expect(page).toHaveURL(/\/sales-by-store$/);
});
