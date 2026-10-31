/**
 * RT-1012 — the Stores list band and the store detail entity band in a real
 * layout. The list band holds the three whole-roster counts in one row within
 * 132px from 1200px; the detail band keeps the one h1 and is a plain light
 * header on a phone; the ornament is aria-hidden and gone narrow and under
 * forced colours; long unbroken Arabic names never widen the page; axe is clean.
 */
import { expectNoAxeViolations } from "./axe";
import { STORE, context, mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/** Wider than a phone at any font: it can only fit by wrapping. */
const UNBROKEN = "فرعكايروفستيفالسيتيمولالتجمعالخامسالقاهرةالجديدة".repeat(2);

const roster = [
  { id: STORE, code: "MAA", name: UNBROKEN, timezone: "Africa/Cairo", is_active: true },
  { id: "s2", code: "NSR", name: "فرع مدينة نصر", timezone: "Africa/Cairo", is_active: true },
  { id: "s3", code: "SZD", name: "Sheikh Zayed", timezone: "Africa/Cairo", is_active: true },
  { id: "s4", code: "DOK", name: "Dokki", timezone: "Africa/Cairo", is_active: true },
  { id: "s5", code: "ZMK", name: "Zamalek", timezone: "Africa/Cairo", is_active: false },
];

async function mockStores(page: Page): Promise<void> {
  await mockRealisticApi(page, context);
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roster) }),
  );
  await page.route(`**/api/v1/stores/${STORE}`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(roster[0]) }),
  );
}

async function openList(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await mockStores(page);
  await page.goto("/stores");
  await page.locator("dl.list-band__facts").waitFor();
}

async function openDetail(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await mockStores(page);
  await page.goto(`/stores/${STORE}`);
  await page.locator(".store-hero").waitFor();
}

const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("list 1280: three whole-roster facts in one row within 132px", async ({ page }) => {
  await openList(page, 1280);
  const facts = await page.locator("dl.list-band__facts dd").allInnerTexts();
  expect(facts.map((f) => f.replace(/\D/g, ""))).toEqual(["5", "4", "1"]);
  const layout = await page.evaluate(() => {
    const band = document.querySelector("header.list-band") as HTMLElement;
    const box = band.getBoundingClientRect();
    const inside = [...band.querySelectorAll("dd, .list-band__end")].every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    });
    return { height: Math.round(box.height), inside };
  });
  expect(layout.height).toBeLessThanOrEqual(132);
  expect(layout.inside).toBe(true);
  expect(await pageOverflow(page)).toBe(0);
  await expectNoAxeViolations(page, "stores list 1280");
});

test("list 390: a plain light header, the long name wraps, no sideways scroll", async ({
  page,
}) => {
  await openList(page, 390);
  const band = await page.evaluate(() => {
    const el = document.querySelector("header.list-band") as HTMLElement;
    const style = getComputedStyle(el);
    return { image: style.backgroundImage, bg: style.backgroundColor };
  });
  // Below 640px the band is not Ink: no grid or glow, a transparent ground.
  expect(band.image).toBe("none");
  expect(band.bg).toBe("rgba(0, 0, 0, 0)");
  expect(await pageOverflow(page)).toBe(0);
  await expectNoAxeViolations(page, "stores list 390");
});

test("detail 1280: one h1, the Ink band, ornament hidden from AT, sections 01-04", async ({
  page,
}) => {
  await openDetail(page, 1280);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const hero = await page.evaluate(() => {
    const el = document.querySelector(".store-hero") as HTMLElement;
    const art = el.querySelector(".store-hero__art") as HTMLElement;
    const h1 = el.querySelector("h1") as HTMLElement;
    const box = el.getBoundingClientRect();
    const r = h1.getBoundingClientRect();
    return {
      artHidden: art.getAttribute("aria-hidden"),
      artOpacity: Number(getComputedStyle(art).opacity),
      artShown: getComputedStyle(art).display !== "none",
      h1Inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      ink: getComputedStyle(el).backgroundColor,
    };
  });
  expect(hero.artHidden).toBe("true");
  expect(hero.artShown).toBe(true);
  expect(hero.artOpacity).toBeLessThanOrEqual(0.55);
  expect(hero.h1Inside).toBe(true);
  expect(hero.ink).not.toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator("section.detail-panel .section-index")).toHaveText([
    "01",
    "02",
    "03",
    "04",
  ]);
  expect(await pageOverflow(page)).toBe(0);
  await expectNoAxeViolations(page, "store detail 1280");
});

test("detail 390: a plain light header, no ornament, the long name wraps", async ({ page }) => {
  await openDetail(page, 390);
  const hero = await page.evaluate(() => {
    const el = document.querySelector(".store-hero") as HTMLElement;
    const art = el.querySelector(".store-hero__art") as HTMLElement;
    const style = getComputedStyle(el);
    return {
      artShown: getComputedStyle(art).display !== "none",
      image: style.backgroundImage,
      bg: style.backgroundColor,
    };
  });
  expect(hero.artShown).toBe(false);
  expect(hero.image).toBe("none");
  expect(hero.bg).toBe("rgba(0, 0, 0, 0)");
  expect(await pageOverflow(page)).toBe(0);
  await expectNoAxeViolations(page, "store detail 390");
});

test("detail, forced colours: the band maps to system colours and the ornament goes", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openDetail(page, 1280);
  const hero = await page.evaluate(() => {
    const el = document.querySelector(".store-hero") as HTMLElement;
    const art = el.querySelector(".store-hero__art") as HTMLElement;
    const style = getComputedStyle(el);
    return {
      artShown: getComputedStyle(art).display !== "none",
      image: style.backgroundImage,
      border: style.borderTopStyle,
    };
  });
  expect(hero.artShown).toBe(false);
  expect(hero.image).toBe("none");
  expect(hero.border).toBe("solid");
});
