import { expect, test } from "./fixtures";
import { FRAME_ROUTES, mockSignedOut, openAndMeasure } from "./signin-frame-measure";

/**
 * RT-1301 (AC1 to AC5): the public night frame keeps its form at its designed width, fits common
 * laptop and phone heights, keeps the logo tile square and keeps the tower outline off the form.
 * Sign-in and accept-invitation share `AuthLayout`, so both are measured, in both locales.
 */

const WIDTHS = [320, 375, 768, 901, 1000, 1024, 1280, 1366, 1440];
const FORM_WIDTHS = [901, 950, 1000, 1050, 1100];
const FITS = [
  { width: 1366, height: 657 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 375, height: 667 },
];
const TOWER = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
];

for (const route of FRAME_ROUTES) {
  test.describe(route.name, () => {
    test.beforeEach(async ({ page }) => {
      await mockSignedOut(page);
    });

    for (const width of WIDTHS) {
      test(`AC1/AC4: no sideways scroll, square 64 px logo at ${width}`, async ({ page }) => {
        const m = await openAndMeasure(page, route.path, { width, height: 800 });
        expect(m.pageScrollsX, "page scrolls sideways").toBe(false);
        expect(m.mainClipsX, "the frame clips sideways").toBe(false);
        expect(m.topClipsX, "the logo row clips sideways").toBe(false);
        expect(m.logo).toEqual({ width: 64, height: 64 });
      });
    }

    for (const width of FORM_WIDTHS) {
      test(`AC2: the form is at least 360 px wide at ${width}`, async ({ page }) => {
        const m = await openAndMeasure(page, route.path, { width, height: 800 });
        expect(m.formWidth).toBeGreaterThanOrEqual(360);
      });
    }

    for (const size of FITS) {
      test(`AC3: no vertical scroll at ${size.width} x ${size.height}`, async ({ page }) => {
        const m = await openAndMeasure(page, route.path, size);
        expect(m.pageScrollsY, `needs ${m.neededHeight}px of ${size.height}px`).toBe(false);
      });
    }

    for (const size of TOWER) {
      test(`AC5: the tower stays off the form at ${size.width}`, async ({ page }) => {
        const m = await openAndMeasure(page, route.path, size);
        expect(m.towerOverlaps).toEqual([]);
      });
    }
  });
}
