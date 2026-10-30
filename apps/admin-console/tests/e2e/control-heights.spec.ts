/**
 * RT-959 (AC 1): one control height. On each list's filter row every input,
 * select and button renders at the shared `--control-h` (36px), so a field
 * never sits taller than the button beside it. Desktop width, both locales.
 */
import { STORE, mockRealisticApi } from "./compact-shell-data";
import { expect, test } from "./fixtures";

const ROWS = [
  { route: `/sales?store=${STORE}&from=2026-10-07&to=2026-10-07`, row: ".sale-filters" },
  { route: "/devices", row: ".device-filters" },
  { route: "/catalog/products", row: ".catalog-filters" },
  { route: "/audit", row: ".audit-filters" },
  // Its filters apply as they change: no button in the row.
  { route: "/unknown-items", row: ".unknown-item-controls", noButton: true },
];

const CONTROLS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, button';

for (const { route, row, noButton } of ROWS) {
  test(`${row}: every filter control is 36px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockRealisticApi(page);
    await page.goto(route);
    const container = page.locator(row).first();
    await expect(container).toBeVisible();
    const controls = container.locator(CONTROLS);
    // An empty row would pass any height check: require fields and an action.
    await expect(container.locator("input, select").first()).toBeVisible();
    if (!noButton) await expect(container.locator("button").first()).toBeVisible();
    const heights = await controls.evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          what: `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`,
          height: Math.round(el.getBoundingClientRect().height),
        })),
    );
    expect(heights.length).toBeGreaterThanOrEqual(2);
    for (const control of heights) {
      expect(control, control.what).toEqual({ what: control.what, height: 36 });
    }
  });
}
