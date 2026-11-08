import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, mockRealisticApi } from "../e2e/compact-shell-data";
import { type Page, expect, test } from "../e2e/fixtures";
import { FIXED_NOW, MEMBERS, json, member, rows } from "./screen-data";

/**
 * RT-1293 (from RT-1289 F5 and F7, RT-1291): navigation evidence captures, run in CI
 * only (owner rule: no browser on the owner's laptop). Test code only: no production
 * file changes. Three groups, in the locale of the Playwright project, light theme,
 * mocked Backend-Core:
 *
 * 1. the sidebar with every group visible (1280 x 1400) and the compact drawer open
 *    at 390 wide, with a measurement of whether any heading is clipped;
 * 2. the header band of the pages RT-1291 moved into "Daily" and "Stock and items";
 * 3. `/audit` and `/operators` for owner, store_manager and cashier, with the API
 *    answering as Backend-Core does on `main` (audit 403, members 404 for a denied role).
 *
 * A capture records what it finds in `*__findings.json`; it does not fail on what a page
 * shows (a denied role landing on an error is a finding, not a failure). The files
 * deliberately do not end `__meta.json`, so `build-index.mjs` ignores them.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const HEIGHT = 800;
const FULL_SIDEBAR_HEIGHT = 1400;
const TICKET = "RT-1293";

mkdirSync(OUT, { recursive: true });

const file = (slug: string, locale: string, suffix: string) =>
  join(OUT, `${TICKET}__${slug}__${locale}__${suffix}`);

const roleContext = (role: string) => ({
  ...context,
  active_role_code: role,
  memberships: context.memberships.map((m) => ({ ...m, role_code: role })),
});

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

/** What the page shows, as text: the evidence that outlives a screenshot. */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const text = (e: Element) => e.textContent?.trim() ?? "";
    return {
      path: location.pathname,
      h1: [...document.querySelectorAll("h1")].map(text),
      bandGroup: document.querySelector(".list-band__group")?.textContent?.trim() ?? null,
      banners: [...document.querySelectorAll("main .rtc-alert")].map(text),
      navSections: [...document.querySelectorAll(".nav-section")].map(text),
      navEntries: [...document.querySelectorAll(".nav-entry__label")].map(text),
      mainText: (document.querySelector("main")?.textContent ?? "").trim().slice(0, 400),
    };
  });
}

async function open(page: Page, route: string, width: number, height = HEIGHT) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.setViewportSize({ width, height });
  await page.goto(route);
  await page.locator("main").first().waitFor({ state: "visible", timeout: 20_000 });
  await settle(page);
}

function write(path: string, body: unknown): void {
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

test.describe(`${TICKET} sidebar and drawer`, () => {
  test("sidebar shows every group at 1280", async ({ page, appLocale }) => {
    await mockRealisticApi(page);
    await open(page, "/", 1280, FULL_SIDEBAR_HEIGHT);
    await page.screenshot({
      path: file("sidebar", appLocale, "1280.png"),
      animations: "disabled",
    });
    write(file("sidebar", appLocale, "findings.json"), await snapshot(page));
  });

  test("compact drawer open at 390 and its headings do not clip", async ({
    page,
    t,
    appLocale,
  }) => {
    await mockRealisticApi(page);
    await open(page, "/", 390);
    await page.getByRole("button", { name: t("shell.menu"), exact: true }).click();
    await page.locator(".nav-section:visible").first().waitFor({ timeout: 10_000 });
    await settle(page);
    await page.screenshot({ path: file("drawer", appLocale, "390.png"), animations: "disabled" });
    const headings = await page.locator(".nav-section:visible").evaluateAll((els) =>
      els.map((e) => ({
        text: e.textContent?.trim() ?? "",
        clipped: e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight,
        width: e.clientWidth,
        scrollWidth: e.scrollWidth,
      })),
    );
    write(file("drawer", appLocale, "findings.json"), { headings, ...(await snapshot(page)) });
    expect(headings.length, "the open drawer shows its group headings").toBeGreaterThan(0);
  });
});

/** Pages RT-1291 moved: the band's group label must be the heading of the group that holds them. */
const BAND_PAGES = [
  { slug: "band-items", route: "/catalog/products" },
  { slug: "band-devices", route: "/devices" },
  { slug: "band-shift-closes", route: "/shift-closes" },
  { slug: "band-inventory", route: "/inventory" },
  { slug: "band-stock-discrepancies", route: "/stock-discrepancies" },
  { slug: "band-tracking", route: "/tracking" },
] as const;

test.describe(`${TICKET} header bands`, () => {
  for (const p of BAND_PAGES) {
    test(`${p.slug} (${p.route})`, async ({ page, appLocale }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await mockRealisticApi(page);
      await page.route("**/api/v1/catalog/tracking-summary", (r) =>
        r.fulfill(json({ hasTrackedProducts: true })),
      );
      const found: Record<number, Awaited<ReturnType<typeof snapshot>>> = {};
      for (const width of [1280, 390]) {
        await open(page, p.route, width);
        await page.screenshot({
          path: file(p.slug, appLocale, `${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
        found[width] = await snapshot(page);
      }
      write(file(p.slug, appLocale, "findings.json"), { route: p.route, errors, found });
      expect(errors, `${p.route} threw a page error`).toEqual([]);
    });
  }
});

const ROLES = [
  { role: "owner", denied: false },
  { role: "store_manager", denied: true },
  { role: "cashier", denied: true },
] as const;

test.describe(`${TICKET} Audit and Operators by role`, () => {
  for (const { role, denied } of ROLES) {
    test(`${role}: sidebar, /audit and /operators`, async ({ page, appLocale }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await mockRealisticApi(page, roleContext(role));
      // As Backend-Core answers on main: GET /audit/events denies with 403, GET /tenants/:id/members with 404.
      await page.route("**/api/v1/audit/events**", (r) =>
        r.fulfill(
          denied
            ? json({ code: "forbidden", message: "Forbidden" }, 403)
            : json({ items: [], next_cursor: null }),
        ),
      );
      await page.route(MEMBERS, (r) =>
        r.fulfill(
          denied ? json({ code: "not_found", message: "Not Found" }, 404) : json(rows(7, member)),
        ),
      );
      const result: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
      await open(page, "/", 1280, FULL_SIDEBAR_HEIGHT);
      await page.screenshot({
        path: file(`role-${role}-sidebar`, appLocale, "1280.png"),
        animations: "disabled",
      });
      result["/"] = await snapshot(page);
      for (const route of ["/audit", "/operators"]) {
        await open(page, route, 1280);
        await page.screenshot({
          path: file(`role-${role}${route.replace("/", "-")}`, appLocale, "1280.png"),
          fullPage: true,
          animations: "disabled",
        });
        result[route] = await snapshot(page);
      }
      write(file(`role-${role}`, appLocale, "findings.json"), {
        role,
        apiStatus: denied ? { audit: 403, members: 404 } : { audit: 200, members: 200 },
        errors,
        result,
      });
    });
  }
});
