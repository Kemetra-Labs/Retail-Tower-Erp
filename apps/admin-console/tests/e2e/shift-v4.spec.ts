/**
 * RT-1015 — the Shifts v4.0 surface in a real layout, against mocked Backend-Core.
 *
 * List: the Ink band keeps within 132px at 1280 with its facts and a very long
 * Arabic tenant name, nothing widens the page at 390, the formula strip is
 * there, and axe passes. Detail: the time bar and the receipt card render with
 * their text, no page overflow at 390, axe passes, and under forced colours the
 * Ink surfaces fall back to system colours.
 *
 * Set `SHIFT_CAPTURE_DIR` to also write the C2/C4 captures (1280x800 and 390
 * wide, light theme) for the PR.
 */
import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

const DUBAI = "0190f000-0000-7000-8000-0000000000a1";
const SHIFT_1 = "0190f000-0000-7000-8000-0000000000b1";
const USER = "0190f000-0000-7000-8000-0000000000c1";
const LONG_TENANT = "مؤسسة النيل الكبرى للتجزئة والتوزيع والخدمات اللوجستية والتجارة الإلكترونية";
const CAPTURE_DIR = process.env.SHIFT_CAPTURE_DIR;

function ctx(tenantName: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: tenantName },
    active_store: null,
    active_role_code: "owner",
    memberships: [{ tenant_id: "t1", tenant_name: tenantName, role_code: "owner" }],
  };
}

const store = {
  id: DUBAI,
  tenant_id: "t1",
  code: "DXB",
  name: "Dubai Mall",
  timezone: "Asia/Dubai",
  is_active: true,
};

function row(over: Record<string, unknown> = {}) {
  return {
    shiftId: SHIFT_1,
    storeId: DUBAI,
    currencyCode: "EGP",
    closedAt: "2026-10-07T20:30:00Z",
    closeKind: "forced",
    forcedReason: "الكاشير غادر دون إقفال الوردية",
    closingUserId: USER,
    varianceApprovedByUserId: null,
    openingFloat: "1000.0000",
    cashSalesTotal: "3450.0000",
    cashRefundsTotal: "120.0000",
    payInTotal: "150.0000",
    payOutTotal: "500.0000",
    expectedCash: "3980.0000",
    countedCash: "3620.0000",
    variance: "-360.0000",
    saleCount: 64,
    receivedAt: "2026-10-07T20:31:12Z",
    ...over,
  };
}

const detail = {
  ...row(),
  openedAt: "2026-10-07T08:05:00Z",
  openingUserId: USER,
  recordedByUserId: USER,
  cashRefundReturnRefs: ["RET-0001", "RET-0002"],
  cashMovements: [
    {
      movementId: "0190f000-0000-7000-8000-0000000000d1",
      kind: "pay_out",
      amount: "500.0000",
      reasonCode: "bank_drop",
      note: null,
      occurredAt: "2026-10-07T12:00:00Z",
      recordedByUserId: USER,
      receivedAt: "2026-10-07T12:00:05Z",
    },
  ],
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mock(page: Page, tenantName = "Northstar Retail"): Promise<void> {
  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(tenantName))));
  await page.route("**/api/v1/stores", (r) => r.fulfill(json([store])));
  await page.route(`**/api/v1/stores/${DUBAI}`, (r) => r.fulfill(json(store)));
  await page.route("**/api/v1/shift-closes?**", (r) =>
    r.fulfill(
      json({
        items: [
          row(),
          row({ shiftId: `${SHIFT_1.slice(0, -1)}2`, closeKind: "normal", variance: "20.0000" }),
        ],
        nextCursor: "next",
      }),
    ),
  );
  await page.route(`**/api/v1/shift-closes/${SHIFT_1}`, (r) => r.fulfill(json(detail)));
}

async function capture(page: Page, name: string, appLocale: string): Promise<void> {
  if (!CAPTURE_DIR) return;
  await page.screenshot({ path: `${CAPTURE_DIR}/${name}-${appLocale}.png`, fullPage: true });
}

