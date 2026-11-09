import { expectNoAxeViolations } from "./axe";
import {
  CSP_WITHOUT_FRAME,
  CSP_WITH_FRAME,
  RELEASE,
  SECRET_MARK,
  SHA,
  context,
  cspViolations,
  envelope,
  mockDownloadPos,
  recordCspViolations,
} from "./download-pos-mock";
import { expect, test } from "./fixtures";

/**
 * RT-1304 E2E for the pilot Download POS page against a mocked Backend-Core and a stubbed S3
 * origin (RT-1302 spec AC 1-18). Runs in both locales; copy comes from the catalog (`t`).
 *   S1  opening makes no resolver call; one click makes exactly one.
 *   S2  an issued link: the ledger, copy SHA-256, then the Pairing codes link, by keyboard.
 *   S3  AC 9: an expired link (S3 answers 403 XML) is shown inside the hidden frame; the
 *       Console tab stays on the page and the signed URL never reaches the address bar.
 *   S4  without `frame-src` in the CSP the frame is refused, and the tab still does not move.
 *   S5  a role outside the device roles, and a support session, read «not available», no call.
 *   S6  429: the button waits out Retry-After and nothing retries.
 *   S7  axe in light and dark, desktop and 390 px; no sideways scroll and 44 px targets at 360 px.
 */

const PATH = "/devices/download-pos";

test("S1: opening makes no resolver call; one click makes exactly one", async ({ page, t }) => {
  const mocks = await mockDownloadPos(page, { delayMs: 400 });
  await page.goto(PATH);
  const action = page.getByRole("button", { name: t("devices.download.action") });
  await expect(action).toBeVisible();
  await page.reload();
  await page.waitForTimeout(300);
  expect(mocks.resolverCalls()).toBe(0);

  await action.dblclick();
  await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
  expect(mocks.resolverCalls()).toBe(1);
});

test("S2: an issued link shows the ledger; copy writes the hex; keyboard reaches Pairing codes", async ({
  page,
  t,
  context: browserContext,
}) => {
  await browserContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockDownloadPos(page);
  await page.goto(PATH);
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
  await expect(page.getByText(RELEASE.fileName)).toBeVisible();
  await expect(page.getByText("185.5 MB")).toBeVisible();
  await expect(page.getByText(RELEASE.expectedPublisher)).toBeVisible();

  await page.getByRole("button", { name: t("devices.download.copy") }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SHA);

  // Tab order: the primary action, then Copy SHA-256, then the Pairing codes link.
  await page.getByRole("button", { name: t("devices.download.action") }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: t("devices.download.copy") })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: t("devices.list.pairingCodes") })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/devices\/pairing-codes$/);
});

test("S3 (AC 9): an expired link renders inside the hidden frame; the tab never moves", async ({
  page,
  t,
}) => {
  await recordCspViolations(page);
  const mocks = await mockDownloadPos(page, { s3: "expired", csp: CSP_WITH_FRAME });
  const navigation = await page.goto(PATH);
  expect(navigation?.headers()["content-security-policy"]).toBe(CSP_WITH_FRAME);
  const historyBefore = await page.evaluate(() => history.length);

  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
  await expect.poll(() => mocks.s3Requests().length).toBe(1);

  expect(page.url()).toMatch(/\/devices\/download-pos$/);
  expect(page.url()).not.toContain(SECRET_MARK);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  expect(await page.evaluate(() => location.href)).not.toContain(SECRET_MARK);
  expect(await cspViolations(page)).toEqual([]);
  // The page is still usable: a new click is a new call and a new link.
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect.poll(() => mocks.resolverCalls()).toBe(2);
  expect(page.url()).not.toContain(SECRET_MARK);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(SECRET_MARK);
});

test("S3 (success): a good link starts the download without leaving the page", async ({
  page,
  t,
}) => {
  await mockDownloadPos(page, { s3: "attachment", csp: CSP_WITH_FRAME });
  await page.goto(PATH);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(RELEASE.fileName);
  expect(page.url()).toMatch(/\/devices\/download-pos$/);
});

