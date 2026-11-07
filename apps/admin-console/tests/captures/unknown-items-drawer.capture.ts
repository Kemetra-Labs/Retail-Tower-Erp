import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Locator } from "@playwright/test";
import type { MessageKey, Params } from "../../src/i18n/translate";
import type { ReviewQueueItem } from "../../src/lib/unknown-items-queries";
import { LONG_TENANT, STORE, mockRealisticApi } from "../e2e/compact-shell-data";
import { type Page, expect, test } from "../e2e/fixtures";
import { FIXED_NOW, LONG_TENANT_AR, contextNamed, json } from "./screen-data";

/**
 * RT-1018: evidence captures of the Unknown items inspect drawer (`UnknownItemInspectDrawer`,
 * opened from a row of `/unknown-items`), which the route captures of `screens.ts` never open.
 * Run in CI only (owner rule: no browser on the owner's laptop), through the `admin-captures`
 * workflow, with a mocked Backend-Core: the inspect read (`GET /catalog/unknown-items/{id}`)
 * answers a `ReviewQueueItem` typed from the generated schema, or the failure under test.
 *
 * Each state of the drawer is one screen in `index.md` (slug `unknown-items-drawer-<state>`), in
 * the locale of the Playwright project, light theme, at 1280x800 and 390 wide. Like
 * `store-button-fit.capture.ts` it asserts, instead of only taking pictures: the drawer is
 * visible and named, focus lands inside it, its content is not clipped or pushed outside the
 * panel, the page does not scroll sideways, the Ink header names the tenant, the actions offered
 * follow the item's state, and Escape closes it. It also saves the axe results (WCAG 2.1 A/AA,
 * recorded, never asserted) and one `RT-1018-DRAWER` line per run with the measurements.
 *
 * The drawer has no empty state of its own (a queue with no rows has nothing to open, and a null
 * field renders the "—" mark), so the states are the ones the component renders: loading, a
 * pending item (and with long machine values and a long Arabic tenant name), a dismissed one, a
 * resolved one, not found (404), a failed read (500), and the create and dismiss-confirm steps.
 */

const OUT = process.env.CAPTURE_DIR ?? "playwright-report/captures";
const TICKET = "RT-1018";
const ROUTE = "/unknown-items";
const WIDTHS = [1280, 390] as const;
const HEIGHT = 800;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
/** The one row the queue lists (`compact-shell-data.ts`), whose «Open» button opens the drawer. */
const LIST_ROW = { id: "u1", value: "5012345678900123" };
const INSPECT = `**/api/v1/catalog/unknown-items/${LIST_ROW.id}`;
const ISSUED_AT = "2026-06-10T10:00:00Z";
const RESOLVED_AT = "2026-06-11T08:30:00Z";
const ACTOR = "0190f000-0000-7000-8000-0000000003a1";

const LONG_VALUE = `EXT-${"0123456789".repeat(7)}`;
const LONG_SOURCE = "pos-windows-lab-cairo-festival-city-front-lane-terminal-07-night-shift";

mkdirSync(OUT, { recursive: true });

type TFn = (key: MessageKey, params?: Params) => string;

const base: ReviewQueueItem = {
  id: LIST_ROW.id,
  tenant_id: "t1",
  store_id: STORE,
  identifier_type: "barcode",
  identifier_value: LIST_ROW.value,
  source_system: null,
  resolution_status: "pending",
  resolution_action: null,
  resolved_at: null,
  resolved_by: null,
  encountered_at: ISSUED_AT,
};
const PENDING = base;
const PENDING_LONG: ReviewQueueItem = {
  ...base,
  identifier_type: "external_pos_id",
  identifier_value: LONG_VALUE,
  source_system: LONG_SOURCE,
};
const DISMISSED: ReviewQueueItem = {
  ...base,
  resolution_status: "dismissed",
  resolution_action: "dismissed",
  resolved_at: RESOLVED_AT,
  resolved_by: ACTOR,
};
const RESOLVED: ReviewQueueItem = {
  ...base,
  resolution_status: "resolved",
  resolution_action: "linked",
  resolved_at: RESOLVED_AT,
  resolved_by: ACTOR,
};

