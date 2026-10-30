/**
 * RT-960 (AC 1-3): every list filters through the one FilterBar. At 1440px each
 * field starts on a grid track, so columns line up across rows; at 390px the
 * fields stack full width with no sideways scroll. One apply verb, a ghost
 * Clear. Both locales.
 */
import { CAIRO, storeSummary } from "../unit/sales-daily-fixtures";
import { expectNoAxeViolations } from "./axe";
import { mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

const SCREENS = [
  "/sales",
  "/sales-daily",
  "/sales-needing-repair",
  "/devices",
  "/catalog/products",
  "/audit",
  "/shift-closes",
  "/unknown-items",
  "/erp-connection",
  "/product-reconciliation",
];

async function open(page: Page, route: string): Promise<void> {
  await mockRealisticApi(page);
  if (route === "/sales-daily") {
    // The realistic mock has no daily summary: give the report one it can draw.
    await page.clock.setFixedTime(new Date("2026-10-23T09:00:00Z"));
    const summary = storeSummary({
      ref: CAIRO,
      timeZone: "Africa/Cairo",
      currentBusinessDate: "2026-10-23",
    });
    await page.route("**/api/v1/sales-summary?**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) }),
    );
  }
  if (route === "/erp-connection" || route === "/product-reconciliation") {
    // The realistic mock has no ERP or reconciliation data: their reads fail
    // cleanly, the panels show their errors, and the filter still renders.
    const failed = { status: 500, contentType: "application/json", body: "{}" };
    await page.route("**/api/v1/connector/**", (r) => r.fulfill(failed));
    await page.route("**/api/v1/catalog/erpnext-**", (r) => r.fulfill(failed));
  }
  await page.goto(route);
  await expect(page.locator(".filter-bar").first()).toBeVisible();
}

/** Every field's inline-start edge, and the grid's track starts, in px. */
function trackFit(page: Page) {
  return page
    .locator(".filter-bar__grid")
    .first()
    .evaluate((grid) => {
      const rtl = getComputedStyle(grid).direction === "rtl";
      const box = grid.getBoundingClientRect();
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").map(Number.parseFloat);
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
      const starts: number[] = [];
      let at = 0;
      for (const width of tracks) {
        starts.push(at);
        at += width + gap;
      }
      const fields = [...grid.querySelectorAll<HTMLElement>(".filter-bar__field")].filter(
        (el) => el.offsetParent !== null,
      );
      const offset = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        return Math.round(rtl ? box.right - r.right : r.left - box.left);
      };
      const inExtra = (el: HTMLElement) => el.closest(".filter-bar__extra") !== null;
      return {
        starts: starts.map(Math.round),
        offsets: fields.map(offset),
        main: fields.filter((el) => !inExtra(el)).map(offset),
        extra: fields.filter(inExtra).map(offset),
        count: fields.length,
      };
    });
}

for (const route of SCREENS) {
  test(`${route}: fields sit on the grid tracks at 1440px`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, route);
    // The second row is what drifted before (RT-960): open «فلاتر إضافية» so it is measured.
    const more = page.locator(".filter-bar__more").first();
    const hasMore = (await more.count()) > 0;
    if (hasMore) await more.click();
    await expectNoAxeViolations(page, `${route} filter bar`);
    const { starts, offsets, main, extra, count } = await trackFit(page);
    expect(count).toBeGreaterThan(0);
    if (hasMore) {
      expect(extra.length).toBeGreaterThan(0);
      // Each extra field sits exactly under the main-row field in its column.
      extra
        .slice(0, main.length)
        .forEach((x, i) => expect(Math.abs(x - main[i])).toBeLessThanOrEqual(1));
    }
    for (const offset of offsets) {
      expect(
        starts.some((s) => Math.abs(s - offset) <= 1),
        `offset ${offset} in ${starts}`,
      ).toBe(true);
    }
  });

  test(`${route}: one Apply, a ghost Clear`, async ({ page, t }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, route);
    const bar = page.locator(".filter-bar").first();
    await expect(bar.getByRole("button", { name: t("filter.apply"), exact: true })).toHaveClass(
      /btn-primary/,
    );
    await expect(bar.getByRole("button", { name: t("filter.clear"), exact: true })).toHaveClass(
      /btn-ghost/,
    );
  });

  test(`${route}: stacks full width with no sideways scroll at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, route);
    const fit = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".filter-bar__grid");
      const width = grid?.getBoundingClientRect().width ?? 0;
      const fields = [...(grid?.querySelectorAll<HTMLElement>(".filter-bar__field") ?? [])]
        .filter((el) => el.offsetParent !== null)
        .map((el) => Math.round(el.getBoundingClientRect().width));
      return {
        scroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        width: Math.round(width),
        fields,
      };
    });
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    for (const field of fit.fields) expect(field).toBe(fit.width);
  });
}

test("a removable chip has a 24px target and removing it applies at once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  await page.goto("/devices?state=revoked");
  const remove = page.locator(".filter-bar__chip-remove").first();
  await expect(remove).toBeVisible();
  // The ::after hit area: the point 11px off the glyph's centre still hits it.
  const hits = await remove.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return [-11, 11].map((d) => {
      const at = document.elementFromPoint(x, y + d);
      return at === el || el.contains(at);
    });
  });
  expect(hits).toEqual([true, true]);
  await remove.click();
  await expect(page).not.toHaveURL(/state=revoked/);
});

// RT-960: every list with two or more filters shows its applied filters as chips.
test("shift closes: an applied filter is a chip; removing it applies at once", async ({
  page,
  t,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  await page.goto("/shift-closes?kind=forced");
  const chips = page.getByRole("list", { name: t("filter.applied") });
  await expect(chips).toContainText(t("shift.kind.forced"));
  await chips.getByRole("button").first().click();
  await expect(page).not.toHaveURL(/kind=forced/);
});

test("unknown items: a non-default filter is a chip; removing it restores the default", async ({
  page,
  t,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  await page.goto("/unknown-items");
  await page.getByLabel(t("unknownItems.filters.status")).selectOption("dismissed");
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  const chips = page.getByRole("list", { name: t("filter.applied") });
  await expect(chips).toContainText(t("unknownItems.status.dismissed"));
  await chips.getByRole("button").first().click();
  await expect(chips).toHaveCount(0);
  await expect(page.getByLabel(t("unknownItems.filters.status"))).toHaveValue("pending");
});

test("audit: an applied filter is a chip; removing it clears the field and applies", async ({
  page,
  t,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  await page.goto("/audit");
  await page.getByLabel(t("audit.field.action"), { exact: true }).fill("auth.");
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  const chips = page.getByRole("list", { name: t("filter.applied") });
  await expect(chips).toContainText("auth.");
  await chips.getByRole("button").first().click();
  await expect(chips).toHaveCount(0);
  await expect(page.getByLabel(t("audit.field.action"), { exact: true })).toHaveValue("");
});