test("S4: without frame-src the frame is refused by the CSP and the tab still does not move", async ({
  page,
  t,
}) => {
  await recordCspViolations(page);
  const mocks = await mockDownloadPos(page, { s3: "attachment", csp: CSP_WITHOUT_FRAME });
  await page.goto(PATH);
  await page.getByRole("button", { name: t("devices.download.action") }).click();
  await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
  await expect.poll(async () => (await cspViolations(page)).length).toBeGreaterThan(0);
  expect((await cspViolations(page)).map((v) => v.directive)).toContain("frame-src");
  expect(mocks.s3Requests()).toEqual([]);
  expect(page.url()).toMatch(/\/devices\/download-pos$/);
  expect(page.url()).not.toContain(SECRET_MARK);
});

test("S5 (AC 1, 17): a role outside the device roles and a support session read S5, no call", async ({
  page,
  t,
}) => {
  const staff = await mockDownloadPos(page, { role: "store_staff" });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.download.notAllowed"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("devices.download.action") })).toHaveCount(0);
  expect(staff.resolverCalls()).toBe(0);

  const inSession = await mockDownloadPos(page, {
    ctx: context("owner", {
      support_session: {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "t1",
        purpose: "incident",
        ticket_ref: "SUP-1",
        status: "active",
        expires_at: new Date(Date.now() + 40 * 60_000).toISOString(),
        renewal_cap_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      },
    }),
  });
  await page.goto(PATH);
  await expect(page.getByText(t("devices.download.notAllowed"))).toBeVisible();
  expect(inSession.resolverCalls()).toBe(0);
});

test("S6: a 429 disables the button for Retry-After; nothing retries on its own", async ({
  page,
  t,
}) => {
  const mocks = await mockDownloadPos(page, {
    latest: { status: 429, body: envelope("rate_limited"), headers: { "retry-after": "4" } },
  });
  await page.goto(PATH);
  const action = page.getByRole("button", { name: t("devices.download.action") });
  await action.click();
  await expect(page.getByRole("alert").filter({ hasText: /./ }).first()).toBeVisible();
  await expect(action).toBeDisabled();
  await page.waitForTimeout(1500);
  expect(mocks.resolverCalls()).toBe(1);
  await expect(action).toBeEnabled({ timeout: 8000 });
  expect(mocks.resolverCalls()).toBe(1);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`S7: axe, ${theme}, ${width}px: ready and issued states`, async ({ page, t }) => {
      await mockDownloadPos(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PATH);
      await page.evaluate((mode) => {
        if (mode === "dark") document.documentElement.setAttribute("data-theme", "dark");
        else document.documentElement.removeAttribute("data-theme");
      }, theme);
      await expect(page.getByRole("button", { name: t("devices.download.action") })).toBeVisible();
      await expectNoAxeViolations(page, `download-pos ready ${theme} ${width}`);
      await page.getByRole("button", { name: t("devices.download.action") }).click();
      await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
      await expectNoAxeViolations(page, `download-pos issued ${theme} ${width}`);
    });
  }
}

test("AC 14: at 360px there is no sideways scroll and the primary and copy targets are 44px", async ({
  page,
  t,
}) => {
  await mockDownloadPos(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(PATH);
  const primary = page.getByRole("button", { name: t("devices.download.action") });
  await primary.click();
  await expect(page.getByText(t("devices.download.issued"))).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  for (const target of [primary, page.getByRole("button", { name: t("devices.download.copy") })]) {
    const box = await target.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("AC 15: in forced colours the focus outline and the banner boundary stay visible", async ({
  page,
  t,
}) => {
  await mockDownloadPos(page, { latest: { status: 200, body: { available: false } } });
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(PATH);
  const primary = page.getByRole("button", { name: t("devices.download.action") });
  await primary.focus();
  const outline = await primary.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThan(0);
  await primary.click();
  const banner = page.getByText(t("devices.download.unavailable"));
  await expect(banner).toBeVisible();
  const border = await banner.evaluate((el) => {
    const box = el.closest("[role], .banner") ?? el;
    const s = getComputedStyle(box);
    return Number.parseFloat(s.borderTopWidth) + Number.parseFloat(s.borderInlineStartWidth);
  });
  expect(border).toBeGreaterThan(0);
});
