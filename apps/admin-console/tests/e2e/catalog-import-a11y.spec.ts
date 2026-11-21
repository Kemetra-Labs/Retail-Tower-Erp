import { expectNoAxeViolations } from "./axe";
import {
  AMBIGUOUS_ROW,
  BATCH_ID,
  COUNTS,
  ERROR_ROW,
  batchBody,
  mockImportApi,
  previewBody,
  row,
  validatedBatch,
} from "./catalog-import-mock";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-1509 accessibility acceptance across the seven steps, against a mocked Backend-Core (C-5):
 *   K1 a keyboard-only walk reaches the step's controls in a sensible order, and every stop draws a
 *      real outline (not a box-shadow, which forced colours drop), in normal and forced-colours mode;
 *   K2 a keyboard-only publish, from Preview to the Result, with the modal's Tab trap;
 *   F1 forced colours: the current step node and the selected status filter carry a 3px border.
 * axe (WCAG 2.1 A/AA) runs on each step in the other specs; here it runs on every step again in
 * forced-colours mode. Runs in both locales; copy comes from the catalog (`t`).
 */
const READY = { ...COUNTS, needs_review: 0, error: 0 };

interface Stop {
  name: string;
  outlineStyle: string;
  outlineWidth: number;
}

async function activeStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body)
      return { name: "<body>", outlineStyle: "none", outlineWidth: 0 };
    const style = getComputedStyle(el);
    const name =
      el.getAttribute("aria-label") ||
      (el as HTMLInputElement).labels?.[0]?.textContent ||
      el.textContent ||
      el.tagName;
    return {
      name: name.replace(/\s+/g, " ").trim().slice(0, 80),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
}

/** Presses Tab from the page start until focus leaves the content or `max` stops are seen. */
async function walk(page: Page, max: number): Promise<Stop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page
    .locator("main, body")
    .first()
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  const stops: Stop[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    stops.push(await activeStop(page));
  }
  return stops;
}

const STEPS: {
  name: string;
  url: string;
  setup: (fake: Awaited<ReturnType<typeof mockImportApi>>) => void;
  reaches: (t: (k: never) => string) => string[];
}[] = [
  {
    name: "upload",
    url: "/catalog/import",
    setup: () => undefined,
    reaches: (t) => [
      t("catalogImport.upload.file.choose" as never),
      t("catalogImport.upload.template.link" as never),
    ],
  },
  {
    name: "map",
    url: `/catalog/import/${BATCH_ID}/map`,
    setup: (f) => {
      f.batch = batchBody();
    },
    reaches: (t) => [
      t("catalogImport.map.submit" as never),
      t("catalogImport.cancel.action" as never),
    ],
  },
  {
    name: "validate",
    url: `/catalog/import/${BATCH_ID}/validate`,
    setup: (f) => {
      f.batch = validatedBatch();
      f.rows = { all: [row(2, "ready_create"), ERROR_ROW] };
    },
    reaches: (t) => [
      t("catalogImport.validate.errorReport" as never),
      t("catalogImport.validate.toReview" as never),
    ],
  },
  {
    name: "review",
    url: `/catalog/import/${BATCH_ID}/review`,
    setup: (f) => {
      f.batch = validatedBatch({ counts: { ...COUNTS, needs_review: 1, error: 1 } });
      f.rows = { needs_review: [AMBIGUOUS_ROW], error: [ERROR_ROW] };
    },
    reaches: (t) => [
      (t as unknown as (k: string, p: object) => string)("catalogImport.review.openRow", {
        row: 31,
      }),
    ],
  },
  {
    name: "preview",
    url: `/catalog/import/${BATCH_ID}/preview`,
    setup: (f) => {
      f.batch = validatedBatch({ version: 4, counts: READY, publishable: true });
      f.preview = previewBody();
    },
    reaches: (t) => [
      t("catalogImport.preview.changes" as never),
      t("catalogImport.preview.publish" as never),
    ],
  },
  {
    name: "result",
    url: `/catalog/import/${BATCH_ID}/result`,
    setup: (f) => {
      f.batch = batchBody({
        state: "published",
        version: 5,
        publishedAt: "2026-11-21T19:47:00Z",
        counts: READY,
      });
      f.preview = previewBody();
    },
    reaches: (t) => [
      t("catalogImport.result.copy" as never),
      t("catalogImport.result.viewProducts" as never),
    ],
  },
];

for (const step of STEPS) {
  test(`K1: keyboard-only walk of ${step.name}: controls reachable, every stop has an outline, also in forced colours`, async ({
    page,
    t,
  }) => {
    const fake = await mockImportApi(page);
    step.setup(fake);
    await page.goto(step.url);
    await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
    await page.waitForLoadState("networkidle");

    for (const forced of [false, true]) {
      await page.emulateMedia({ forcedColors: forced ? "active" : "none" });
      const stops = await walk(page, 45);
      const names = stops.map((s) => s.name);
      for (const wanted of step.reaches(t as never)) {
        expect(
          names.some((n) => n.includes(wanted)),
          `${step.name} (forced=${forced}) reaches «${wanted}»`,
        ).toBe(true);
      }
      const bare = stops.filter(
        (s) => s.name !== "<body>" && (s.outlineStyle === "none" || s.outlineWidth === 0),
      );
      expect(
        bare.map((s) => s.name),
        `${step.name} (forced=${forced}) stops without an outline`,
      ).toEqual([]);
    }
    await expectNoAxeViolations(page, `${step.name} (forced colours)`);
  });
}

test("K2: a keyboard-only publish from the preview to the result", async ({ page, t }) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch({ version: 4, counts: READY, publishable: true });
  fake.preview = previewBody();
  await page.goto(`/catalog/import/${BATCH_ID}/preview`);
  await expect(
    page.getByRole("button", { name: t("catalogImport.preview.publish") }),
  ).toBeEnabled();

  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    if ((await activeStop(page)).name.includes(t("catalogImport.preview.publish"))) break;
  }
  expect((await activeStop(page)).name).toContain(t("catalogImport.preview.publish"));
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: t("catalogImport.publish.cancel") }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: t("catalogImport.publish.confirm") }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/result$/);
  await expect(
    page.getByRole("heading", { level: 2, name: t("catalogImport.step.result") }),
  ).toBeFocused();
});

test("F1: in forced colours the current step and the selected filter carry a 3px border", async ({
  page,
  t,
}) => {
  const fake = await mockImportApi(page);
  fake.batch = validatedBatch();
  fake.rows = { all: [row(2, "ready_create")], error: [ERROR_ROW] };
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(`/catalog/import/${BATCH_ID}/validate?status=error`);
  await expect(
    page.getByRole("heading", { level: 2, name: t("catalogImport.step.validate") }),
  ).toBeVisible();
  const current = page.locator('.import-stepper__node[aria-current="step"]');
  await expect(current).toHaveCSS("border-top-width", "3px");
  const pressed = page.locator('.import-band__item[aria-pressed="true"]');
  await expect(pressed).toHaveCSS("border-top-width", "3px");
  await expect(current).toContainText(t("catalogImport.step.validate"));
});
