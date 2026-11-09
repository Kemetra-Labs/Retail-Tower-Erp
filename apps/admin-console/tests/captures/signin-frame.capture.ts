import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "../e2e/fixtures";
import {
  FRAME_ROUTES,
  type FrameMeasure,
  mockSignedOut,
  openAndMeasure,
} from "../e2e/signin-frame-measure";

/**
 * RT-1301: evidence for the public night frame (sign-in and accept-invitation), taken in CI only
 * (owner rule: no browser on the owner's laptop), through the `admin-captures` workflow with
 * Backend-Core mocked signed out. For every route and AC1 size it saves a viewport screenshot and
 * a `RT-1301-FRAME` line with the measured form width, picture width, page height needed, logo
 * tile and tower box, then writes one table per route and locale. Two more captures: the
 * keyboard walk (focus outline on each stop) and an axe scan, both at 1280 x 720.
 *
 * It records what it finds; the guard that fails is `tests/e2e/signin-frame-fit.spec.ts`. The
 * files do not end `__meta.json`, so `build-index.mjs` ignores them.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const TICKET = "RT-1301";
const SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 901, height: 700 },
  { width: 1000, height: 700 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1366, height: 657 },
  { width: 1440, height: 900 },
];

mkdirSync(OUT, { recursive: true });

const row = (m: FrameMeasure) =>
  `| ${m.viewport.width} x ${m.viewport.height} | ${m.artWidth || "hidden"} | ${m.formWidth} | ` +
  `${m.neededHeight} | ${m.pageScrollsY ? "scrolls" : "fits"} | ` +
  `${m.pageScrollsX || m.mainClipsX || m.topClipsX ? "YES" : "no"} | ` +
  `${m.logo.width} x ${m.logo.height} | ${m.towerShown ? m.towerWidth : "hidden"} | ` +
  `${m.towerOverlaps.length ? m.towerOverlaps.join(", ") : "none"} |`;

for (const route of FRAME_ROUTES) {
  test(`RT-1301 frame sizes: ${route.name}`, async ({ page, appLocale }) => {
    test.setTimeout(120_000);
    await mockSignedOut(page);
    const rows: string[] = [];
    for (const size of SIZES) {
      const m = await openAndMeasure(page, route.path, size);
      console.log(
        `RT-1301-FRAME ${JSON.stringify({ route: route.name, locale: appLocale, ...m })}`,
      );
      rows.push(row(m));
      await page.screenshot({
        path: join(OUT, `${TICKET}__${route.name}__${appLocale}__${size.width}x${size.height}.png`),
      });
    }
    writeFileSync(
      join(OUT, `${TICKET}__${route.name}__${appLocale}__table.md`),
      [
        `# ${route.name} (${appLocale})`,
        "",
        "| Viewport | Picture | Form | Height needed | Page | Sideways overflow | Logo tile | Tower | Tower overlaps |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  });
}

test("RT-1301 AC6 baseline: touch heights, field direction and forced colours", async ({
  page,
  appLocale,
}) => {
  await mockSignedOut(page);
  const normal = await openAndMeasure(page, "/signin", { width: 1280, height: 720 });
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await openAndMeasure(page, "/signin", { width: 1280, height: 720 });
  await page.screenshot({ path: join(OUT, `${TICKET}__signin__${appLocale}__forced-colors.png`) });
  const ac6 = {
    locale: appLocale,
    fieldHeights: normal.fieldHeights,
    buttonHeight: normal.buttonHeight,
    inputDirections: normal.inputDirections,
    forcedColors: { artWidth: forced.artWidth, towerShown: forced.towerShown },
  };
  writeFileSync(
    join(OUT, `${TICKET}__signin__${appLocale}__ac6.json`),
    `${JSON.stringify(ac6, null, 2)}
`,
  );
  console.log(`RT-1301-AC6 ${JSON.stringify(ac6)}`);
});

test("RT-1301 keyboard walk and axe: signin", async ({ page, appLocale }) => {
  await mockSignedOut(page);
  await openAndMeasure(page, "/signin", { width: 1280, height: 720 });
  const stops: Array<Record<string, string | null>> = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`,
        focusVisible: String(el.matches(":focus-visible")),
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor,
        outlineOffset: s.outlineOffset,
      };
    });
    if (!stop) continue;
    stops.push(stop);
    await page.screenshot({
      path: join(OUT, `${TICKET}__signin__${appLocale}__focus-${stops.length}.png`),
    });
  }
  writeFileSync(
    join(OUT, `${TICKET}__signin__${appLocale}__focus.json`),
    `${JSON.stringify(stops, null, 2)}\n`,
  );
  console.log(`RT-1301-FOCUS ${JSON.stringify({ locale: appLocale, stops })}`);
  expect(stops.length, "the page has keyboard stops").toBeGreaterThan(0);

  // The run of tests/e2e/axe.ts (WCAG 2.1 A/AA), keeping the results instead of asserting them.
  const results = await new AxeBuilder({
    page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"],
  })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const axe = {
    locale: appLocale,
    violationCount: results.violations.length,
    incompleteCount: results.incomplete.length,
    passCount: results.passes.length,
    violations: results.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target.join(" ")),
    })),
  };
  writeFileSync(
    join(OUT, `${TICKET}__signin__${appLocale}__axe.json`),
    `${JSON.stringify(axe, null, 2)}\n`,
  );
  console.log(`RT-1301-AXE ${JSON.stringify(axe)}`);
});
