/**
 * RT-959 (AC 1): one control height. On each list's filter row every input,
 * select and button renders at the shared `--control-h` (36px), so a field
 * never sits taller than the button beside it. Desktop width, both locales.
 */
import { DEVICE, STORE, mockRealisticApi } from "./compact-shell-data";
import { expect, test } from "./fixtures";

// RT-960: every list filters through the shared FilterBar; its grid holds the fields.
const ROWS = [
  { route: `/sales?store=${STORE}&from=2026-10-07&to=2026-10-07`, row: ".filter-bar__grid" },
  { route: "/devices", row: ".filter-bar__grid" },
  { route: "/catalog/products", row: ".filter-bar__grid" },
  { route: "/audit", row: ".filter-bar__grid" },
  { route: "/unknown-items", row: ".filter-bar__grid" },
];

const CONTROLS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, button';

for (const { route, row } of ROWS) {
  test(`${route}: every filter control is 36px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockRealisticApi(page);
    await page.goto(route);
    const container = page.locator(row).first();
    await expect(container).toBeVisible();
    const controls = container.locator(CONTROLS);
    // An empty row would pass any height check: require fields and an action.
    await expect(container.locator("input, select").first()).toBeVisible();
    await expect(container.locator("button").first()).toBeVisible();
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

// RT-959 (AC 4): the compact one-off controls reach the 36px target.
test("the audit row action has a 36px hit area without a taller row", async ({ page, t }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  const event = (id: string, action: string) => ({
    id,
    occurred_at: "2026-06-01T21:14:03Z",
    action,
    actor_label: "Omar Khaled",
    actor_user_id: "u2",
    store_id: null,
    request_id: "11111111-1111-1111-1111-111111111111",
    metadata: {},
  });
  await page.route("**/api/v1/audit/events**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [event("e1", "shift.forced_close"), event("e2", "auth.signin")],
        next_cursor: null,
      }),
    }),
  );
  await page.goto("/audit");
  await page.getByRole("button", { name: t("filter.apply"), exact: true }).click();
  const action = page.locator(".audit-table__action").first();
  await expect(action).toBeVisible();
  // 16px above and below the centre still lands on the action, not the next row.
  const hits = await action.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [-16, 16].map((dy) => {
      const at = document.elementFromPoint(x, y + dy);
      return at !== null && (at === el || el.contains(at));
    });
  });
  expect(hits).toEqual([true, true]);
});

test("a device detail tab is at least 36px tall", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRealisticApi(page);
  await page.goto(`/devices/${DEVICE}`);
  const tab = page.locator(".device-tab").first();
  await expect(tab).toBeVisible();
  const height = await tab.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(height).toBeGreaterThanOrEqual(36);
});
