import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { store } from "../e2e/compact-shell-data";
import { PRODUCT } from "../e2e/detail-template-data";
import { type Page, expect, test } from "../e2e/fixtures";
import { FIXED_NOW } from "./screen-data";
import { SCREENS } from "./screens";

/**
 * RT-1195 / RT-1196: the store buttons of the catalog product detail ("Set a level for {store}"
 * in the Stock levels panel, "Change values for {store}" in the Store overrides panel) must fit
 * inside their panel, whose `overflow: hidden` would otherwise cut the label (RT-1187 measured
 * 4.4 px and 29.3 px at 390 wide in English). Run in CI only (owner rule: no browser on the
 * owner's laptop), through the `admin-captures` workflow with the same mocks as `screens.ts`.
 *
 * Unlike the RT-1187 probe this one asserts. For each button, locale and width it measures the
 * button and its label against every clipping ancestor, the button's height (36 px target) and
 * the page's horizontal scroll, and prints one `RT-1195-FIT` line so the run log carries the
 * numbers. It runs twice: with the mock's store label, and with a long store name written into
 * the label, which is what a real store may be called.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const HEIGHT = 800;
const WIDTHS = [390, 1280];
const TARGET_HEIGHT = 36;
const LONG_STORE = "Al Maadi Corniche Branch for Household Appliances and Electronics";

mkdirSync(OUT, { recursive: true });

const OVERRIDES = "section.section-panel:has(#catalog-detail-overrides)";
const STOCK_LEVELS = "section.section-panel:has(#catalog-detail-stock-levels)";

const CHANGE_VALUES = `${OVERRIDES} .catalog-detail__store-actions button`;
/** A second store, with a stock level, so the panel renders a per-store "Change" button too. */
const OTHER_STORE = {
  ...store,
  id: "0190f000-0000-7000-8000-0000000005a2",
  code: "ALX-2000",
  name: `${store.name} 2`,
};
const OTHER_STORE_LEVELS = {
  productId: PRODUCT,
  tenantLevel: null,
  storeLevels: [
    {
      storeId: OTHER_STORE.id,
      reorderLevel: "12.5000",
      criticalLevel: "3",
      updatedAt: "2026-10-07T10:30:00Z",
    },
  ],
};

const BUTTONS = [
  { name: "change-values", selector: CHANGE_VALUES },
  { name: "set-level", selector: `${STOCK_LEVELS} .catalog-retire__actions button` },
  // The tenant action sits in an `h3` head; a store row's head has an `h4`.
  {
    name: "change-store-level",
    selector: `${STOCK_LEVELS} .catalog-detail__store-head:has(h4) .catalog-detail__store-actions button`,
  },
  {
    name: "change-tenant-level",
    selector: `${STOCK_LEVELS} .catalog-detail__store-head:has(h3) .catalog-detail__store-actions button`,
  },
];

/** In the page. The button and its label against every clipping ancestor. */
const measure = ({ selector, longLabel }: { selector: string; longLabel: string | null }) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const original = el.textContent ?? "";
  if (longLabel) el.textContent = `${original} ${longLabel}`;
  const round = (n: number) => Math.round(n * 10) / 10;
  const own = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const label = range.getBoundingClientRect();
  const left = Math.min(own.left, label.left);
  const right = Math.max(own.right, label.right);
  const root = document.documentElement;
  const cut: Array<{ el: string; pastStart: number; pastEnd: number }> = [];
  for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
    if (getComputedStyle(a).overflowX === "visible") continue;
    const aLeft = a.getBoundingClientRect().left + a.clientLeft;
    const aRight = aLeft + a.clientWidth;
    if (left < aLeft - 0.5 || right > aRight + 0.5) {
      cut.push({
        el: `${a.tagName.toLowerCase()}.${String(a.className).trim().split(/\s+/).join(".")}`,
        pastStart: round(Math.max(0, aLeft - left)),
        pastEnd: round(Math.max(0, right - aRight)),
      });
    }
  }
  return {
    text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 100),
    left: round(left),
    right: round(right),
    height: round(own.height),
    labelWithinButton: label.left >= own.left - 0.5 && label.right <= own.right + 0.5,
    outsideViewport: left < -0.5 || right > root.clientWidth + 0.5,
    pageScrollsX: root.scrollWidth > root.clientWidth,
    cut,
  };
};

async function open(page: Page, width: number): Promise<void> {
  const screen = SCREENS.find((s) => s.slug === "detail-product");
  expect(screen, "screen detail-product").toBeDefined();
  if (!screen) return;
  await page.clock.setFixedTime(FIXED_NOW);
  await screen.mock(page);
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store, OTHER_STORE])));
  await page.route(`**/api/v1/catalog/products/${PRODUCT}/stock-levels`, (r) =>
    r.fulfill(json(OTHER_STORE_LEVELS)),
  );
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(screen.route);
  await expect(page.locator(CHANGE_VALUES).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

for (const width of WIDTHS) {
  for (const long of [false, true]) {
    test(`RT-1195 store buttons fit at ${width}${long ? " (long store name)" : ""}`, async ({
      page,
      appLocale,
    }) => {
      await open(page, width);
      const results: Array<{ button: string } & NonNullable<ReturnType<typeof measure>>> = [];
      const absent: string[] = [];
      for (const b of BUTTONS) {
        const longLabel = long ? LONG_STORE : null;
        const m = (await page.locator(b.selector).count())
          ? await page.evaluate(measure, { selector: b.selector, longLabel })
          : null;
        if (m) results.push({ button: b.name, ...m });
        else absent.push(b.name);
      }
      const line = { locale: appLocale, width, long, absent, results };
      writeFileSync(
        join(OUT, `RT-1195__${appLocale}__${width}${long ? "__long" : ""}.json`),
        `${JSON.stringify(line, null, 2)}\n`,
      );
      console.log(`RT-1195-FIT ${JSON.stringify(line)}`);

      // The buttons RT-1187 measured, and the two other kinds of store button, must all exist.
      for (const name of BUTTONS.map((b) => b.name)) {
        expect(absent, `${name} found`).not.toContain(name);
      }
      for (const r of results) {
        const where = `${r.button} (${appLocale}, ${width}${long ? ", long" : ""})`;
        expect(r.cut, `${where} is cut by an ancestor`).toEqual([]);
        expect(r.outsideViewport, `${where} is outside the viewport`).toBe(false);
        expect(r.labelWithinButton, `${where} label spills out of the button`).toBe(true);
        expect(r.height, `${where} keeps the 36 px target`).toBeGreaterThanOrEqual(TARGET_HEIGHT);
        expect(r.pageScrollsX, `${where} page scrolls horizontally`).toBe(false);
      }
    });
  }
}
