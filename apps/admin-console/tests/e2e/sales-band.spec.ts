/**
 * RT-1009 — the Sales band's facts in a real layout. From 1200px a band with
 * facts is one row within 132px and no fact value wraps; narrower it wraps its
 * facts and actions instead of clipping them; on a phone a long unbroken value
 * wraps rather than widening the page. A cross-year period is never cut.
 */
import { STORE, context, mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/** Wider than a phone at any font: it can only fit by wrapping. */
const UNBROKEN = "فرعكايروفستيفالسيتيمولالتجمعالخامسالقاهرةالجديدة".repeat(2);
const FROM = "2026-12-30";
const TO = "2027-01-29";

async function openList(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mockRealisticApi(page, {
    ...context,
    active_store: { id: STORE, name: UNBROKEN },
  });
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: STORE, name: UNBROKEN, timezone: "Africa/Cairo", is_active: true },
      ]),
    }),
  );
  await page.route("**/api/v1/sales?**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        nextCursor: null,
        asOf: "2027-01-29T12:15:00Z",
        storeRef: STORE,
        storeTimezone: "Africa/Cairo",
        from: FROM,
        to: TO,
      }),
    }),
  );
  await page.goto(`/sales?store=${STORE}&from=${FROM}&to=${TO}`);
  await page.locator("dl.list-band__facts").waitFor();
}

interface BandLayout {
  height: number;
  /** The store name renders whole: its text is not cut by its own box. */
  nameWhole: boolean;
  allInside: boolean;
  pageOverflow: number;
  periodLines: number;
  periodText: string;
}

/**
 * Where the band's facts and actions land, measured on their text. `allowCut`
 * (from 640px) measures a name cut on purpose by its clipped box; without it
 * (a phone) every value is measured by its text, so no clip can hide.
 */
function measure(page: Page, allowCut: boolean): Promise<BandLayout> {
  return page.evaluate((allowCut) => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    const box = band.getBoundingClientRect();
    const parts = [...band.querySelectorAll("dd, .list-band__end")];
    const allInside = parts.every((el) => {
      // A name cut on purpose is measured by its clipped box; any other value by its text.
      const cut = allowCut ? el.querySelector(".list-band__trunc") : null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = cut ? cut.getBoundingClientRect() : range.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    const period = band.querySelectorAll("dd")[1] as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(period);
    const lineTops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
    const name = band.querySelector(".list-band__trunc") as HTMLElement;
    return {
      height: Math.round(box.height),
      nameWhole: name.scrollWidth <= name.clientWidth + 1,
      allInside,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      periodLines: lineTops.size,
      periodText: period.textContent ?? "",
    };
  }, allowCut);
}

test("1280: one row within 132px, the cross-year period whole on one line", async ({ page }) => {
  await openList(page, 1280);
  const layout = await measure(page, true);
  expect(layout.height).toBeLessThanOrEqual(132);
  expect(layout.allInside).toBe(true);
  expect(layout.periodLines).toBe(1);
  expect(layout.periodText).toMatch(/2026.*2027/);
  expect(layout.pageOverflow).toBe(0);
});

test("900: the band wraps its facts and actions rather than clipping them", async ({ page }) => {
  await openList(page, 900);
  const layout = await measure(page, true);
  expect(layout.allInside).toBe(true);
  expect(layout.periodText).toMatch(/2026.*2027/);
  expect(layout.pageOverflow).toBe(0);
});

test("390: a long unbroken store name wraps; the page never scrolls sideways", async ({ page }) => {
  await openList(page, 390);
  const layout = await measure(page, false);
  // The fixture's unbroken name is the one rendered, so the wrap is really exercised.
  await expect(page.locator("dl.list-band__facts dd").first()).toHaveText(UNBROKEN);
  // On a phone the name is never cut: it wraps whole.
  expect(layout.nameWhole).toBe(true);
  expect(layout.allInside).toBe(true);
  expect(layout.pageOverflow).toBe(0);
});
