import { expectNoAxeViolations } from "./axe";
import { type LocaleFixtures, type Page, expect, test } from "./fixtures";
import { openUserMenu } from "./user-menu";

/**
 * RT-807 (PW-1, PW-4): the «حسابي» page, reached from the user menu, changes
 * the password through `changePassword` (RT-937). Mocked DP2 (C-5). The body
 * carries exactly the two contract fields, never the confirm value, and no
 * password reaches a URL.
 */

const context = {
  user: { id: "u1", email: "hala@nile-retail.example", display_name: "Hala Mansour" },
  active_tenant: { id: "t1", name: "Nile Retail" },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [{ tenant_id: "t1", tenant_name: "Nile Retail", role_code: "tenant_admin" }],
};

async function mockApi(page: Page, changeStatus: number): Promise<{ bodies: unknown[] }> {
  const seen = { bodies: [] as unknown[] };
  await page.route("**/api/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(context) }),
  );
  await page.route("**/api/v1/auth/password/change", (r) => {
    seen.bodies.push(r.request().postDataJSON());
    return r.fulfill({ status: changeStatus });
  });
  return seen;
}

async function fill(page: Page, t: LocaleFixtures["t"], next: string, confirm: string) {
  await page.getByLabel(t("auth.account.current.label"), { exact: true }).fill("old-secret");
  await page.getByLabel(t("auth.account.new.label"), { exact: true }).fill(next);
  await page.getByLabel(t("auth.account.confirm.label"), { exact: true }).fill(confirm);
}

test("user menu → «حسابي»; a mismatch sends nothing; a change says other sessions ended", async ({
  page,
  t,
}) => {
  const seen = await mockApi(page, 204);
  await page.goto("/");
  await openUserMenu(page);
  await page.getByRole("link", { name: t("shell.userMenu.account") }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { level: 1, name: t("auth.account.title") }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "account page");

  await fill(page, t, "new-secret-1", "new-secret-2");
  await page.getByRole("button", { name: t("auth.account.submit") }).click();
  await expect(page.getByText(t("auth.account.errors.mismatch")).first()).toBeVisible();
  expect(seen.bodies).toHaveLength(0);

  await fill(page, t, "new-secret-1", "new-secret-1");
  await page.getByRole("button", { name: t("auth.account.submit") }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t("auth.account.changed.body") }),
  ).toBeVisible();
  expect(seen.bodies).toEqual([{ current_password: "old-secret", new_password: "new-secret-1" }]);
  expect(page.url()).not.toContain("secret");
  await expectNoAxeViolations(page, "account page after a change");
});

test("400 is one generic refusal and clears the form", async ({ page, t }) => {
  await mockApi(page, 400);
  await page.goto("/account");
  await fill(page, t, "new-secret-1", "new-secret-1");
  await page.getByRole("button", { name: t("auth.account.submit") }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: t("auth.account.errors.refused.body") }),
  ).toBeVisible();
  await expect(page.getByLabel(t("auth.account.current.label"), { exact: true })).toHaveValue("");
  await expect(page.getByLabel(t("auth.account.current.label"), { exact: true })).toBeFocused();
});