const NOT_FOUND = json({ error: { code: "not_found", request_id: "req-rt1018-404" } }, 404);
const FAILED_READ = json({ error: { code: "system_failure", request_id: "req-rt1018-500" } }, 500);

type Answer = ReturnType<typeof json> | "hold";

interface DrawerState {
  slug: string;
  /** What the inspect read answers; "hold" never answers, which is the loading state. */
  answer: Answer;
  tenantName?: string;
  /** Visible in the drawer once the state has settled. */
  ready: (drawer: Locator, t: TFn) => Locator;
  /** Buttons the drawer offers besides Close; absent where a step shows its own controls. */
  actions?: Array<(t: TFn) => string>;
  /** A step the operator takes inside the drawer before the capture. */
  step?: (drawer: Locator, t: TFn) => Promise<void>;
  /** Failure states: the banner is recorded in `index.md`. */
  banner?: boolean;
  forcedColors?: boolean;
}

const STATES: DrawerState[] = [
  {
    slug: "loading",
    answer: "hold",
    ready: (d) => d.locator("output[aria-busy='true']"),
    actions: [],
  },
  {
    slug: "pending",
    answer: json(PENDING),
    ready: (d, t) => d.getByRole("button", { name: t("unknownItems.create.action") }),
    actions: [
      (t) => t("unknownItems.create.action"),
      (t) => t("unknownItems.link.action"),
      (t) => t("unknownItems.dismiss.action"),
    ],
    forcedColors: true,
  },
  {
    slug: "pending-long-values",
    answer: json(PENDING_LONG),
    ready: (d, t) => d.getByRole("button", { name: t("unknownItems.create.action") }),
    actions: [
      (t) => t("unknownItems.create.action"),
      (t) => t("unknownItems.link.action"),
      (t) => t("unknownItems.dismiss.action"),
    ],
  },
  {
    slug: "long-tenant",
    answer: json(PENDING),
    tenantName: LONG_TENANT_AR,
    ready: (d, t) => d.getByRole("button", { name: t("unknownItems.create.action") }),
    actions: [
      (t) => t("unknownItems.create.action"),
      (t) => t("unknownItems.link.action"),
      (t) => t("unknownItems.dismiss.action"),
    ],
  },
  {
    slug: "dismissed",
    answer: json(DISMISSED),
    ready: (d, t) => d.getByRole("button", { name: t("unknownItems.reopen.action") }),
    actions: [(t) => t("unknownItems.reopen.action")],
  },
  {
    slug: "resolved",
    answer: json(RESOLVED),
    ready: (d, t) => d.locator(".badge", { hasText: t("unknownItems.status.resolved") }),
    actions: [],
  },
  {
    slug: "not-found",
    answer: NOT_FOUND,
    ready: (d, t) => d.getByText(t("unknownItems.errors.notFound")),
    actions: [],
    banner: true,
  },
  {
    slug: "read-failed",
    answer: FAILED_READ,
    ready: (d, t) => d.getByText(t("errors.server")),
    actions: [],
    banner: true,
  },
  {
    slug: "create-step",
    answer: json(PENDING),
    ready: (d, t) => d.getByLabel(t("unknownItems.create.name")),
    step: (d, t) => d.getByRole("button", { name: t("unknownItems.create.action") }).click(),
  },
  {
    slug: "dismiss-step",
    answer: json(PENDING),
    ready: (d, t) =>
      d.getByRole("region", {
        name: t("components.confirmDelete.label", { action: t("unknownItems.dismiss.action") }),
      }),
    step: (d, t) =>
      d.getByRole("button", { name: t("unknownItems.dismiss.action"), exact: true }).click(),
  },
];

