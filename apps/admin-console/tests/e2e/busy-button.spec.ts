import { type Page, expect, test } from "./fixtures";

/**
 * RT-959 (AC 2): the one busy pattern on a real form. While the create is in
 * flight the submit stays focused (aria-disabled, never native disabled),
 * announces busy, and another click or Enter sends nothing more.
 */
const context = {
  user: {
    id: "u1",
    email: "amal@northstar.eg",
    display_name: "Amal Saleh",
    is_platform_admin: true,
  },
  active_tenant: { id: "t1", name: "Northstar Retail" },
  active_store: null,
  active_role_code: "platform_admin",
  memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: "platform_admin" }],
};

async function mockBase(page: Page): Promise<void> {
  await page.route("**/api/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/v1/context/me", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(context) }),
  );
}

test("a pending submit keeps focus, is busy, and sends one request", async ({ page, t }) => {
  await mockBase(page);
  let posts = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/tenants", async (r) => {
    if (r.request().method() !== "POST") {
      return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    posts += 1;
    await held;
    return r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "conflict", request_id: "req-1" } }),
    });
  });

  await page.goto("/tenants/new");
  await page.getByLabel(t("tenants.field.slug"), { exact: true }).fill("acme");
  const name = page.getByLabel(t("tenants.field.name"), { exact: true });
  await name.fill("Acme Corp");
  const submit = page.getByRole("button", { name: t("tenants.form.create") });
  await submit.focus();
  await page.keyboard.press("Enter");

  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toHaveAttribute("aria-disabled", "true");
  await expect(submit).not.toHaveAttribute("disabled", /.*/);
  await expect(submit).toBeFocused();

  // Repeat activation while pending: a click, Enter on the button, Enter in a field.
  await submit.click({ force: true });
  await page.keyboard.press("Enter");
  await name.press("Enter");
  expect(posts).toBe(1);

  release();
  await expect(submit).not.toHaveAttribute("aria-busy", /.*/);
  expect(posts).toBe(1);
});

test("under forced colours a busy button stays apart from a disabled one", async ({ page, t }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await mockBase(page);
  await page.route("**/api/v1/tenants", async (r) => {
    if (r.request().method() !== "POST") {
      return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    await new Promise(() => {});
  });
  await page.goto("/tenants/new");
  await page.getByLabel(t("tenants.field.slug"), { exact: true }).fill("acme");
  await page.getByLabel(t("tenants.field.name"), { exact: true }).fill("Acme Corp");
  const submit = page.getByRole("button", { name: t("tenants.form.create") });
  await submit.click();
  await expect(submit).toHaveAttribute("aria-busy", "true");
  // GrayText marks unavailable; busy keeps the button's own system colour.
  const [busy, grayText] = await submit.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "GrayText";
    document.body.append(probe);
    const gray = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).color, gray];
  });
  expect(busy).not.toBe(grayText);
});
