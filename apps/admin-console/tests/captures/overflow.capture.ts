import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "../e2e/fixtures";
import { FIXED_NOW } from "./screen-data";
import { SCREENS } from "./screens";

/**
 * RT-1187 (Verification): do three Admin Console regions scroll or clip? A still PNG cannot say.
 * Run in CI only (owner rule: no browser on the owner's laptop), through the `admin-captures`
 * workflow with the same mocks as `screens.ts`. For each region it records, per locale:
 *
 * - the scroll container: computed `overflow-x`, `scrollWidth` vs `clientWidth`, whether it is a
 *   tab stop and what names it;
 * - for each cut-off candidate (the last cell of a table, a panel button): whether any ancestor
 *   excludes it at rest, and whether a real keyboard user reaches it (Tab to the region, then
 *   the arrow key that scrolls toward the inline end; or Tab to the button).
 *
 * It never fails on what it finds (a verdict is the result), only when a region or element is
 * missing. It writes `RT-1187__<region>__<locale>__<width>.json` into CAPTURE_DIR and prints one
 * `RT-1187-OVERFLOW` line per region, so the run log carries the result without the artifact.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const HEIGHT = 800;
const MAX_TABS = 250;
const MAX_ARROWS = 100;

mkdirSync(OUT, { recursive: true });

interface Target {
  name: string;
  selector: string;
  /** `region-arrows`: Tab to the scroll region, then arrow toward the inline end. */
  method: "region-arrows" | "tab-to-element";
}

interface Region {
  id: string;
  slug: string;
  width: number;
  /** The scroll region of a table. Absent for a button that sits in no scroll region. */
  scroller?: string;
  ready: string;
  targets: Target[];
}

// The Overview's panel is a `div.section-panel`, not a `section`.
const OVERVIEW = ".section-panel:has(#overview-recent) .data-table__scroll";
const IDENTIFIERS = "section.section-panel:has(#catalog-detail-identifiers) .data-table__scroll";
const OVERRIDES = "section.section-panel:has(#catalog-detail-overrides)";
const STOCK_LEVELS = "section.section-panel:has(#catalog-detail-stock-levels)";

const lastCells = (scroller: string, label: string): Target[] => [
  {
    name: `${label} header (last)`,
    selector: `${scroller} thead th:last-child`,
    method: "region-arrows",
  },
  {
    name: `${label} first row (last cell)`,
    selector: `${scroller} tbody tr:first-child td:last-child`,
    method: "region-arrows",
  },
];

const REGIONS: Region[] = [
  {
    id: "overview-latest-sales",
    slug: "overview",
    width: 1280,
    scroller: OVERVIEW,
    ready: `${OVERVIEW} tbody tr`,
    targets: lastCells(OVERVIEW, "ERPNext"),
  },
  {
    id: "sales-list",
    slug: "sales-list",
    width: 1280,
    scroller: "main .data-table__scroll",
    ready: "main .data-table__scroll tbody tr",
    targets: lastCells("main .data-table__scroll", "status"),
  },
  {
    id: "catalog-identifiers",
    slug: "detail-product",
    width: 390,
    scroller: IDENTIFIERS,
    ready: `${IDENTIFIERS} tbody tr`,
    targets: [
      ...lastCells(IDENTIFIERS, "Actions"),
      {
        name: "Retire button (first row)",
        selector: `${IDENTIFIERS} .catalog-identifiers__action button`,
        method: "tab-to-element",
      },
    ],
  },
  {
    id: "catalog-change-values-button",
    slug: "detail-product",
    width: 390,
    ready: `${OVERRIDES} .catalog-detail__store-actions button`,
    targets: [
      {
        name: "Change values for {store}",
        selector: `${OVERRIDES} .catalog-detail__store-actions button`,
        method: "tab-to-element",
      },
    ],
  },
  {
    id: "catalog-set-level-button",
    slug: "detail-product",
    width: 390,
    ready: `${STOCK_LEVELS} .catalog-retire__actions button`,
    targets: [
      {
        name: "Set a level for {store}",
        selector: `${STOCK_LEVELS} .catalog-retire__actions button`,
        method: "tab-to-element",
      },
    ],
  },
];