const stemOf = (state: DrawerState, locale: string) =>
  join(OUT, `${TICKET}__unknown-items-drawer-${state.slug}__${locale}`);

/** In the page. The drawer panel against its own box, the viewport and the page. */
const measureDrawer = () => {
  const dialog = document.querySelector<HTMLElement>("dialog.drawer:not(.drawer--start)");
  if (!dialog) return null;
  const round = (n: number) => Math.round(n * 10) / 10;
  const root = document.documentElement;
  const box = dialog.getBoundingClientRect();
  const body = dialog.querySelector<HTMLElement>(".drawer__body");
  const outside: Array<{ el: string; pastLeft: number; pastRight: number }> = [];
  for (const el of dialog.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const pastLeft = box.left - r.left;
    const pastRight = r.right - box.right;
    if (pastLeft > 0.5 || pastRight > 0.5) {
      const cls = String(el.getAttribute("class") ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(".");
      outside.push({
        el: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`,
        pastLeft: round(Math.max(0, pastLeft)),
        pastRight: round(Math.max(0, pastRight)),
      });
    }
  }
  return {
    viewport: root.clientWidth,
    left: round(box.left),
    right: round(box.right),
    panelWidth: round(box.width),
    dialogWithinViewport: box.left >= -0.5 && box.right <= root.clientWidth + 0.5,
    dialogScrollsX: dialog.scrollWidth > dialog.clientWidth + 1,
    bodyScrollsX: body ? body.scrollWidth > body.clientWidth + 1 : false,
    pageScrollsX: root.scrollWidth > root.clientWidth,
    focusInside: dialog.contains(document.activeElement),
    outside,
  };
};

/** Waits for every finite animation to finish, as tests/e2e/axe.ts does before axe. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

async function prepare(page: Page, state: DrawerState): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await mockRealisticApi(page);
  if (state.tenantName) {
    await page.route("**/api/v1/context/me", (r) =>
      r.fulfill(json(contextNamed(state.tenantName as string))),
    );
  }
  // Registered after the generic mocks, so it answers the inspect read of the one listed row.
  await page.route(INSPECT, (r) => {
    if (state.answer === "hold") return new Promise<void>(() => undefined);
    return r.fulfill(state.answer);
  });
}

async function openDrawer(page: Page, t: TFn, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(ROUTE);
  await page
    .getByRole("button", { name: t("table.selection.openRow", { value: LIST_ROW.value }) })
    .click();
  const drawer = page.getByRole("dialog", { name: t("unknownItems.drawer.title") });
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  return drawer;
}

interface Axe {
  violationCount: number;
  incompleteCount: number;
  passCount: number;
  violations: unknown[];
  incomplete: unknown[];
}

/** The axe run of tests/e2e/axe.ts, keeping the results instead of asserting them. */
async function runAxe(page: Page): Promise<Axe> {
  const results = await new AxeBuilder({
    page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"],
  })
    .withTags(AXE_TAGS)
    .analyze();
  return {
    violationCount: results.violations.length,
    incompleteCount: results.incomplete.length,
    passCount: results.passes.length,
    violations: results.violations,
    incomplete: results.incomplete,
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The axe, fit and banner files of one state, rewritten after each width so a failure keeps them. */
function writeEvidence(
  stem: string,
  axeByWidth: Record<number, Axe>,
  fit: Record<number, unknown>,
  banners: Record<number, number> | null,
): void {
  const all = Object.values(axeByWidth);
  writeJson(`${stem}__axe.json`, {
    tags: AXE_TAGS,
    violationCount: all.reduce((n, a) => n + a.violationCount, 0),
    incompleteCount: all.reduce((n, a) => n + a.incompleteCount, 0),
    byWidth: axeByWidth,
  });
  writeJson(`${stem}__fit.json`, fit);
  if (banners) writeFileSync(`${stem}__banner.json`, `${JSON.stringify(banners)}\n`);
}

for (const state of STATES) {
  test.describe(`${TICKET} unknown-items drawer: ${state.slug}`, () => {
    test("states at 1280 and 390", async ({ page, t, appLocale }) => {
      test.setTimeout(90_000);
      const stem = stemOf(state, appLocale);
      // Written first, so build-index.mjs expects this screen's files even if a capture fails.
      writeJson(`${stem}__meta.json`, {
        ticket: TICKET,
        slug: `unknown-items-drawer-${state.slug}`,
        route: ROUTE,
        denseRoute: null,
        locale: appLocale,
        variants: state.forcedColors ? ["normal", "forced-colors"] : ["normal"],
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await prepare(page, state);

      const axeByWidth: Record<number, Axe> = {};
      const fit: Record<number, unknown> = {};
      const banners: Record<number, number> = {};
      for (const width of WIDTHS) {
        const drawer = await openDrawer(page, t, width);
        const where = `${state.slug} (${appLocale}, ${width})`;
        await expect(
          drawer.getByRole("heading", { name: t("unknownItems.drawer.title") }),
        ).toBeVisible();
        // The Ink header names where the drawer acts: the tenant (RT-1018).
        await expect(drawer.locator(".drawer__scope"), `${where} scope line`).toContainText(
          state.tenantName ?? LONG_TENANT,
        );
        await state.step?.(drawer, t);
        await expect(state.ready(drawer, t).first(), `${where} ready`).toBeVisible();
        await settle(page);

        // The evidence first (picture, axe, measurements), so a finding below leaves its proof.
        const m = await page.evaluate(measureDrawer);
        expect(m, `${where} drawer measured`).not.toBeNull();
        if (!m) return;
        fit[width] = m;
        banners[width] = await drawer.locator(".rtc-alert").count();
        console.log(
          `RT-1018-DRAWER ${JSON.stringify({ state: state.slug, locale: appLocale, width, ...m })}`,
        );
        await page.screenshot({ path: `${stem}__${width}__normal.png`, animations: "disabled" });
        axeByWidth[width] = await runAxe(page);
        writeEvidence(stem, axeByWidth, fit, state.banner ? banners : null);

        if (state.actions) {
          // Close, plus the actions the item's state offers (VG-5: by state, not by role).
          await expect
            .soft(drawer.getByRole("button"), `${where} buttons`)
            .toHaveCount(1 + state.actions.length);
          for (const action of state.actions) {
            await expect
              .soft(drawer.getByRole("button", { name: action(t), exact: true }))
              .toBeVisible();
          }
        }
        // Content must not be cut by the panel or pushed past it, and the page must not scroll sideways.
        expect.soft(m.outside, `${where} content outside the panel`).toEqual([]);
        expect.soft(m.dialogWithinViewport, `${where} panel inside the viewport`).toBe(true);
        expect.soft(m.dialogScrollsX, `${where} panel scrolls sideways`).toBe(false);
        expect.soft(m.bodyScrollsX, `${where} panel body scrolls sideways`).toBe(false);
        expect.soft(m.pageScrollsX, `${where} page scrolls sideways`).toBe(false);
        // Focus lands inside on open, and stays inside after a step swaps in (RT-1234).
        expect.soft(m.focusInside, `${where} focus inside the drawer`).toBe(true);

        if (state.step) continue;
        // Escape closes it (reduced motion: at once).
        await page.keyboard.press("Escape");
        await expect.soft(drawer, `${where} Escape closes`).toHaveCount(0);
      }
      expect(errors, `${state.slug} uncaught page errors`).toEqual([]);
    });

    if (state.forcedColors) {
      test("forced-colors (C2)", async ({ page, t, appLocale }) => {
        await page.emulateMedia({ forcedColors: "active" });
        await prepare(page, state);
        const drawer = await openDrawer(page, t, 1280);
        await expect(state.ready(drawer, t).first()).toBeVisible();
        await settle(page);
        await page.screenshot({
          path: `${stemOf(state, appLocale)}__1280__forced-colors.png`,
          animations: "disabled",
        });
      });
    }
  });
}
