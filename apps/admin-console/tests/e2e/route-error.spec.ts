import { expectNoAxeViolations } from "./axe";
import { LONG_TENANT, mockRealisticApi } from "./compact-shell-data";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-958: a page that throws renders its fallback inside the shell. The
 * sidebar, the top bar and the scope header stay; the scope does not change;
 * another page opens without a reload. The route error is forced with a
 * deliberately malformed body: `{}` for the payer-accounts page, whose contract
 * (PayerAccountPage) requires `items`. A contract-valid body renders the page.
 */

const PAYERS = "**/api/v1/settlement/payer-accounts**";

/** Marks the document, so a full reload (which drops the mark) is detectable. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __rt958: number }).__rt958 = 1;
  });
}

async function documentKept(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __rt958?: number }).__rt958 === 1);
}

test.beforeEach(async ({ page }) => {
  await mockRealisticApi(page);
  await page.route(PAYERS, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
});

test("a page error stays in the shell, keeps the scope, and another page opens without a reload", async ({
  page,
  t,
}) => {
  await page.goto("/");
  const scope = page.locator(".scope__btn");
  await expect(scope).toContainText(LONG_TENANT);
  const scopeBefore = await scope.innerText();
  await markDocument(page);

  const nav = page.getByRole("navigation", { name: t("shell.nav.label") });
  await nav.getByRole("link", { name: t("payers.nav.label") }).click();

  // The in-shell fallback: one h1, What → Safety → Action, no raw keys.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("app.routeError.title"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText(t("app.routeError.what"));
  await expect(alert).toContainText(t("app.crash.safety"));
  await expect(alert).toContainText(t("app.routeError.action"));
  await expect(alert).not.toContainText("app.");
  await expect(page.getByRole("button", { name: t("common.tryAgain") })).toBeVisible();
  await expect(page.getByRole("link", { name: t("app.routeError.toOverview") })).toBeVisible();
  // The root fallback did not take over the Console.
  await expect(page.getByRole("heading", { name: t("app.crash.title"), exact: true })).toHaveCount(
    0,
  );

  // The shell stays: navigation, top bar, and the unchanged scope.
  await expect(nav).toBeVisible();
  await expect(page.locator(".topbar")).toBeVisible();
  expect(await scope.innerText()).toBe(scopeBefore);
  await expectNoAxeViolations(page, "in-shell route error fallback");

  // Another page opens from the sidebar, in the same document.
  await nav.getByRole("link", { name: t("shell.nav.stores") }).click();
  await expect(
    page.getByRole("heading", { name: t("stores.list.title"), exact: true }),
  ).toBeVisible();
  await expect(page.getByText(t("app.routeError.title"))).toHaveCount(0);
  expect(await documentKept(page)).toBe(true);
  expect(await scope.innerText()).toBe(scopeBefore);
});

test("Go to Overview leaves the failed page without a reload", async ({ page, t }) => {
  await page.goto("/");
  await expect(page.locator(".scope__btn")).toContainText(LONG_TENANT);
  await markDocument(page);
  await page
    .getByRole("navigation", { name: t("shell.nav.label") })
    .getByRole("link", { name: t("payers.nav.label") })
    .click();
  await page.getByRole("link", { name: t("app.routeError.toOverview") }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(t("app.routeError.title"))).toHaveCount(0);
  expect(await documentKept(page)).toBe(true);
});
