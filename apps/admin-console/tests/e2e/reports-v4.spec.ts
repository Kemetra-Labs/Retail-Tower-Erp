/**
 * RT-1020 (v4.0) the Reports index and the daily report's band in a real layout:
 * axe passes (C7), the band holds within 132px at 1280 with every fact inside it,
 * the page never scrolls sideways at 390, and a proposed report is not a link.
 * Run once per locale by the Playwright projects.
 */
import { CAIRO, storeSummary } from "../unit/sales-daily-fixtures";
import { expectNoAxeViolations } from "./axe";
import { mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

async function openReport(page: Page): Promise<void> {
  await mockRealisticApi(page);
  await page.clock.setFixedTime(new Date("2026-10-23T09:00:00Z"));
  const summary = storeSummary({
    ref: CAIRO,
    timeZone: "Africa/Cairo",
    currentBusinessDate: "2026-10-23",
  });
  await page.route("**/api/v1/sales-summary?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) }),
  );
  await page.goto("/sales-daily");
  await page.locator("dl.list-band__facts").waitFor();
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test("reports index: axe, one band row within 132px, no sideways scroll", async ({ page }) => {
  await mockRealisticApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/reports");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const band = await page.locator("header.list-band").boundingBox();
  expect(band?.height ?? 0).toBeLessThanOrEqual(132);
  await expectNoAxeViolations(page, "/reports at 1280");
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await overflow(page)).toBe(0);
  await expectNoAxeViolations(page, "/reports at 390");
});

test("reports index: a proposed report is a plain card, never a link", async ({ page }) => {
  await mockRealisticApi(page);
  await page.goto("/reports");
  const proposed = page.locator(".reports-card--proposed");
  // RT-1054: «Sales by store» is built, so four reports stay proposed.
  await expect(proposed).toHaveCount(4);
  expect(await proposed.locator("a, button, [tabindex]").count()).toBe(0);
  // Every card names its state in text.
  for (const card of await proposed.all()) {
    await expect(card.locator(".reports-pill--proposed")).not.toBeEmpty();
  }
});

test("reports index: the sidebar entry opens it", async ({ page }) => {
  await mockRealisticApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator('nav a[href="/reports"]').first().click();
  await expect(page).toHaveURL(/\/reports$/);
});

test("daily report: the band's facts sit inside one row within 132px; axe passes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReport(page);
  const layout = await page.evaluate(() => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    const box = band.getBoundingClientRect();
    const inside = [...band.querySelectorAll("dd")].every((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    return { height: Math.round(box.height), inside, facts: band.querySelectorAll("dd").length };
  });
  expect(layout.facts).toBe(3);
  expect(layout.height).toBeLessThanOrEqual(132);
  expect(layout.inside).toBe(true);
  await expectNoAxeViolations(page, "/sales-daily at 1280");
});

test("daily report at 390: no sideways scroll, the day panel and tables present", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openReport(page);
  expect(await overflow(page)).toBe(0);
  await expect(page.locator(".daily-day")).toBeVisible();
  await expectNoAxeViolations(page, "/sales-daily at 390");
});