/** In the page. The element and the content that overflows it, against every clipping ancestor. */
const measure = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const round = (n: number) => Math.round(n * 10) / 10;
  const describe = (n: Element) => {
    const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).join(".") : "";
    return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${cls ? `.${cls}` : ""}`;
  };
  const own = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const content = range.getBoundingClientRect();
  const hasContent = content.width > 0 || content.height > 0;
  const left = hasContent ? Math.min(own.left, content.left) : own.left;
  const right = hasContent ? Math.max(own.right, content.right) : own.right;
  const root = document.documentElement;
  const excluders: Array<{
    el: string;
    overflowX: string;
    scrollWidth: number;
    clientWidth: number;
    pastStart: number;
    pastEnd: number;
  }> = [];
  for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
    const overflowX = getComputedStyle(a).overflowX;
    if (overflowX === "visible") continue;
    const aLeft = a.getBoundingClientRect().left + a.clientLeft;
    const aRight = aLeft + a.clientWidth;
    if (left < aLeft - 1 || right > aRight + 1) {
      excluders.push({
        el: describe(a),
        overflowX,
        scrollWidth: a.scrollWidth,
        clientWidth: a.clientWidth,
        pastStart: round(Math.max(0, aLeft - left)),
        pastEnd: round(Math.max(0, right - aRight)),
      });
    }
  }
  return {
    el: describe(el),
    text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
    left: round(left),
    right: round(right),
    width: round(right - left),
    viewport: root.clientWidth,
    outsideViewport: left < -1 || right > root.clientWidth + 1,
    pageScrollWidth: root.scrollWidth,
    excluders,
  };
};

/** In the page. The scroll container's own numbers. */
const describeScroller = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const labelledBy = el.getAttribute("aria-labelledby");
  return {
    el: `${el.tagName.toLowerCase()}.${el.className}`,
    overflowX: cs.overflowX,
    direction: cs.direction,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrolls: el.scrollWidth > el.clientWidth,
    tabIndex: el.tabIndex,
    labelledBy,
    accessibleName: labelledBy ? (document.getElementById(labelledBy)?.textContent ?? null) : null,
  };
};

type Measured = NonNullable<ReturnType<typeof measure>>;
type Verdict =
  | "fits"
  | "scrolls-reachable"
  | "clipped-at-rest-reachable-only-by-focus"
  | "clipped-unreachable"
  | "not-found";

const isCut = (m: Measured): boolean => m.excluders.length > 0 || m.outsideViewport;

function verdictOf(rest: Measured | null, after: Measured | null): Verdict {
  if (!rest || !after) return "not-found";
  if (!isCut(rest)) return "fits";
  if (isCut(after)) return "clipped-unreachable";
  const hides = rest.excluders.some((e) => e.overflowX === "hidden" || e.overflowX === "clip");
  return hides ? "clipped-at-rest-reachable-only-by-focus" : "scrolls-reachable";
}

async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".data-table__scroll")) el.scrollLeft = 0;
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

/** Presses Tab from the top of the page until `selector` is the focused element. */
async function tabTo(page: Page, selector: string): Promise<number | null> {
  for (let presses = 1; presses <= MAX_TABS; presses++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate(
      (s) => document.activeElement === document.querySelector(s),
      selector,
    );
    if (hit) return presses;
  }
  return null;
}

/** With the region focused, arrows toward the inline end until it stops scrolling. */
async function arrowToEnd(
  page: Page,
  scroller: string,
): Promise<{ before: number; after: number }> {
  const read = () => page.evaluate((s) => document.querySelector(s)?.scrollLeft ?? 0, scroller);
  const rtl = await page.evaluate(
    () => getComputedStyle(document.documentElement).direction === "rtl",
  );
  const before = await read();
  let last = before;
  let still = 0;
  for (let i = 0; i < MAX_ARROWS && still < 2; i++) {
    await page.keyboard.press(rtl ? "ArrowLeft" : "ArrowRight");
    const now = await read();
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return { before, after: last };
}

async function probeTarget(page: Page, region: Region, target: Target) {
  await reset(page);
  const atRest = await page.evaluate(measure, target.selector);
  const focusSelector = target.method === "region-arrows" ? region.scroller : target.selector;
  const presses = focusSelector ? await tabTo(page, focusSelector) : null;
  const scrolled =
    target.method === "region-arrows" && region.scroller && presses !== null
      ? await arrowToEnd(page, region.scroller)
      : null;
  const afterReach = await page.evaluate(measure, target.selector);
  const maxScroll = region.scroller
    ? await atMaxScroll(page, region.scroller, target.selector)
    : null;
  return {
    name: target.name,
    method: target.method,
    focusReachedByTab: presses !== null,
    tabPresses: presses,
    scrollLeftBefore: scrolled?.before ?? null,
    scrollLeftAfter: scrolled?.after ?? null,
    atRest,
    afterReach,
    maxScroll,
    verdict: verdictOf(atRest, afterReach),
  };
}

/**
 * After the keyboard step: scrolls the region to its very end and measures again, with the
 * scroll offsets of every clipping ancestor. If the target is still cut here, no amount of
 * scrolling the region reveals it: it is clipped by an outer ancestor, not merely off-screen.
 */
async function atMaxScroll(page: Page, scroller: string, selector: string) {
  const state = await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) return null;
    const sign = getComputedStyle(el).direction === "rtl" ? -1 : 1;
    el.scrollLeft = sign * el.scrollWidth;
    const ancestors: Array<{
      el: string;
      overflowX: string;
      scrollLeft: number;
      scrollWidth: number;
      clientWidth: number;
    }> = [];
    for (let a: HTMLElement | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const overflowX = getComputedStyle(a).overflowX;
      if (overflowX === "visible") continue;
      const cls = typeof a.className === "string" ? a.className.trim().split(/\s+/).join(".") : "";
      ancestors.push({
        el: `${a.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`,
        overflowX,
        scrollLeft: a.scrollLeft,
        scrollWidth: a.scrollWidth,
        clientWidth: a.clientWidth,
      });
    }
    return ancestors;
  }, scroller);
  const measured = await page.evaluate(measure, selector);
  return { ancestors: state, measured, revealed: measured ? !isCut(measured) : null };
}

for (const region of REGIONS) {
  test(`RT-1187 ${region.id} at ${region.width}`, async ({ page, appLocale }) => {
    const screen = SCREENS.find((s) => s.slug === region.slug);
    expect(screen, `screen ${region.slug}`).toBeDefined();
    if (!screen) return;
    await page.clock.setFixedTime(FIXED_NOW);
    await screen.mock(page);
    await page.setViewportSize({ width: region.width, height: HEIGHT });
    await page.goto(screen.route);
    await expect(page.locator(region.ready).first(), region.ready).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);

    const container = region.scroller
      ? await page.evaluate(describeScroller, region.scroller)
      : null;
    if (region.scroller) expect(container, `scroll region ${region.scroller}`).not.toBeNull();
    const targets = [];
    for (const target of region.targets) targets.push(await probeTarget(page, region, target));
    for (const t of targets) expect(t.atRest, `${region.id}: ${t.name} found`).not.toBeNull();

    const result = {
      ticket: "RT-1187",
      region: region.id,
      locale: appLocale,
      route: screen.route,
      width: region.width,
      container,
      targets,
    };
    writeFileSync(
      join(OUT, `RT-1187__${region.id}__${appLocale}__${region.width}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    const line = {
      region: region.id,
      locale: appLocale,
      width: region.width,
      container: container && {
        overflowX: container.overflowX,
        scrollWidth: container.scrollWidth,
        clientWidth: container.clientWidth,
        tabIndex: container.tabIndex,
      },
      targets: targets.map((t) => ({
        name: t.name,
        verdict: t.verdict,
        tabs: t.tabPresses,
        scrollLeft: [t.scrollLeftBefore, t.scrollLeftAfter],
        maxScroll: t.maxScroll && {
          revealed: t.maxScroll.revealed,
          anc: t.maxScroll.ancestors,
          ex: t.maxScroll.measured?.excluders,
        },
        rest: t.atRest && { l: t.atRest.left, r: t.atRest.right, ex: t.atRest.excluders },
        after: t.afterReach && {
          l: t.afterReach.left,
          r: t.afterReach.right,
          ex: t.afterReach.excluders,
        },
      })),
    };
    console.log(`RT-1187-OVERFLOW ${JSON.stringify(line)}`);
  });
}
