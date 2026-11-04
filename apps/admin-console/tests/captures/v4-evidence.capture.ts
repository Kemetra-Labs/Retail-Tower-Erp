import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "../e2e/fixtures";
import { FAILED, FIXED_NOW, LONG_TENANT_AR, contextNamed, json } from "./screen-data";
import { SCREENS, type Screen } from "./screens";

/**
 * RT-1118: the v4.0 C2/C4 evidence captures, run in CI only (owner rule: no
 * browser on the owner's laptop). For every screen in `screens.ts`, in the
 * locale of the Playwright project, light theme, at 1280x800 and 390 wide:
 * normal, a banner under the band (its primary read fails), a long Arabic
 * tenant name and a dense table; plus forced colours at 1280 (C2) and the axe
 * results as JSON. Reduced motion is on for every capture (the config), so
 * nothing that pulses is caught mid-frame.
 *
 * A capture never fails on what it shows. It fails only when the route does
 * not render: neither an `<h1>` nor a banner, the in-shell route error, the root crash screen, or an
 * uncaught page error.
 *
 * Files land flat in CAPTURE_DIR as `<ticket>__<slug>__<locale>__<width>__<variant>.png`,
 * `<ticket>__<slug>__<locale>__axe.json` and `<ticket>__<slug>__<locale>__meta.json`;
 * `build-index.mjs` turns them into `index.md`.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const WIDTHS = [1280, 390] as const;
const HEIGHT = 800;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** The shared Banner (src/components/Banner.tsx) inside the page, below the band. */
const BANNER = "main .rtc-alert";

type Variant = "normal" | "banner" | "long-tenant" | "dense";

mkdirSync(OUT, { recursive: true });

const base = (s: Screen, locale: string) => join(OUT, `${s.ticket}__${s.slug}__${locale}`);

/** Records uncaught page errors, so a crash that keeps an `<h1>` still fails. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function prepare(page: Page, s: Screen, variant: Variant): Promise<string> {
  await page.clock.setFixedTime(FIXED_NOW);
  await s.mock(page);
  if (variant === "banner" && s.failRead) {
    await page.route(s.failRead, (r) => r.fulfill(FAILED));
  }
  if (variant === "dense" && s.dense) await s.dense.mock(page);
  if (variant === "long-tenant") {
    await page.route("**/api/v1/context/me", (r) => r.fulfill(json(contextNamed(LONG_TENANT_AR))));
  }
  return variant === "dense" ? (s.dense?.route ?? s.route) : s.route;
}

/** Waits for every finite animation to finish, as tests/e2e/axe.ts does before axe. */
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

async function expectRendered(
  page: Page,
  t: (key: "app.routeError.title" | "app.crash.title") => string,
  errors: string[],
  label: string,
): Promise<void> {
  // A detail page whose read failed shows its banner with no `<h1>`: that is a state, not a crash.
  const ready = page.getByRole("heading", { level: 1 }).or(page.locator(BANNER)).first();
  await expect(ready, label).toBeVisible({
    timeout: 20_000,
  });
  await settle(page);
  for (const key of ["app.routeError.title", "app.crash.title"] as const) {
    await expect(page.getByRole("heading", { name: t(key), exact: true }), label).toHaveCount(0);
  }
  expect(errors, label).toEqual([]);
}

async function shoot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: `${file}.png`, fullPage: true, animations: "disabled" });
}

/**
 * The axe run of tests/e2e/axe.ts (same WCAG 2.1 A/AA tags, same settle step,
 * same type cast), saving the results instead of asserting them: that helper
 * only offers the asserting form, and a capture must not fail on a finding.
 */
async function saveAxe(page: Page, file: string): Promise<void> {
  const results = await new AxeBuilder({
    page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"],
  })
    .withTags(AXE_TAGS)
    .analyze();
  const summary = {
    url: results.url,
    timestamp: results.timestamp,
    testEngine: results.testEngine,
    tags: AXE_TAGS,
    violationCount: results.violations.length,
    incompleteCount: results.incomplete.length,
    passCount: results.passes.length,
    violations: results.violations,
    incomplete: results.incomplete,
    passes: results.passes.map((p) => ({ id: p.id, nodes: p.nodes.length })),
  };
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
}

for (const s of SCREENS) {
  test.describe(`${s.ticket} ${s.slug} (${s.route})`, () => {
    const variants: Variant[] = ["normal", "long-tenant"];
    if (s.failRead) variants.push("banner");
    if (s.dense) variants.push("dense");

    for (const variant of variants) {
      test(variant, async ({ page, t, appLocale }) => {
        if (variant === "normal") {
          // Written first, so build-index.mjs expects this screen's files even if a capture fails.
          const meta = {
            ticket: s.ticket,
            slug: s.slug,
            route: s.route,
            denseRoute: s.dense?.route ?? null,
            locale: appLocale,
            variants: [...variants, "forced-colors"],
          };
          writeFileSync(`${base(s, appLocale)}__meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
        }
        const errors = watchErrors(page);
        const route = await prepare(page, s, variant);
        const banners: Record<number, number> = {};
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: HEIGHT });
          await page.goto(route);
          await expectRendered(page, t, errors, `${route} ${variant} ${width}`);
          // The error state is recorded (index.md), not asserted: a capture fails only on a crash.
          if (variant === "banner") {
            banners[width] = await page.locator(s.errorSelector ?? BANNER).count();
          }
          await shoot(page, `${base(s, appLocale)}__${width}__${variant}`);
          if (variant === "normal" && width === 1280) {
            await saveAxe(page, `${base(s, appLocale)}__axe.json`);
          }
        }
        if (variant === "banner") {
          writeFileSync(`${base(s, appLocale)}__banner.json`, `${JSON.stringify(banners)}\n`);
        }
      });
    }

    test("forced-colors (C2)", async ({ page, t, appLocale }) => {
      const errors = watchErrors(page);
      await page.emulateMedia({ forcedColors: "active" });
      const route = await prepare(page, s, "normal");
      await page.setViewportSize({ width: 1280, height: HEIGHT });
      await page.goto(route);
      await expectRendered(page, t, errors, `${route} forced-colors`);
      await shoot(page, `${base(s, appLocale)}__1280__forced-colors`);
    });
  });
}
