import { expectNoAxeViolations } from "./axe";
import { DETAIL_ROUTES, mockDetailTemplate } from "./detail-template-data";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-961: the v3 detail template, measured in the browser (jsdom computes no
 * CSS). On the five detail pages, in both locale projects:
 * - AC 1: the page title computes to the screen-title size (24px);
 * - AC 2: a ledger value is never lighter than its label;
 * - AC 3 / AC 6: money lines up at the inline end (the right edge in LTR, the
 *   left edge in RTL) in the shift-close ledger and the sale's line amounts;
 * - AC 4: a row that starts with a row header keeps its divider in that cell;
 * - axe (WCAG 2.1 A/AA) is clean on sale, shift-close and device detail.
 */

async function open(page: Page, route: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockDetailTemplate(page);
  await page.goto(route);
  await expect(page.locator(".field-row").first()).toBeVisible();
}

/** The inline-end edge of each element: its right edge in LTR, its left edge in RTL. */
async function endEdges(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((el) => {
      const box = el.getBoundingClientRect();
      return document.documentElement.dir === "rtl" ? box.left : box.right;
    }),
  );
}

function expectAligned(edges: number[], label: string): void {
  expect(edges.length, label).toBeGreaterThan(1);
  for (const edge of edges) expect(Math.abs(edge - edges[0]), label).toBeLessThanOrEqual(1);
}

for (const [name, route] of Object.entries(DETAIL_ROUTES)) {
  test(`${name} detail: the title is the 24px screen title; values outweigh labels`, async ({
    page,
  }) => {
    await open(page, route);
    const title = page.getByRole("heading", { level: 1 });
    await expect(title).toHaveCSS("font-size", "24px");
    const weights = await page.locator(".field-row").evaluateAll((rows) =>
      rows.map((row) => {
        const weight = (selector: string) =>
          Number(getComputedStyle(row.querySelector(selector) as Element).fontWeight);
        return { label: weight(".field-row__label"), value: weight(".field-row__value") };
      }),
    );
    for (const { label, value } of weights) expect(value).toBeGreaterThanOrEqual(label);
  });
}

test("shift-close detail: the cash ledger lines up at the inline end; the variance is anchored", async ({
  page,
}) => {
  await open(page, DETAIL_ROUTES.shift);
  const cash = '[aria-labelledby="shift-cash"]';
  expectAligned(
    await endEdges(page, `${cash} .field-row__value--money:not(.field-row--total *) > bdi`),
    "cash figures",
  );
  const money = page.locator(`${cash} .field-row__value--money`);
  await expect(money.first()).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(money.first()).toHaveCSS("text-align", "end");
  const total = page.locator(`${cash} .field-row--total`);
  await expect(total).toHaveCSS("border-top-width", "2px");
  await expectNoAxeViolations(page, "shift-close detail");
});

test("sale detail: line amounts and the anchored total line up; row headers keep the divider", async ({
  page,
}) => {
  await open(page, DETAIL_ROUTES.sale);
  const lines = page.locator('[aria-labelledby="sale-lines"] table');
  // The line-amount column (6th) and the served total under it share one end edge.
  expectAligned(
    await endEdges(
      page,
      '[aria-labelledby="sale-lines"] tbody td:nth-child(6) bdi, [aria-labelledby="sale-lines"] tfoot td.data-table__cell--num bdi',
    ),
    "line amounts and total",
  );
  const rowHeader = lines.locator('tbody th[scope="row"]').first();
  await expect(rowHeader).toHaveCSS("border-bottom-width", "1px");
  await expect(rowHeader).toHaveCSS("border-bottom-style", "solid");
  await expect(rowHeader).toHaveCSS("text-align", "start");
  await expectNoAxeViolations(page, "sale detail");
});

test("device detail: axe clean on the templated overview", async ({ page }) => {
  await open(page, DETAIL_ROUTES.device);
  await expectNoAxeViolations(page, "device detail");
});

for (const [name, route] of Object.entries(DETAIL_ROUTES)) {
  test(`${name} detail at 390px: no page-header action is clipped (RT-974)`, async ({ page }) => {
    await mockDetailTemplate(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const boxes = await page.locator(".page-header__end :is(a, button)").evaluateAll((controls) =>
      controls.map((el) => {
        const box = el.getBoundingClientRect();
        return { text: el.textContent, left: box.left, right: box.right };
      }),
    );
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    for (const box of boxes) {
      expect(box.left, box.text ?? "").toBeGreaterThanOrEqual(0);
      expect(box.right, box.text ?? "").toBeLessThanOrEqual(width);
    }
  });
}

test("sale detail: a failed ERP posting shows the state-only banner under the header (RT-974)", async ({
  page,
  t,
}) => {
  await open(page, DETAIL_ROUTES.sale);
  const banner = page.getByRole("alert");
  await expect(banner).toContainText(t("sales.erpFailure.sale"));
  await expect(banner).toContainText(
    t("sales.erpFailure.evidence", { field: t("sales.erp.sale"), state: t("sales.erp.failed") }),
  );
  await expect(banner.getByRole("link", { name: t("erp.nav.label") })).toHaveAttribute(
    "href",
    "/erp-connection",
  );
  await expectNoAxeViolations(page, "sale detail with the ERP failure banner");
});