const LIST_URL = `/shift-closes?store=${DUBAI}&from=2026-10-01&to=2026-10-07&min=10.00`;

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const width of [1280, 390]) {
  test(`list at ${width}: band, formula strip, table, no overflow, axe`, async ({
    page,
    t,
    appLocale,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    await page.goto(LIST_URL);
    await expect(
      page.getByRole("heading", { level: 1, name: t("shift.list.title") }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /Dubai Mall/ }).first()).toBeVisible();
    await expect(page.getByRole("img", { name: t("shift.formula.aria") })).toBeVisible();
    await expect(page.locator("dl.list-band__facts")).toHaveAttribute(
      "aria-label",
      t("shift.band.label"),
    );
    if (width >= 1200) {
      const band = await page.locator(".list-band").boundingBox();
      expect(band?.height ?? 999).toBeLessThanOrEqual(132);
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, `shift list ${width}`);
    await capture(page, `shifts-list-${width}`, appLocale);
  });

  test(`detail at ${width}: time bar, receipt card, no overflow, axe`, async ({
    page,
    t,
    appLocale,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    await page.goto(`/shift-closes/${SHIFT_1}`);
    await expect(
      page.getByRole("heading", { level: 1, name: t("shift.detail.title") }),
    ).toBeVisible();
    await expect(page.locator(".shift-timebar__track")).toBeVisible();
    await expect(page.getByRole("region", { name: t("shift.detail.section.cash") })).toBeVisible();
    await expect(page.getByText("-360.00 EGP")).toBeVisible();
    await expect(page.getByText(t("shift.timebar.duration"))).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, `shift detail ${width}`);
    await capture(page, `shift-detail-${width}`, appLocale);
  });
}

for (const width of [1280, 390]) {
  test(`a very long Arabic tenant name at ${width} keeps the band and the page in bounds`, async ({
    page,
    t,
    appLocale,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page, LONG_TENANT);
    await page.goto(LIST_URL);
    await expect(
      page.getByRole("heading", { level: 1, name: t("shift.list.title") }),
    ).toBeVisible();
    if (width >= 1200) {
      const band = await page.locator(".list-band").boundingBox();
      expect(band?.height ?? 999).toBeLessThanOrEqual(132);
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, `shifts-list-long-tenant-${width}`, appLocale);
  });

  test(`a failed load puts a banner under the band at ${width}, and the band states no scope`, async ({
    page,
    t,
    appLocale,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    await page.route("**/api/v1/shift-closes?**", (r) =>
      r.fulfill(json({ error: { code: "system_failure", message: "x" } }, 500)),
    );
    await page.goto(LIST_URL);
    await expect(page.getByText(t("shift.list.loadFailed"))).toBeVisible();
    await expect(page.locator("dl.list-band__facts")).toHaveCount(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, `shift list banner ${width}`);
    await capture(page, `shifts-list-banner-${width}`, appLocale);
  });

  test(`a dense page of 25 closes at ${width} stays in bounds`, async ({ page, appLocale }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    const items = Array.from({ length: 25 }, (_, i) =>
      row({
        shiftId: `0190f000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
        closeKind: i % 4 === 0 ? "forced" : "normal",
        variance: i % 2 === 0 ? "-12.5000" : "7.2500",
      }),
    );
    await page.route("**/api/v1/shift-closes?**", (r) =>
      r.fulfill(json({ items, nextCursor: "next" })),
    );
    await page.goto(LIST_URL);
    await expect(page.getByRole("row", { name: /Dubai Mall/ })).toHaveCount(25);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page, `shift list dense ${width}`);
    await capture(page, `shifts-list-dense-${width}`, appLocale);
  });
}

test("forced colours: the time bar and the formula icon map to system colours", async ({
  page,
  t,
  appLocale,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ forcedColors: "active" });
  await mock(page);
  await page.goto(`/shift-closes/${SHIFT_1}`);
  await expect(
    page.getByRole("heading", { level: 1, name: t("shift.detail.title") }),
  ).toBeVisible();
  const ink = "rgb(10, 33, 37)";
  const bar = page.locator(".shift-timebar");
  await expect(bar).toBeVisible();
  const style = await bar.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, image: s.backgroundImage };
  });
  expect(style.bg).not.toBe(ink);
  expect(style.image).toBe("none");
  await capture(page, "shift-detail-forced-colors-1280", appLocale);
  await page.goto(LIST_URL);
  await expect(page.getByRole("img", { name: t("shift.formula.aria") })).toBeVisible();
  const icon = await page
    .locator(".shift-formula__icon")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(icon).not.toBe(ink);
  await capture(page, "shifts-list-forced-colors-1280", appLocale);
});
