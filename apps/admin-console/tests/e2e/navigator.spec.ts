import { expectNoAxeViolations } from "./axe";
import { type Page, expect, test } from "./fixtures";

/**
 * RT-969 AC 3 — the Ctrl K navigator, on the built SPA in both locales. It
 * opens with Ctrl+K and with its visible button, filters the role's
 * destinations and the stores in scope, works by keyboard alone, returns focus
 * on close, and passes axe while open. A store choice switches scope through
 * the same server call as the switcher. Mocked DP2 (C-5).
 */

let activeStore: { id: string; name: string } | null = null;
let storeSwitches: string[] = [];

function ctx() {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: activeStore,
    active_role_code: "tenant_admin",
    memberships: [
      {
        tenant_id: "t1",
        tenant_name: "Northstar Retail",
        role_code: "tenant_admin",
        store_access_kind: "all",
      },
    ],
  };
}

const stores = [
  { id: "s1", code: "CFC", name: "Cairo Festival City", is_active: true },
  { id: "s2", code: "NCM", name: "New Cairo Mall", is_active: true },
];

async function mock(page: Page): Promise<void> {
  storeSwitches = [];
  await page.route("**/api/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ctx()) }),
  );
  await page.route("**/api/v1/stores", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stores) }),
  );
  await page.route("**/api/v1/context/store", (r) => {
    const body = r.request().postDataJSON() as { store_id: string };
    const s = stores.find((x) => x.id === body.store_id);
    activeStore = s ? { id: s.id, name: s.name } : null;
    storeSwitches.push(body.store_id);
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ctx()) });
  });
}

test.beforeEach(async ({ page }) => {
  activeStore = null;
  await mock(page);
});

test("Ctrl+K opens it, typing filters, Enter goes there, Escape returns focus", async ({
  page,
  t,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
  const trigger = page.getByRole("button", { name: new RegExp(t("shell.navigator.open")) });

  // Keyboard only: focus the trigger, then the shortcut opens the dialog.
  await trigger.focus();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
  await expect(dialog).toBeVisible();
  const combobox = dialog.getByRole("combobox", { name: t("shell.navigator.input") });
  await expect(combobox).toBeFocused();

  // Escape closes it and gives focus back.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Filter to one destination and open it with Enter.
  await page.keyboard.press("Control+K");
  await page.keyboard.type(t("shell.nav.audit"));
  await expect(dialog.getByRole("option")).toHaveText([t("shell.nav.audit")]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/audit$/);
  await expect(dialog).toBeHidden();
});

test("the visible button opens it; arrows move the active option", async ({ page, t }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(t("shell.navigator.open")) }).click();
  const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
  const combobox = dialog.getByRole("combobox");
  await expect(combobox).toBeFocused();
  const options = dialog.getByRole("option");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  const second = options.nth(1);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(combobox).toHaveAttribute(
    "aria-activedescendant",
    (await second.getAttribute("id")) ?? "",
  );
  // Tab cannot leave the dialog.
  await page.keyboard.press("Tab");
  await expect(combobox).toBeFocused();
});

test("it lists the stores in scope and switches to one through the server", async ({ page, t }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
  await page.keyboard.type("New Cairo");
  await expect(dialog.getByRole("option")).toHaveText(["New Cairo Mall"]);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => storeSwitches).toEqual(["s2"]);
  await expect(page.locator(".scope__btn")).toContainText("New Cairo Mall");
});

test("nothing matches: it says so", async ({ page, t }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
  await page.keyboard.press("Control+K");
  await page.keyboard.type("zzzz");
  const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(dialog.getByText(t("shell.navigator.empty", { query: "zzzz" }))).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`axe passes with the navigator open (${theme})`, async ({ page, t }) => {
    if (theme === "dark") {
      await page.addInitScript(() => {
        localStorage.setItem("rt.theme.v1:user:u1", "dark");
        localStorage.setItem("rt.theme.v1:last", "dark");
      });
    }
    await page.goto("/");
    await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
    await expect(dialog.getByRole("option", { name: "New Cairo Mall" })).toBeVisible();
    await expectNoAxeViolations(page, `navigator open, ${theme}`);
  });
}

test("a failed store list says so, offers a retry, and stays accessible", async ({ page, t }) => {
  let fail = true;
  await page.route("**/api/v1/stores", (r) =>
    fail
      ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stores) }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: t("shell.overview.title") })).toBeVisible();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: t("shell.navigator.title") });
  await expect(dialog.getByText(t("shell.scope.loadFailed"))).toBeVisible();
  await expectNoAxeViolations(page, "navigator, store list failed");
  // Keyboard only: Tab reaches the retry, Enter asks again.
  await page.keyboard.press("Tab");
  const retry = dialog.getByRole("button", { name: t("common.tryAgain") });
  await expect(retry).toBeFocused();
  fail = false;
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("option", { name: "New Cairo Mall" })).toBeVisible();
  await expect(dialog.getByText(t("shell.scope.loadFailed"))).toBeHidden();
});
